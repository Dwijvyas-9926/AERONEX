/*
  Every message type in the log, with every field: the raw data, for anyone
  who wants to check a number for themselves or take it elsewhere as CSV.
*/
import { Activity, Download, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { clock } from "../../logs/analyze";
import { baseName, saveFile, toCsv } from "../../logs/export";
import { isNumeric } from "../../logs/types";
import { useLogs } from "./store";

const PAGE = 200;

export function Messages() {
  const open = useLogs((s) => s.open)!;
  const custom = useLogs((s) => s.custom);
  const setCustom = useLogs((s) => s.setCustom);
  const cursor = useLogs((s) => s.cursor);
  const tables = useMemo(() => [...open.flight.raw.tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), [open]);
  const [sel, setSel] = useState(() => tables.find((t) => t.name === "ATT" || t.name === "ATTITUDE")?.name ?? tables[0]?.name ?? "");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const t = open.flight.raw.tables.get(sel);
  const list = tables.filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase()));
  // Start the rows at the shared cursor, when there is one.
  const startRow = useMemo(() => {
    if (!t || cursor === null) return 0;
    let r = 0;
    while (r < t.count && !(t.t[r] >= cursor)) r++;
    return Math.max(0, Math.min(t.count - 1, r));
  }, [t, cursor]);
  const from = Math.min(Math.max(0, startRow + page * PAGE), Math.max(0, (t?.count ?? 0) - 1));
  const rows = t ? Array.from({ length: Math.min(PAGE, t.count - from) }, (_, i) => from + i) : [];
  const s = open.flight.raw.stats;
  return (
    <div className="lp-msgs">
      <aside className="lp-msg-list">
        <label className="lp-search">
          <Search size={15} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${tables.length} message types`} aria-label="Find a message type" />
        </label>
        <ul>
          {list.map((x) => (
            <li key={x.name}>
              <button className={x.name === sel ? "on" : ""} onClick={() => {
                  setSel(x.name);
                  setPage(0);
                }}>
                <span>{x.name}</span>
                <small>{x.count.toLocaleString()}</small>
              </button>
            </li>
          ))}
        </ul>
        <p className="lp-fine">
          {s.messages.toLocaleString()} messages{s.skipped ? `; ${s.skipped.toLocaleString()} unreadable bytes stepped over` : ""}.
        </p>
      </aside>
      {t && (
        <section className="lp-msg-body">
          <div className="lp-chart-bar">
            <h2 className="lp-h2">
              {t.name} <small>{t.count.toLocaleString()} rows</small>
            </h2>
            <button className="btn" onClick={() => saveFile(`${baseName(open.name)} ${t.name}.csv`, toCsv(t), "text/csv")}>
              <Download size={15} /> CSV
            </button>
          </div>
          <div className="lp-pager">
            <button className="btn btn-ghost" disabled={from === 0} onClick={() => setPage((p) => p - 1)}>
              Earlier
            </button>
            <span>
              Rows {(from + 1).toLocaleString()}–{(from + rows.length).toLocaleString()}
              {cursor !== null && page === 0 ? `, from ${clock(cursor)}` : ""}
            </span>
            <button className="btn btn-ghost" disabled={from + rows.length >= t.count} onClick={() => setPage((p) => p + 1)}>
              Later
            </button>
          </div>
          <div className="lp-table-scroll">
            <table className="lp-table lp-raw">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  {t.fields.map((fname, i) => (
                    <th key={fname} scope="col" className={isNumeric(t.cols[i]) ? "num" : ""}>
                      <span>{fname}</span>
                      {(t.units[i] || t.scales[i]) && <small>{[t.units[i], t.scales[i]].filter(Boolean).join(" ")}</small>}
                      {isNumeric(t.cols[i]) && fname !== "TimeUS" && (
                        <button className="lp-th-chart" title={`Chart ${t.name}.${fname}`} aria-label={`Chart ${t.name}.${fname}`} onClick={() => {
                          const k = `${t.name}.${fname}`;
                          if (!custom.includes(k)) setCustom([...custom, k]);
                          useLogs.setState({ tab: "charts" });
                        }}>
                          <Activity size={12} />
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r}>
                    <td className="num">{Number.isFinite(t.t[r]) ? t.t[r].toFixed(3) : "—"}</td>
                    {t.cols.map((c, i) => (
                      <td key={i} className={isNumeric(c) ? "num" : ""}>
                        {isNumeric(c) ? fmtCell(c[r]) : c[r]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lp-fine">Numbers are as stored in the log. Where a unit carries a multiplier (×0.01 and so on), multiply by it to get that unit; the charts do it for you.</p>
        </section>
      )}
    </div>
  );
}

const fmtCell = (v: number) => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 1000 ? v.toFixed(2) : String(+v.toPrecision(7)));
