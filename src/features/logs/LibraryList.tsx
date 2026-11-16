import { CircleCheck, Cpu, FileText, HardDriveDownload, Radio, Trash2, TriangleAlert, OctagonAlert } from "lucide-react";
import { useState } from "react";
import { clock } from "../../logs/analyze";
import { libraryAvailable, LIBRARY_CAP, type LogRecord } from "../../logs/library";
import { bytes } from "./plotView";
import { useLogs } from "./store";

const SOURCE: Record<LogRecord["source"], { label: string; Icon: typeof Radio }> = {
  recorded: { label: "Recorded by AERONEX", Icon: Radio },
  aircraft: { label: "Downloaded from the aircraft", Icon: HardDriveDownload },
  file: { label: "Opened from a file", Icon: FileText },
};


export function LibraryList() {
  const library = useLogs((s) => s.library);
  const err = useLogs((s) => s.libraryError);
  const openFromLibrary = useLogs((s) => s.openFromLibrary);
  const remove = useLogs((s) => s.remove);
  const [confirm, setConfirm] = useState<string | null>(null);

  if (!libraryAvailable()) return <p className="lp-empty">This browser cannot keep logs between visits. Logs still open normally.</p>;
  if (err) return <p className="lp-empty">The log library could not be opened: {err}</p>;
  if (!library.length)
    return (
      <p className="lp-empty">
        No logs kept yet. Every time AERONEX is linked to an aircraft (or the virtual aircraft) it records a telemetry log here; logs you open or download are kept here too. Turn recording off in Settings.
      </p>
    );
  const used = library.reduce((s, r) => s + r.size, 0);
  return (
    <>
      <ul className="lp-lib">
        {library.map((r) => {
          const { Icon, label } = SOURCE[r.source];
          const v = r.summary?.verdict;
          return (
            <li key={r.id} className="lp-lib-row">
              <button className="lp-lib-open" onClick={() => void openFromLibrary(r.id)} disabled={r.state === "recording" && r.size === 0}>
                <span className="lp-lib-ic" title={label}>
                  <Icon size={16} />
                </span>
                <span className="lp-lib-main">
                  <span className="lp-lib-name">{r.name}</span>
                  <span className="lp-lib-meta">
                    {new Date(r.addedAt).toLocaleString()} · {bytes(r.size)}
                    {r.summary && r.summary.flightTime > 0 ? ` · ${clock(r.summary.flightTime)} in the air` : r.summary ? " · did not fly" : ""}
                    {r.summary?.firmware ? ` · ${r.summary.firmware}` : ""}
                    {r.state === "recording" && " · recording now"}
                    {r.state === "interrupted" && " · recording was interrupted"}
                  </span>
                </span>
                {v && (
                  <span className={`lp-verdict-chip ${v}`}>
                    {v === "fail" ? <OctagonAlert size={13} /> : v === "warn" ? <TriangleAlert size={13} /> : <CircleCheck size={13} />}
                    {v === "fail" ? `${r.summary!.fails} problem${r.summary!.fails === 1 ? "" : "s"}` : v === "warn" ? `${r.summary!.warns} to check` : "No problems"}
                  </span>
                )}
                {!v && r.state !== "recording" && (
                  <span className="lp-verdict-chip none">
                    <Cpu size={13} /> Not checked yet
                  </span>
                )}
              </button>
              {confirm === r.id ? (
                <span className="lp-confirm">
                  <button className="btn btn-danger" onClick={() => void remove(r.id).then(() => setConfirm(null))}>
                    Delete
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button className="btn btn-ghost btn-icon" onClick={() => setConfirm(r.id)} aria-label={`Delete ${r.name}`} disabled={r.state === "recording"} title={r.state === "recording" ? "Still recording" : "Delete from the library"}>
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="lp-lib-foot">
        {library.length} log{library.length === 1 ? "" : "s"}, {bytes(used)} of {bytes(LIBRARY_CAP)}. Past that the oldest recordings are removed first. Reset app data in Settings deletes them all.
      </p>
    </>
  );
}
