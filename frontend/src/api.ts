export interface SessionInfo {
  log: string | null;
  dbc: string | null;
  has_log: boolean;
  has_dbc: boolean;
  frame_count: number;
  t_start: number;
  t_end: number;
  duration: number;
}

export interface DbcSignal {
  name: string;
  unit: string;
  key: string;
}

export interface DbcMessage {
  name: string;
  frame_id: number;
  frame_id_hex: string;
  length?: number;
  ecu?: string;
  signals: DbcSignal[];
}

export interface DbcEcu {
  name: string;
  messages: DbcMessage[];
}

export interface SignalSeries {
  key: string;
  name: string;
  unit: string;
  timestamps: number[];
  values: number[];
}

export interface ValueAtTime {
  key: string;
  name: string;
  value: number | null;
  unit: string;
  timestamp?: number;
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

export async function fetchSession(): Promise<SessionInfo> {
  return parseJson(await fetch("/api/session"));
}

export async function uploadLog(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return parseJson(await fetch("/api/log", { method: "POST", body: fd }));
}

export async function uploadDbc(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return parseJson<{
    filename: string;
    ecus: DbcEcu[];
    messages: DbcMessage[];
  }>(await fetch("/api/dbc", { method: "POST", body: fd }));
}

export async function fetchViewport(
  keys: string[],
  tStart: number,
  tEnd: number,
  maxPoints = 2000
): Promise<{ series: SignalSeries[] }> {
  return parseJson(
    await fetch("/api/signals/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys,
        t_start: tStart,
        t_end: tEnd,
        max_points: maxPoints,
      }),
    })
  );
}

export async function fetchValuesAtTime(
  keys: string[],
  t: number
): Promise<{ t: number; values: ValueAtTime[] }> {
  const q = new URLSearchParams({
    keys: keys.join(","),
    t: String(t),
  });
  return parseJson(await fetch(`/api/signals/at-time?${q}`));
}
