import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { notify } from "../state/notifyStore";
import { desktop } from "./bridge";
import { checkForUpdates, restartToUpdate, useUpdates } from "./updates";

const BUSY_LINE =
  "Disconnect the aircraft to restart. AERONEX does not restart while a flight controller is connected or firmware is being installed.";

async function restart() {
  const r = await restartToUpdate();
  if (!r.ok && r.reason) notify("warn", "Not restarting yet", r.reason);
}

/** The card that appears once a new version has downloaded. Windows app only. */
export function UpdateNotice() {
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);
  const [notes, setNotes] = useState(false);
  if (
    !desktop ||
    !status ||
    status.state !== "ready" ||
    !status.version ||
    dismissed === status.version
  )
    return null;
  return (
    <aside
      className="update-notice"
      role="status"
      aria-labelledby="update-title"
    >
      <Download aria-hidden size={18} />
      <div>
        <strong id="update-title">AERONEX {status.version} is ready</strong>
        <p>
          {status.busy
            ? BUSY_LINE
            : "Restart to finish updating. Your aircraft, settings and logs stay as they are."}
        </p>
        {status.notes ? (
          <>
            <button
              className="link-btn"
              aria-expanded={notes}
              onClick={() => setNotes((v) => !v)}
            >
              {notes ? "Hide what's new" : "What's new"}
            </button>
            {notes ? <pre className="update-notes">{status.notes}</pre> : null}
          </>
        ) : null}
        <div className="update-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={status.busy}
            onClick={() => void restart()}
          >
            <RotateCcw size={14} /> Restart now
          </button>
          <button
            className="btn btn-sm"
            onClick={() => useUpdates.setState({ dismissed: status.version })}
          >
            Later
          </button>
        </div>
      </div>
    </aside>
  );
}

/** The Updates section of Settings. Windows app only. */
export function UpdatesSection() {
  const status = useUpdates((s) => s.status);
  const [asking, setAsking] = useState(false);
  if (!desktop) return null;
  const state = status?.state ?? "idle";

  const line = (() => {
    switch (state) {
      case "unsupported":
        return "This copy was not installed with the AERONEX installer, so it does not update itself.";
      case "checking":
        return "Looking for a new version…";
      case "none":
        return "This is the latest version.";
      case "downloading":
        return `Downloading AERONEX ${status?.version ?? ""}… ${status?.percent ?? 0}%`;
      case "ready":
        return status?.busy
          ? `AERONEX ${status.version} is ready. ${BUSY_LINE}`
          : `AERONEX ${status?.version} is ready. Restart to finish updating.`;
      case "error":
        return status?.error ?? "Looking for updates did not work this time.";
      default:
        return "AERONEX looks for a new version when it starts and every few hours, and downloads it in the background. It only installs when you restart, never while an aircraft is connected.";
    }
  })();

  return (
    <section className="panel" id="updates">
      <div className="panel-head">
        <h2 className="h3">Updates</h2>
      </div>
      <div className="setting">
        <div>
          <strong>Version {status?.current ?? ""}</strong>
          <p aria-live="polite">{line}</p>
        </div>
        {state === "ready" ? (
          <button
            className="btn btn-primary"
            disabled={status?.busy}
            onClick={() => void restart()}
          >
            <RotateCcw size={15} /> Restart to update
          </button>
        ) : (
          <button
            className="btn"
            disabled={
              asking ||
              state === "unsupported" ||
              state === "checking" ||
              state === "downloading"
            }
            onClick={async () => {
              setAsking(true);
              try {
                await checkForUpdates();
              } finally {
                setAsking(false);
              }
            }}
          >
            <RefreshCw size={15} /> Check for updates
          </button>
        )}
      </div>
    </section>
  );
}
