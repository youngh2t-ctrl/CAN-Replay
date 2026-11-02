"""Virtual signal expressions on a zero-order-hold aligned timeline.

Expressions are parsed with ``ast`` and checked against a whitelist, then
evaluated by a vectorized tree walker (no ``eval``).
"""

from __future__ import annotations

import ast
import heapq
import math
from typing import Any, Callable, Sequence

NAN = float("nan")
MAX_EXPR_LEN = 500
MAX_MAVG_WINDOW = 100_000
TIME_VAR = "t"


class CalcError(ValueError):
    pass


def _is_nan(x: float) -> bool:
    return x != x


def _safe(fn: Callable[..., float]) -> Callable[..., float]:
    def wrapped(*args: float) -> float:
        for a in args:
            if _is_nan(a):
                return NAN
        try:
            r = fn(*args)
        except (ValueError, OverflowError, ZeroDivisionError, TypeError):
            return NAN
        if isinstance(r, complex) or math.isinf(r):
            return NAN
        return float(r)

    return wrapped


def _div(a: float, b: float) -> float:
    if b == 0:
        return NAN
    return a / b


def _mod(a: float, b: float) -> float:
    if b == 0:
        return NAN
    return a % b


def _truthy(a: float) -> bool:
    return a != 0


def _sign(a: float) -> float:
    return (a > 0) - (a < 0)


def _round(a: float, n: float = 0) -> float:
    return round(a, int(n))


def _clip(x: float, lo: float, hi: float) -> float:
    return min(max(x, lo), hi)


_BINOPS: dict[type, Callable[[float, float], float]] = {
    ast.Add: _safe(lambda a, b: a + b),
    ast.Sub: _safe(lambda a, b: a - b),
    ast.Mult: _safe(lambda a, b: a * b),
    ast.Div: _safe(_div),
    ast.Mod: _safe(_mod),
    ast.Pow: _safe(math.pow),
    ast.BitAnd: _safe(lambda a, b: 1.0 if _truthy(a) and _truthy(b) else 0.0),
    ast.BitOr: _safe(lambda a, b: 1.0 if _truthy(a) or _truthy(b) else 0.0),
}

_CMPOPS: dict[type, Callable[[float, float], float]] = {
    ast.Gt: _safe(lambda a, b: 1.0 if a > b else 0.0),
    ast.Lt: _safe(lambda a, b: 1.0 if a < b else 0.0),
    ast.GtE: _safe(lambda a, b: 1.0 if a >= b else 0.0),
    ast.LtE: _safe(lambda a, b: 1.0 if a <= b else 0.0),
    ast.Eq: _safe(lambda a, b: 1.0 if a == b else 0.0),
    ast.NotEq: _safe(lambda a, b: 1.0 if a != b else 0.0),
}

_UNARYOPS: dict[type, Callable[[float], float]] = {
    ast.USub: _safe(lambda a: -a),
    ast.UAdd: _safe(lambda a: a),
    ast.Not: _safe(lambda a: 0.0 if _truthy(a) else 1.0),
}

# name -> (callable, min_args, max_args)
_POINT_FUNCS: dict[str, tuple[Callable[..., float], int, int]] = {
    "abs": (_safe(abs), 1, 1),
    "sqrt": (_safe(math.sqrt), 1, 1),
    "exp": (_safe(math.exp), 1, 1),
    "log": (_safe(math.log), 1, 1),
    "log10": (_safe(math.log10), 1, 1),
    "floor": (_safe(math.floor), 1, 1),
    "ceil": (_safe(math.ceil), 1, 1),
    "sign": (_safe(_sign), 1, 1),
    "sin": (_safe(math.sin), 1, 1),
    "cos": (_safe(math.cos), 1, 1),
    "round": (_safe(_round), 1, 2),
    "pow": (_safe(math.pow), 2, 2),
    "min": (_safe(min), 2, 16),
    "max": (_safe(max), 2, 16),
    "clip": (_safe(_clip), 3, 3),
}

_SERIES_FUNCS = {"diff": (1, 1), "integ": (1, 1), "mavg": (2, 2), "where": (3, 3)}

FUNCTION_NAMES = sorted([*_POINT_FUNCS, *_SERIES_FUNCS])

_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.And,
    ast.Or,
    *_BINOPS.keys(),
    *_CMPOPS.keys(),
    *_UNARYOPS.keys(),
)


def compile_expression(expr: str, var_names: Sequence[str]) -> tuple[ast.Expression, set[str]]:
    """Parse and validate; returns the AST and the variables it references."""
    text = (expr or "").strip()
    if not text:
        raise CalcError("表达式为空")
    if len(text) > MAX_EXPR_LEN:
        raise CalcError(f"表达式过长（最多 {MAX_EXPR_LEN} 字符）")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise CalcError(f"表达式语法错误: {exc.msg}") from exc

    allowed_vars = set(var_names)
    used: set[str] = set()
    func_name_nodes = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise CalcError(f"不支持的语法: {type(node).__name__}")
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise CalcError("只支持数字常量")
        elif isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise CalcError("只能调用内置函数")
            fname = node.func.id
            if node.keywords:
                raise CalcError(f"函数 {fname} 不支持关键字参数")
            if fname in _POINT_FUNCS:
                _, lo, hi = _POINT_FUNCS[fname]
            elif fname in _SERIES_FUNCS:
                lo, hi = _SERIES_FUNCS[fname]
            else:
                raise CalcError(f"未知函数: {fname}（可用: {', '.join(FUNCTION_NAMES)}）")
            if not lo <= len(node.args) <= hi:
                raise CalcError(f"函数 {fname} 参数个数应为 {lo}" + (f"~{hi}" if hi != lo else ""))
            if fname == "mavg":
                win = node.args[1]
                if not (isinstance(win, ast.Constant) and isinstance(win.value, int) and 1 <= win.value <= MAX_MAVG_WINDOW):
                    raise CalcError(f"mavg 窗口必须是 1~{MAX_MAVG_WINDOW} 的整数常量")
        elif isinstance(node, ast.Name):
            if id(node) in func_name_nodes:
                continue
            if node.id in _POINT_FUNCS or node.id in _SERIES_FUNCS:
                raise CalcError(f"函数 {node.id} 需要带括号调用")
            if node.id == TIME_VAR:
                continue
            if node.id not in allowed_vars:
                raise CalcError(f"未定义的变量: {node.id}")
            used.add(node.id)

    if not used:
        raise CalcError("表达式至少要引用一个信号变量")
    return tree, used


def align_zoh(
    sources: Sequence[tuple[Sequence[float], Sequence[float]]],
) -> tuple[list[float], list[list[float]]]:
    """Merge timestamps of all sources and hold each source's last value.

    Only the interval where every source has data is kept.
    """
    if not sources or any(not ts for ts, _ in sources):
        return [], [[] for _ in sources]
    start = max(ts[0] for ts, _ in sources)
    end = min(ts[-1] for ts, _ in sources)
    if start > end:
        return [], [[] for _ in sources]

    union: list[float] = []
    last: float | None = None
    for t in heapq.merge(*(ts for ts, _ in sources)):
        if t < start or t > end or t == last:
            continue
        union.append(t)
        last = t

    aligned: list[list[float]] = []
    for ts, vs in sources:
        out: list[float] = []
        j = 0
        n = len(ts)
        for t in union:
            while j + 1 < n and ts[j + 1] <= t:
                j += 1
            out.append(float(vs[j]))
        aligned.append(out)
    return union, aligned


Value = float | list[float]


class _Evaluator:
    def __init__(self, env: dict[str, list[float]], ts: list[float]) -> None:
        self.env = env
        self.ts = ts
        self.n = len(ts)

    def _vec(self, x: Value) -> list[float]:
        return x if isinstance(x, list) else [x] * self.n

    def _map(self, fn: Callable[..., float], *args: Value) -> Value:
        if not any(isinstance(a, list) for a in args):
            return fn(*args)
        cols = [self._vec(a) for a in args]
        return [fn(*row) for row in zip(*cols)]

    def eval(self, node: ast.AST) -> Value:
        if isinstance(node, ast.Expression):
            return self.eval(node.body)
        if isinstance(node, ast.Constant):
            return float(node.value)
        if isinstance(node, ast.Name):
            return self.env[node.id]
        if isinstance(node, ast.BinOp):
            return self._map(_BINOPS[type(node.op)], self.eval(node.left), self.eval(node.right))
        if isinstance(node, ast.UnaryOp):
            return self._map(_UNARYOPS[type(node.op)], self.eval(node.operand))
        if isinstance(node, ast.BoolOp):
            op = _BINOPS[ast.BitAnd if isinstance(node.op, ast.And) else ast.BitOr]
            acc = self.eval(node.values[0])
            for v in node.values[1:]:
                acc = self._map(op, acc, self.eval(v))
            return acc
        if isinstance(node, ast.Compare):
            and_op = _BINOPS[ast.BitAnd]
            left = self.eval(node.left)
            acc: Value | None = None
            for op, comp in zip(node.ops, node.comparators):
                right = self.eval(comp)
                part = self._map(_CMPOPS[type(op)], left, right)
                acc = part if acc is None else self._map(and_op, acc, part)
                left = right
            assert acc is not None
            return acc
        if isinstance(node, ast.Call):
            return self._call(node)
        raise CalcError(f"不支持的语法: {type(node).__name__}")

    def _call(self, node: ast.Call) -> Value:
        fname = node.func.id  # type: ignore[attr-defined]
        if fname == "mavg":
            return self._mavg(self._vec(self.eval(node.args[0])), int(node.args[1].value))  # type: ignore[attr-defined]
        args = [self.eval(a) for a in node.args]
        if fname == "diff":
            return self._diff(self._vec(args[0]))
        if fname == "integ":
            return self._integ(self._vec(args[0]))
        if fname == "where":
            return self._map(_safe(lambda c, a, b: a if _truthy(c) else b), *args)
        fn, _, _ = _POINT_FUNCS[fname]
        return self._map(fn, *args)

    def _diff(self, xs: list[float]) -> list[float]:
        out = [NAN] * self.n
        for i in range(1, self.n):
            dt = self.ts[i] - self.ts[i - 1]
            a, b = xs[i - 1], xs[i]
            if dt > 0 and not _is_nan(a) and not _is_nan(b):
                out[i] = (b - a) / dt
        return out

    def _integ(self, xs: list[float]) -> list[float]:
        out = [NAN] * self.n
        acc = 0.0
        prev: float | None = None
        for i in range(self.n):
            x = xs[i]
            if _is_nan(x):
                out[i] = NAN
                continue
            if prev is not None and i > 0:
                acc += (prev + x) * 0.5 * (self.ts[i] - self.ts[i - 1])
            out[i] = acc
            prev = x
        return out

    def _mavg(self, xs: list[float], win: int) -> list[float]:
        out = [NAN] * self.n
        acc = 0.0
        count = 0
        for i in range(self.n):
            x = xs[i]
            if not _is_nan(x):
                acc += x
                count += 1
            if i >= win:
                old = xs[i - win]
                if not _is_nan(old):
                    acc -= old
                    count -= 1
            out[i] = acc / count if count else NAN
        return out


def evaluate(
    expr: str,
    variables: dict[str, tuple[Sequence[float], Sequence[float]]],
    t_base: float = 0.0,
) -> tuple[list[float], list[float]]:
    """Evaluate ``expr``; ``variables`` maps var name -> (timestamps, values)."""
    tree, used = compile_expression(expr, list(variables))
    names = sorted(used)
    ts, cols = align_zoh([variables[n] for n in names])
    if not ts:
        return [], []
    env: dict[str, list[float]] = dict(zip(names, cols))
    env[TIME_VAR] = [t - t_base for t in ts]
    result = _Evaluator(env, ts).eval(tree)
    vals = result if isinstance(result, list) else [float(result)] * len(ts)
    out_t: list[float] = []
    out_v: list[float] = []
    for t, v in zip(ts, vals):
        if _is_nan(v) or math.isinf(v):
            continue
        out_t.append(t)
        out_v.append(v)
    return out_t, out_v


def normalize_definition(raw: dict[str, Any], fallback_id: str) -> dict[str, Any]:
    """Validate a virtual-signal definition dict and return a clean copy."""
    if not isinstance(raw, dict):
        raise CalcError("定义格式错误")
    cid = str(raw.get("id") or fallback_id).strip()
    if not cid or ":" in cid:
        raise CalcError("非法的虚拟信号 id")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise CalcError("请填写虚拟信号名称")
    raw_vars = raw.get("vars") or {}
    if not isinstance(raw_vars, dict) or not raw_vars:
        raise CalcError("请至少选择一个参与计算的信号")
    vars_clean: dict[str, str] = {}
    for var, key in raw_vars.items():
        var_s = str(var).strip()
        key_s = str(key).strip()
        if not (len(var_s) == 1 and var_s.isascii() and var_s.isupper()):
            raise CalcError(f"变量名必须是单个大写字母: {var_s}")
        if not key_s or key_s.startswith("calc:"):
            raise CalcError(f"变量 {var_s} 只能引用 DBC 信号")
        vars_clean[var_s] = key_s
    expr = str(raw.get("expr") or "").strip()
    compile_expression(expr, list(vars_clean))
    return {
        "id": cid,
        "name": name,
        "expr": expr,
        "vars": vars_clean,
        "unit": str(raw.get("unit") or "").strip(),
    }
