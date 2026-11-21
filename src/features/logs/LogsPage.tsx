/*
  Flight Logs: open a DataFlash .bin or a .tlog (dropped, picked, recorded by
  AERONEX, or downloaded from the aircraft), see what the checks found, chart
  anything in it, replay it in the 3D world, and read every event, message
  and parameter. Logs are read in this browser and never uploaded.
*/
import { Activity, CircleAlert, FileUp, FolderOpen, Gauge, Library, ListTree, MessageSquareText, Play, ScrollText, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clock } from "../../logs/analyze";
import { libraryAvailable } from "../../logs/library";
import { AircraftLogs } from "./AircraftLogs";
import { Charts } from "./Charts";
import { ExportMenu } from "./ExportMenu";
import { LibraryList } from "./LibraryList";
import { Params } from "./Params";
import { Replay } from "./Replay";
import { Report } from "./Report";
import { useLogs, type LogTab } from "./store";
import { Timeline } from "./Timeline";
import { Messages } from "./Messages";
import "./logs.css";
import { DESKTOP } from "../../desktop/wording";

const TABS: { id: LogTab; label: string; Icon: typeof Activity }[] = [
  { id: "report", label: "Report", Icon: Gauge },
  { id: "charts", label: "Charts", Icon: Activity },
  { id: "replay", label: "Replay", Icon: Play },
  { id: "events", label: "Events", Icon: ListTree },
  { id: "params", label: "Parameters", Icon: SlidersHorizontal },
  { id: "messages", label: "All data", Icon: MessageSquareText },
];

const ACCEPT = ".bin,.BIN,.log,.tlog";

export function LogsPage() {
  const open = useLogs((s) => s.open);
  const loading = useLogs((s) => s.loading);
  const error = useLogs((s) => s.error);
  const tab = useLogs((s) => s.tab);
  const setTab = useLogs((s) => s.setTab);
  const close = useLogs((s) => s.close);
  const refresh = useLogs((s) => s.refresh);
  const openFile = useLogs((s) => s.openFile);
  const [keep, setKeep] = useState(true);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void openFile(f, keep && libraryAvailable());
  };

  // Drop a log anywhere on the page.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      onFiles(e.dataTransfer.files);
    },
  };

  const picker = <input ref={pick} type="file" accept={ACCEPT} hidden onChange={(e) => {
        onFiles(e.target.files);
        e.target.value = "";
      }} />;

  if (!open) {
    return (
      <div className={`page-pad lp ${over ? "lp-over" : ""}`} {...dropProps}>
        {picker}
        <header className="page-head">
          <div>
            <h1>Flight Logs</h1>
            <p>Open a flight log to see what the aircraft went through: what went wrong and why, every reading on a chart, and the flight replayed in 3D. Logs are read on this computer and never uploaded.</p>
          </div>
        </header>
        {(loading || error) && <Status />}
        <div className="lp-start">
          <section className="lp-drop" onClick={() => pick.current?.click()} aria-label="Open a log file">
            <FileUp size={30} strokeWidth={1.6} />
            <h2>Drop a log here, or choose a file</h2>
            <p>
              <strong>.bin</strong> DataFlash logs from the aircraft's SD card or a download, and <strong>.tlog</strong> telemetry logs from Mission Planner, QGroundControl, MAVProxy or AERONEX.
            </p>
            {/* The whole area takes a click or a drop; this is the control a keyboard reaches. */}
            <button
              type="button"
              className="btn btn-primary"
              onClick={(e) => {
                e.stopPropagation();
                pick.current?.click();
              }}
            >
              <FolderOpen size={15} /> Choose a log
            </button>
            {libraryAvailable() && (
              <label className="lp-keep" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep a copy in {DESKTOP ? "the log library on this computer" : "this browser's log library"}
              </label>
            )}
          </section>
          <AircraftLogs />
        </div>
        <section className="lp-lib-wrap">
          <h2 className="lp-h2">
            <Library size={16} /> Log library
          </h2>
          <LibraryList />
        </section>
      </div>
    );
  }

  const f = open.flight;
  const s = open.analysis.summary;
  return (
    <div className={`page-pad lp ${over ? "lp-over" : ""}`} {...dropProps}>
      {picker}
      <header className="lp-head">
        <div className="lp-head-main">
          <h1 title={open.name}>{open.name}</h1>
          <p className="lp-head-sub">
            {f.kind === "bin" ? "On-board log" : "Telemetry log"}
            {s.firmware ? ` · ${s.firmware}` : f.vehicle !== "unknown" ? ` · ${f.vehicle}` : ""}
            {s.startUtc ? ` · ${new Date(s.startUtc).toLocaleString()}` : ""}
            {` · ${clock(f.duration)} long`}
          </p>
        </div>
        <div className="lp-head-actions">
          <ExportMenu />
          <button className="btn" onClick={() => pick.current?.click()} title="Open another log">
            <ScrollText size={15} /> Open…
          </button>
          <button className="btn btn-ghost" onClick={close} aria-label="Close this log">
            <X size={15} /> Close
          </button>
        </div>
      </header>
      {(loading || error) && <Status />}
      {f.vehicle !== "copter" && f.vehicle !== "unknown" && (
        <div className="callout lp-callout">
          <CircleAlert size={16} />
          <span>This log is from {f.firmware ?? `a ${f.vehicle}`}. AERONEX's checks are written for ArduCopter; charts, events and parameters read normally, but some checks may not apply.</span>
        </div>
      )}
      <nav className="lp-tabs" role="tablist" aria-label="Log views">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>
      <div className="lp-body" role="tabpanel">
        {tab === "report" && <Report />}
        {tab === "charts" && <Charts />}
        {tab === "replay" && <Replay />}
        {tab === "events" && <Timeline />}
        {tab === "params" && <Params />}
        {tab === "messages" && <Messages />}
      </div>
    </div>
  );
}

function Status() {
  const loading = useLogs((s) => s.loading);
  const error = useLogs((s) => s.error);
  if (loading)
    return (
      <div className="lp-status" role="status">
        <span>Reading {loading.name}…</span>
        <span className="lp-bar">
          <i style={{ width: `${Math.round(loading.share * 100)}%` }} />
        </span>
        <span>{Math.round(loading.share * 100)}%</span>
      </div>
    );
  if (error)
    return (
      <div className="callout danger lp-callout" role="alert">
        <CircleAlert size={16} />
        <span>{error}</span>
        <button className="btn btn-ghost btn-icon lp-dismiss" onClick={() => useLogs.setState({ error: null })} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
    );
  return null;
}

