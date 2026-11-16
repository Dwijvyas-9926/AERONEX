/*
  Logs on the aircraft's SD card: list them over MAVLink, download one (into
  the library, then open it), or erase them all.
*/
import { HardDriveDownload, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { downloadAircraftLog, eraseAircraftLogs, listAircraftLogs, type AircraftLog, type DownloadProgress } from "../../services/link/logDownload";
import { useLink } from "../../state/linkStore";
import { bytes } from "./plotView";
import { useLogs } from "./store";

const eta = (p: DownloadProgress) => {
  if (p.rate <= 0) return "";
  const s = (p.size - p.received) / p.rate;
  return s > 90 ? `about ${Math.round(s / 60)} min left` : `${Math.max(1, Math.round(s))} s left`;
};

export function AircraftLogs() {
  const vehicle = useLink((s) => s.vehicle);
  const status = useLink((s) => s.status);
  const virtual = useLink((s) => s.virtual);
  const linked = !!vehicle && status === "connected";
  const [listed, setList] = useState<AircraftLog[] | null>(null);
  const list = linked ? listed : null;
  const [busy, setBusy] = useState<"list" | "erase" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dl, setDl] = useState<{ id: number; p: DownloadProgress } | null>(null);
  const [eraseAsk, setEraseAsk] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const openBytes = useLogs((s) => s.openBytes);

  // A list from an aircraft no longer linked is not shown; a download in progress stops.
  useEffect(() => {
    if (!linked) abort.current?.abort();
  }, [linked]);
  useEffect(() => () => abort.current?.abort(), []);

  const refresh = async () => {
    setBusy("list");
    setErr(null);
    try {
      setList(await listAircraftLogs());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async (l: AircraftLog) => {
    setErr(null);
    const ac = new AbortController();
    abort.current = ac;
    setDl({ id: l.id, p: { received: 0, size: l.size, rate: 0 } });
    try {
      const buf = await downloadAircraftLog(l, (p) => setDl({ id: l.id, p }), ac.signal);
      const when = l.timeUtc ? new Date(l.timeUtc * 1000) : null;
      const name = `Log ${l.id}${when ? ` ${when.toISOString().slice(0, 16).replace("T", " ").replace(":", "-")}` : ""}.bin`;
      setDl(null);
      await openBytes(buf, name, "aircraft", true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDl(null);
    }
  };

  const erase = async () => {
    setEraseAsk(false);
    setBusy("erase");
    setErr(null);
    try {
      await eraseAircraftLogs();
      // ArduPilot erases in the background; give it a moment before listing again.
      await new Promise((r) => setTimeout(r, 2500));
      setList(await listAircraftLogs());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="lp-ac">
      <h2 className="lp-h2">
        <HardDriveDownload size={16} /> Logs on the aircraft
      </h2>
      {!linked ? (
        <p className="lp-empty">Connect to the aircraft to list and download the logs on its SD card. Downloads need the aircraft disarmed; over a USB cable they are much faster than over a telemetry radio.</p>
      ) : virtual ? (
        <p className="lp-empty">The virtual aircraft has no SD card. Its flights are recorded as telemetry logs in the library below while it is linked.</p>
      ) : (
        <>
          <div className="lp-ac-bar">
            <button className="btn" onClick={() => void refresh()} disabled={!!busy || !!dl || vehicle?.armed}>
              <RefreshCw size={15} className={busy === "list" ? "spin" : ""} /> {list ? "List again" : "List logs"}
            </button>
            {list && list.length > 0 && !eraseAsk && (
              <button className="btn btn-ghost" onClick={() => setEraseAsk(true)} disabled={!!busy || !!dl || vehicle?.armed}>
                <Trash2 size={15} /> Erase all…
              </button>
            )}
            {eraseAsk && (
              <span className="lp-confirm">
                <span>Erase every log on the aircraft? This cannot be undone.</span>
                <button className="btn btn-danger" onClick={() => void erase()}>
                  Erase
                </button>
                <button className="btn btn-ghost" onClick={() => setEraseAsk(false)}>
                  Cancel
                </button>
              </span>
            )}
          </div>
          {vehicle?.armed && <p className="lp-empty">Disarm to download: ArduPilot only sends logs while disarmed.</p>}
          {err && <p className="lp-err" role="alert">{err}</p>}
          {list && !list.length && <p className="lp-empty">The aircraft has no logs on its card.</p>}
          {list && list.length > 0 && (
            <ul className="lp-ac-list">
              {[...list].reverse().map((l) => (
                <li key={l.id}>
                  <span className="lp-ac-id">Log {l.id}</span>
                  <span className="lp-ac-meta">
                    {l.timeUtc ? new Date(l.timeUtc * 1000).toLocaleString() : "time not known"} · {bytes(l.size)}
                  </span>
                  {dl?.id === l.id ? (
                    <span className="lp-ac-dl">
                      <span className="lp-bar">
                        <i style={{ width: `${(dl.p.received / Math.max(1, dl.p.size)) * 100}%` }} />
                      </span>
                      <span>
                        {Math.floor((dl.p.received / Math.max(1, dl.p.size)) * 100)}% {dl.p.rate > 0 ? `· ${bytes(dl.p.rate)}/s · ${eta(dl.p)}` : ""}
                      </span>
                      <button className="btn btn-ghost btn-icon" onClick={() => abort.current?.abort()} aria-label="Cancel download">
                        <X size={15} />
                      </button>
                    </span>
                  ) : (
                    <button className="btn" onClick={() => void download(l)} disabled={!!dl || !!busy || vehicle?.armed || l.size === 0}>
                      Download
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
