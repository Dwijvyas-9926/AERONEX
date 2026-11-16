import { Download, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { clock } from "../../logs/analyze";
import { baseName, fmtParam, saveFile, toParamFile } from "../../logs/export";
import { useLink } from "../../state/linkStore";
import { useParams } from "../../state/paramStore";
import { useLogs } from "./store";

type Filter = "all" | "default" | "changed" | "aircraft";

const same = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export function Params() {
  const open = useLogs((s) => s.open)!;
  const live = useParams((s) => s.values);
  const linked = useLink((s) => !!s.vehicle);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const f = open.flight;
  const all = useMemo(() => [...f.params.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), [f]);
  const hasDefaults = all.some((p) => p.default !== null);
  const haveLive = linked && Object.keys(live).length > 0;
  const rows = useMemo(() => {
    const words = q.trim().toUpperCase().split(/\s+/).filter(Boolean);
    return all.filter((p) => {
      if (!words.every((w) => p.name.includes(w))) return false;
      if (filter === "default") return p.default !== null && !same(p.last, p.default);
      if (filter === "changed") return p.changes.length > 0;
      if (filter === "aircraft") return p.name in live && !same(live[p.name], p.last);
      return true;
    });
  }, [all, q, filter, live]);
  const counts = {
    default: all.filter((p) => p.default !== null && !same(p.last, p.default)).length,
    changed: all.filter((p) => p.changes.length).length,
    aircraft: haveLive ? all.filter((p) => p.name in live && !same(live[p.name], p.last)).length : 0,
  };
  if (!all.length) return <p className="lp-empty">This log holds no parameters.{f.kind === "tlog" ? " A telemetry log only has the parameters the ground station downloaded during the session." : ""}</p>;
  return (
    <div className="lp-params">
      <div className="lp-chart-bar">
        <div className="lp-seg" role="radiogroup" aria-label="Show">
          <button role="radio" aria-checked={filter === "all"} className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All {all.length}</button>
          {hasDefaults && <button role="radio" aria-checked={filter === "default"} className={filter === "default" ? "on" : ""} onClick={() => setFilter("default")}>Not default {counts.default}</button>}
          <button role="radio" aria-checked={filter === "changed"} className={filter === "changed" ? "on" : ""} onClick={() => setFilter("changed")} disabled={!counts.changed}>Changed during the log {counts.changed}</button>
          {haveLive && <button role="radio" aria-checked={filter === "aircraft"} className={filter === "aircraft" ? "on" : ""} onClick={() => setFilter("aircraft")}>Differs from the aircraft now {counts.aircraft}</button>}
        </div>
        <label className="lp-search narrow">
          <Search size={15} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a parameter" aria-label="Find a parameter" />
        </label>
        <button className="btn" onClick={() => saveFile(`${baseName(open.name)}.param`, toParamFile(f))}>
          <Download size={15} /> Save as .param
        </button>
      </div>
      {f.kind === "tlog" && <p className="lp-fine">A telemetry log only has the parameters the ground station downloaded during the session ({all.length} here).</p>}
      <table className="lp-table">
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col" className="num">In the log</th>
            {hasDefaults && <th scope="col" className="num">Default</th>}
            {haveLive && <th scope="col" className="num">On the aircraft now</th>}
            <th scope="col">Changes during the log</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const notDefault = p.default !== null && !same(p.last, p.default);
            const lv = live[p.name];
            const differs = haveLive && lv !== undefined && !same(lv, p.last);
            return (
              <tr key={p.name}>
                <th scope="row" className="mono">{p.name}</th>
                <td className={`num ${notDefault ? "lp-strong" : ""}`}>{fmtParam(p.last)}</td>
                {hasDefaults && <td className="num lp-dim">{p.default === null ? "—" : fmtParam(p.default)}</td>}
                {haveLive && <td className={`num ${differs ? "lp-strong" : "lp-dim"}`}>{lv === undefined ? "—" : fmtParam(lv)}</td>}
                <td className="lp-dim">{p.changes.length ? [`${fmtParam(p.value)}`, ...p.changes.map((c) => `${fmtParam(c.value)} at ${clock(c.t)}`)].join(" → ") : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="lp-empty">Nothing matches.</p>}
    </div>
  );
}
