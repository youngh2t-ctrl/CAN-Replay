import { useMemo, useState } from "react";
import type { DbcEcu } from "../api";

interface Props {
  ecus: DbcEcu[];
  selected: Set<string>;
  onToggle: (key: string, on: boolean) => void;
  disabled?: boolean;
}

function msgKey(ecu: string, frameId: number) {
  return `${ecu}|${frameId}`;
}

export default function SignalTree({
  ecus,
  selected,
  onToggle,
  disabled,
}: Props) {
  const [filter, setFilter] = useState("");
  const [collapsedEcu, setCollapsedEcu] = useState<Set<string>>(() => new Set());
  const [collapsedMsg, setCollapsedMsg] = useState<Set<string>>(() => new Set());

  const q = filter.trim().toLowerCase();

  const filteredEcus = useMemo(() => {
    if (!q) return ecus;
    return ecus
      .map((ecu) => ({
        ...ecu,
        messages: ecu.messages
          .map((m) => ({
            ...m,
            signals: m.signals.filter(
              (s) =>
                s.name.toLowerCase().includes(q) ||
                m.name.toLowerCase().includes(q) ||
                m.frame_id_hex.toLowerCase().includes(q) ||
                ecu.name.toLowerCase().includes(q)
            ),
          }))
          .filter(
            (m) =>
              m.signals.length > 0 ||
              m.name.toLowerCase().includes(q) ||
              m.frame_id_hex.toLowerCase().includes(q)
          ),
      }))
      .filter(
        (ecu) =>
          ecu.messages.length > 0 || ecu.name.toLowerCase().includes(q)
      );
  }, [ecus, q]);

  const toggleEcu = (name: string) => {
    setCollapsedEcu((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleMsg = (key: string) => {
    setCollapsedMsg((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandForKey = (key: string) => {
    for (const ecu of ecus) {
      for (const m of ecu.messages) {
        if (m.signals.some((s) => s.key === key)) {
          setCollapsedEcu((p) => {
            const n = new Set(p);
            n.delete(ecu.name);
            return n;
          });
          setCollapsedMsg((p) => {
            const n = new Set(p);
            n.delete(msgKey(ecu.name, m.frame_id));
            return n;
          });
          return;
        }
      }
    }
  };

  if (!ecus.length) {
    return <div className="empty-hint">加载 DBC 后展开 ECU / 报文选择信号</div>;
  }

  return (
    <>
      <div className="sidebar-header">
        信号树（ECU → 报文）
        <input
          type="search"
          placeholder="搜索..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="signal-tree">
        {filteredEcus.map((ecu) => {
          const ecuOpen = q ? true : !collapsedEcu.has(ecu.name);
          const hasSel = ecu.messages.some((m) =>
            m.signals.some((s) => selected.has(s.key))
          );
          return (
            <div key={ecu.name} className="msg-block">
              <div className="msg-title" onClick={() => toggleEcu(ecu.name)}>
                {ecuOpen ? "▼" : "▶"} {ecu.name}
                {hasSel ? " ●" : ""}
              </div>
              {ecuOpen &&
                ecu.messages.map((m) => {
                  const mk = msgKey(ecu.name, m.frame_id);
                  const mOpen = q ? true : !collapsedMsg.has(mk);
                  return (
                    <div key={mk}>
                      <div
                        className="msg-title"
                        style={{ paddingLeft: 16 }}
                        onClick={() => toggleMsg(mk)}
                      >
                        {mOpen ? "▼" : "▶"} {m.name} ({m.frame_id_hex})
                      </div>
                      {mOpen &&
                        m.signals.map((s) => (
                          <label key={s.key} className="signal-item">
                            <input
                              type="checkbox"
                              checked={selected.has(s.key)}
                              disabled={disabled}
                              onChange={(e) => {
                                if (e.target.checked) expandForKey(s.key);
                                onToggle(s.key, e.target.checked);
                              }}
                            />
                            {s.name}
                            {s.unit ? ` [${s.unit}]` : ""}
                          </label>
                        ))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </>
  );
}
