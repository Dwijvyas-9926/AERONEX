import { Activity, Play, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { clock } from "../../logs/analyze";
import type { TimelineItem } from "../../logs/model";
import { useLogs } from "./store";

const KINDS: { id: TimelineItem["kind"]; label: string }[] = [
  { id: "error", label: "Errors" },
  { id: "mode", label: "Modes" },
  { id: "arm", label: "Arming" },
  { id: "event", label: "Events" },
  { id: "message", label: "Messages" },
];

const KIND_LABEL: Record<TimelineItem["kind"], string> = { error: "Error", mode: "Mode", arm: "Arming", event: "Event", message: "Message" };

export function Timeline() {
  const open = useLogs((s) => s.open)!;
  const focus = useLogs((s) => s.focus);
  const [on, setOn] = useState<Set<TimelineItem["kind"]>>(() => new Set(KINDS.map((k) => k.id)));
  const [q, setQ] = useState("");
  const items = open.flight.timeline;
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => on.has(it.kind) && words.every((w) => it.text.toLowerCase().includes(w)));
  }, [items, on, q]);
  const count = (k: TimelineItem["kind"]) => items.filter((i) => i.kind === k).length;
  return (
    <div className="lp-timeline">
      <div className="lp-chart-bar">
        <div className="lp-filters" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <label key={k.id} className={`lp-filter ${on.has(k.id) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={on.has(k.id)}
                onChange={() => {
                  const n = new Set(on);
                  if (n.has(k.id)) n.delete(k.id);
                  else n.add(k.id);
                  setOn(n);
                }}
              />
              {k.label} <small>{count(k.id)}</small>
            </label>
          ))}
        </div>
        <label className="lp-search narrow">
          <Search size={15} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter events" />
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="lp-empty">Nothing matches.</p>
      ) : (
        <table className="lp-table lp-events">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Kind</th>
              <th scope="col">What happened</th>
              <th scope="col"><span className="sr-only">Show</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 3000).map((it, k) => (
              <tr key={k} className={it.tone}>
                <td className="num">{clock(it.t)}<small>.{String(Math.floor((it.t % 1) * 10))}</small></td>
                <td>{KIND_LABEL[it.kind]}</td>
                <td>{it.text}</td>
                <td className="lp-row-actions">
                  <button className="btn btn-ghost btn-icon" onClick={() => focus(it.t, 30, "charts")} aria-label={`Show ${clock(it.t)} on the charts`} title="Show on the charts">
                    <Activity size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon" onClick={() => focus(Math.max(0, it.t - 3), undefined, "replay")} aria-label={`Replay from ${clock(it.t)}`} title="Replay from here">
                    <Play size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown.length > 3000 && <p className="lp-fine">Showing the first 3,000 of {shown.length.toLocaleString()}. Filter to narrow it down.</p>}
    </div>
  );
}
