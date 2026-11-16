/*
  Firmware: install ArduPilot (ArduCopter) on a flight controller over USB.
  AERONEX finds the board's bootloader, picks the build for that exact
  board, downloads the latest stable release from ArduPilot's firmware
  server and installs it, checked byte for byte. A guide tab explains the
  whole process for someone doing it for the first time.
*/
import { BookOpen, CheckCircle2, ChevronRight, CircleAlert, Cpu, Download, ExternalLink, FileUp, Loader2, Plug, RefreshCw, RotateCcw, Search, ShieldCheck, Usb, X, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLink } from "../../state/linkStore";
import { linkManager } from "../../services/link/linkManager";
import { chipLimitedTo1M, type Phase } from "../../firmware/bootloader";
import { serverUrl, stablePath, VEHICLES, type Candidate } from "../../firmware/catalog";
import {
  cancelWait,
  chooseBuild,
  chosenFirmware,
  findBoard,
  install,
  isFlightControllerPort,
  loadRelease,
  restartLinkedIntoBootloader,
  setVehicle,
  startOver,
  pickFile,
  useFirmware,
  backToStable,
  waitForBoard,
} from "../../firmware/installer";
import { Guide } from "./Guide";
import "./firmware.css";

type Tab = "install" | "guide";

const hasSerial = typeof navigator !== "undefined" && "serial" in navigator;

export function FirmwarePage() {
  const [tab, setTab] = useState<Tab>("install");
  return (
    <div className="page-pad fw">
      <header className="page-head">
        <div>
          <h1>Firmware</h1>
          <p>Install ArduPilot on the flight controller over USB. AERONEX works out which build fits your board, downloads the latest stable release from ArduPilot and checks every byte that was written before the board starts it.</p>
        </div>
      </header>
      <nav className="fw-tabs" role="tablist" aria-label="Firmware views">
        <button role="tab" aria-selected={tab === "install"} className={tab === "install" ? "on" : ""} onClick={() => setTab("install")}>
          <Download size={15} /> Install
        </button>
        <button role="tab" aria-selected={tab === "guide"} className={tab === "guide" ? "on" : ""} onClick={() => setTab("guide")}>
          <BookOpen size={15} /> How to install
        </button>
      </nav>
      <div role="tabpanel">{tab === "install" ? <Installer onGuide={() => setTab("guide")} /> : <Guide onInstall={() => setTab("install")} />}</div>
    </div>
  );
}

function Installer({ onGuide }: { onGuide: () => void }) {
  const step = useFirmware((s) => s.step);
  if (!hasSerial) {
    return (
      <div className="callout danger" role="alert">
        <CircleAlert size={16} />
        <span>
          <strong>This browser cannot reach USB devices.</strong> Installing firmware needs Web Serial, which Chrome and Edge have on Windows, macOS, Linux and ChromeOS. Open AERONEX in one of them on a computer (not a phone or tablet).
        </span>
      </div>
    );
  }
  return (
    <>
      <ErrorBox />
      {step === "start" && <Start onGuide={onGuide} />}
      {step === "waiting" && <Waiting />}
      {step === "board" && <Board />}
      {step === "installing" && <Installing />}
      {step === "done" && <Done />}
    </>
  );
}

function ErrorBox() {
  const error = useFirmware((s) => s.error);
  if (!error) return null;
  return (
    <div className="callout danger fw-error" role="alert">
      <CircleAlert size={16} />
      <div>
        <strong>{error.title}.</strong> {error.detail}
        {error.manualUrl && (
          <div className="fw-error-link">
            <a href={error.manualUrl} target="_blank" rel="noreferrer">
              Open it on the firmware server <ExternalLink size={12} />
            </a>
          </div>
        )}
      </div>
      <button className="btn btn-ghost btn-icon fw-dismiss" onClick={() => useFirmware.setState({ error: null })} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

function VehiclePicker({ disabled }: { disabled?: boolean }) {
  const vehicle = useFirmware((s) => s.vehicle);
  return (
    <fieldset className="fw-vehicles" disabled={disabled}>
      <legend>What it flies</legend>
      {VEHICLES.map((v) => (
        <label key={v.id} className={`fw-vehicle ${vehicle === v.id ? "on" : ""}`}>
          <input type="radio" name="fw-vehicle" checked={vehicle === v.id} onChange={() => setVehicle(v.id)} />
          <span>
            <strong>{v.label}</strong>
            <small>{v.detail}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Start({ onGuide }: { onGuide: () => void }) {
  const vehicle = useLink((s) => s.vehicle);
  const status = useLink((s) => s.status);
  const virtual = useLink((s) => s.virtual);
  // Read on every link change (status), since the port lives in the link manager.
  const linkedInfo = status && !virtual ? linkManager.linkedPortInfo() : null;
  const linkedOverUsb = !!(vehicle && linkedInfo && isFlightControllerPort(linkedInfo));
  const linkedOther = !!linkedInfo && !linkedOverUsb;

  return (
    <div className="fw-start">
      <section className="panel fw-panel">
        <div className="panel-body">
          <VehiclePicker />
          <p className="fw-stable">
            <ShieldCheck size={15} /> Only stable releases are offered: the versions ArduPilot has tested and released for flying. Beta and development builds are not.
          </p>
        </div>
      </section>

      {linkedOverUsb ? (
        <section className="panel fw-panel">
          <div className="panel-body fw-go">
            <h2>
              <Usb size={17} /> The board is connected
            </h2>
            <p>
              AERONEX is linked to {vehicle!.firmware === "ardupilot" ? "ArduPilot" : "the flight controller"} over its USB port. It can restart the board into its bootloader and install from there.
              {vehicle!.armed ? " Disarm first." : " Your parameters stay on the board; it is still worth saving them first."}
            </p>
            <div className="fw-actions">
              <button className="btn btn-primary btn-lg" disabled={vehicle!.armed} onClick={() => void restartLinkedIntoBootloader()}>
                <RefreshCw size={16} /> Restart into bootloader
              </button>
              <Link className="btn" to="/params">
                Save parameters first
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel fw-panel">
          <div className="panel-body fw-go">
            <h2>
              <Plug size={17} /> Find the board
            </h2>
            {linkedOther && (
              <div className="callout warn">
                <CircleAlert size={16} />
                <span>
                  {isFlightControllerPort(linkedInfo!)
                    ? "AERONEX's connection has the board's port open, but no autopilot is answering on it (it may be sitting in its bootloader). Disconnect it to install."
                    : "AERONEX is connected through a telemetry radio or another adapter. Firmware goes in through the flight controller's own USB port: disconnect, then plug the board in with a USB cable."}{" "}
                  <button className="fw-linkbtn" onClick={() => void linkManager.disconnect("Disconnected to install firmware.")}>
                    Disconnect
                  </button>
                </span>
              </div>
            )}
            <ol className="fw-steps">
              <li>Take the propellers off and unplug the battery. The board is powered by USB while it installs.</li>
              <li>Unplug the board's USB cable if it is in.</li>
              <li>
                Click <strong>Find the board</strong>, then plug the USB cable straight into this computer (not through a hub).
              </li>
              <li>
                Choose the board in the list as soon as it shows. If it was running ArduPilot, AERONEX restarts it into its bootloader, which then appears and waits for you: choose it as well.
              </li>
            </ol>
            <div className="fw-actions">
              <button className="btn btn-primary btn-lg" disabled={linkedOther} onClick={() => void findBoard()}>
                <Search size={16} /> Find the board
              </button>
              <button className="btn" disabled={linkedOther} onClick={() => void waitForBoard()} title="For a board this browser has been allowed to open before">
                <Usb size={15} /> Wait for a board I have used before
              </button>
            </div>
            <p className="fw-hint">
              First time, or something does not work? <button className="fw-linkbtn" onClick={onGuide}>Read how to install</button>.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function Waiting() {
  const status = useFirmware((s) => s.status);
  const waitingFor = useFirmware((s) => s.waitingFor);
  return (
    <section className="panel fw-panel">
      <div className="panel-body fw-wait">
        <Loader2 className="fw-spin" size={22} />
        <div>
          <h2>{waitingFor === "reboot" ? "Waiting for the bootloader" : "Waiting for the board"}</h2>
          <p>{status || "Plug the board in now."}</p>
          {waitingFor === "reboot" ? (
            <p className="fw-hint">
              The bootloader is a separate USB device. If AERONEX has not opened it before, it does not connect by itself: click <strong>Choose the bootloader</strong> and pick the entry with “BL” or “bootloader” in its name. It waits for you there.
            </p>
          ) : (
            <p className="fw-hint">AERONEX opens it as soon as it appears. A board it has never opened needs to be chosen in the list once.</p>
          )}
          <div className="fw-actions">
            <button className="btn btn-primary" onClick={() => void findBoard()}>
              <Search size={15} /> {waitingFor === "reboot" ? "Choose the bootloader" : "Choose it from the list"}
            </button>
            <button className="btn btn-ghost" onClick={cancelWait}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 2 : 0)} MB` : `${Math.round(n / 1024)} KB`);

function chipText(chip: number | null, des: string | null) {
  if (des) return des.replace(",", " rev ");
  if (chip === null) return null;
  const dev = chip & 0xfff;
  const rev = chip >>> 16;
  return `MCU id 0x${dev.toString(16)} rev 0x${rev.toString(16)}`;
}

function Board() {
  const info = useFirmware((s) => s.info)!;
  const rec = useFirmware((s) => s.rec);
  const platform = useFirmware((s) => s.platform);
  const vehicle = useFirmware((s) => s.vehicle);
  const portLabel = useFirmware((s) => s.portLabel);
  const source = useFirmware((s) => s.source);
  const release = useFirmware((s) => s.release);
  const file = useFirmware((s) => s.file);
  const download = useFirmware((s) => s.download);
  const problem = useFirmware((s) => s.problem);
  const status = useFirmware((s) => s.status);
  const pick = useRef<HTMLInputElement>(null);
  const fw = chosenFirmware();
  const limited = chipLimitedTo1M(info.chip);
  const chosen: Candidate | undefined = rec?.pick?.platform === platform ? rec?.pick : rec?.others.find((o) => o.platform === platform);
  const all = rec ? [...(rec.pick ? [rec.pick] : []), ...rec.others] : [];

  return (
    <div className="fw-board">
      <section className="panel fw-panel">
        <div className="panel-head">
          <h3>
            <Cpu size={16} /> The board
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={() => void startOver()}>
            <RotateCcw size={13} /> Start again
          </button>
        </div>
        <div className="panel-body">
          <dl className="fw-facts">
            <div>
              <dt>Board</dt>
              <dd>{rec?.pick ? rec.pick.platform.replace(/-1M$/, "") : rec?.choose.length ? `One of ${rec.choose.length} boards` : "Unknown"} <span className="muted">(board id {info.boardId}{info.boardRev ? `, rev ${info.boardRev}` : ""})</span></dd>
            </div>
            <div>
              <dt>Flash for firmware</dt>
              <dd className="num">{kb(info.flashSize)}{info.extfSize ? ` + ${kb(info.extfSize)} external` : ""}</dd>
            </div>
            {chipText(info.chip, info.chipDes) && (
              <div>
                <dt>Processor</dt>
                <dd>
                  {chipText(info.chip, info.chipDes)}
                  {limited === true && <span className="fw-tag warn">1 MB flash limit</span>}
                  {limited === false && <span className="fw-tag ok">full 2 MB</span>}
                </dd>
              </div>
            )}
            <div>
              <dt>Bootloader</dt>
              <dd>protocol {info.blRev}{portLabel ? <span className="muted"> · {portLabel}</span> : null}</dd>
            </div>
            {info.serial && (
              <div>
                <dt>Serial number</dt>
                <dd className="num fw-mono">{info.serial}</dd>
              </div>
            )}
          </dl>
          {rec?.notes.map((n) => (
            <p key={n} className="fw-note">
              {n}
            </p>
          ))}
        </div>
      </section>

      <section className="panel fw-panel">
        <div className="panel-head">
          <h3>
            <Download size={16} /> Firmware to install
          </h3>
        </div>
        <div className="panel-body">
          {source === "stable" ? (
            <>
              <VehiclePicker disabled={!!download} />
              {all.length > 0 && (
                <label className="fw-build">
                  <span>{rec?.choose.length ? "Which board is it?" : "Build"}</span>
                  <select value={platform ?? ""} onChange={(e) => chooseBuild(e.target.value)} disabled={!!download}>
                    {!platform && (
                      <option value="" disabled>
                        Choose your board…
                      </option>
                    )}
                    {rec?.choose.length
                      ? [...rec.choose.map((p) => all.find((c) => c.platform === p)!), ...all.filter((c) => !rec.choose.includes(c.platform))].map((c) => (
                          <option key={c.platform} value={c.platform}>
                            {c.platform}
                            {c.note ? ` — ${c.note}` : ""}
                          </option>
                        ))
                      : all.map((c, i) => (
                          <option key={c.platform} value={c.platform}>
                            {c.platform}
                            {i === 0 && rec?.pick ? " (recommended)" : ""}
                            {c.note && i !== 0 ? ` — ${c.note}` : ""}
                          </option>
                        ))}
                  </select>
                </label>
              )}
              {chosen?.note && <p className="fw-note">{chosen.platform}: {chosen.note}.</p>}
              {platform && rec?.pick && chosen !== rec.pick && (
                <p className="fw-note warn">
                  This is not the build AERONEX picked for this board. Use it only if you know the board needs it.
                </p>
              )}
              {download && (
                <div className="fw-dl" role="status">
                  <span>{status || "Downloading…"}</span>
                  <Bar share={download.total ? download.got / download.total : 0} />
                  <span className="num">{download.total ? `${kb(download.got)} of ${kb(download.total)}` : kb(download.got)}</span>
                </div>
              )}
              {release && (
                <div className="fw-release">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>{release.title ?? `ArduCopter ${release.version}`}</strong>
                    <span>
                      Stable {release.version} for {release.platform}
                      {release.vehicle === "heli" ? " (helicopter)" : ""} · {kb(release.apj.imageSize)}
                      {release.apj.gitIdentity ? ` · git ${release.apj.gitIdentity}` : ""}
                    </span>
                  </div>
                </div>
              )}
              {!release && !download && platform && (
                <button className="btn" onClick={() => void loadRelease()}>
                  <RefreshCw size={14} /> Download again
                </button>
              )}
            </>
          ) : (
            file && (
              <div className="fw-release fw-file">
                <FileUp size={18} />
                <div>
                  <strong>{file.name}</strong>
                  <span>
                    {file.apj.summary ?? "custom firmware"} · board id {file.apj.boardId} · {kb(file.apj.imageSize)}
                    {file.apj.gitIdentity ? ` · git ${file.apj.gitIdentity}` : ""}
                  </span>
                </div>
              </div>
            )
          )}

          {problem && (
            <div className="callout danger">
              <CircleAlert size={16} />
              <span>{problem}</span>
            </div>
          )}

          <div className="fw-install-row">
            <button className="btn btn-primary btn-lg" disabled={!fw || !!problem || !!download} onClick={() => void install()}>
              <Zap size={16} /> Install
            </button>
            <span className="fw-hint">Takes about half a minute. Keep the USB cable in until it says it is done.</span>
          </div>

          <details className="fw-adv">
            <summary>
              <ChevronRight size={14} /> Advanced: install from a file
            </summary>
            <div className="fw-adv-body">
              <p>
                Install a <strong>.apj</strong> firmware file you downloaded yourself, such as a build from{" "}
                <a href={serverUrl(stablePath(platform ?? "Pixhawk1", vehicle).dir)} target="_blank" rel="noreferrer">
                  the firmware server
                </a>{" "}
                or the custom firmware builder. It is checked against this board the same way, but AERONEX cannot tell whether it is a stable release: only install files you trust.
              </p>
              <input
                ref={pick}
                type="file"
                accept=".apj"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickFile(f);
                  e.target.value = "";
                }}
              />
              <div className="fw-actions">
                <button className="btn" onClick={() => pick.current?.click()}>
                  <FileUp size={14} /> Choose a .apj file
                </button>
                {source === "file" && (
                  <button className="btn btn-ghost" onClick={backToStable}>
                    Back to the stable release
                  </button>
                )}
              </div>
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <span className="fw-bar" aria-hidden>
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%` }} />
    </span>
  );
}

const STAGES: { id: string; label: string; phases: Phase[] }[] = [
  { id: "extf", label: "External flash", phases: ["extf-erase", "extf-program", "extf-verify"] },
  { id: "erase", label: "Erase", phases: ["erase"] },
  { id: "program", label: "Write", phases: ["program"] },
  { id: "verify", label: "Check", phases: ["verify"] },
  { id: "reboot", label: "Start", phases: ["reboot"] },
];
const ORDER: Phase[] = ["extf-erase", "extf-program", "extf-verify", "erase", "program", "verify", "reboot"];

function Installing() {
  const progress = useFirmware((s) => s.progress);
  const status = useFirmware((s) => s.status);
  const fw = chosenFirmware();
  const at = progress ? ORDER.indexOf(progress.phase) : 0;
  const stages = STAGES.filter((s) => s.id !== "extf" || (fw?.extfImage && fw.extfImageSize > 0));
  return (
    <section className="panel fw-panel">
      <div className="panel-body fw-installing" role="status" aria-live="polite">
        <h2>
          <Loader2 className="fw-spin" size={20} /> Installing
        </h2>
        <p className="fw-warn-line">
          <CircleAlert size={15} /> Do not unplug the board or close this tab.
        </p>
        <ol className="fw-stages">
          {stages.map((s) => {
            const first = ORDER.indexOf(s.phases[0]);
            const last = ORDER.indexOf(s.phases[s.phases.length - 1]);
            const state = at > last ? "done" : at >= first ? "now" : "next";
            const share = state === "done" ? 1 : state === "now" ? (progress?.share ?? 0) : 0;
            return (
              <li key={s.id} className={state}>
                <span className="fw-stage-name">
                  {state === "done" ? <CheckCircle2 size={15} /> : <span className="fw-dot" />} {s.label}
                </span>
                <Bar share={share} />
                <span className="num">{state === "next" ? "" : `${Math.round(share * 100)}%`}</span>
              </li>
            );
          })}
        </ol>
        <p className="muted">{status}</p>
      </div>
    </section>
  );
}

function Done() {
  const installed = useFirmware((s) => s.installed)!;
  return (
    <section className="panel fw-panel">
      <div className="panel-body fw-done">
        <CheckCircle2 size={28} className="fw-done-icon" />
        <div>
          <h2>Firmware installed</h2>
          <p>
            {installed.title ?? installed.platform}
            {installed.version ? ` (stable ${installed.version})` : ""} was written, checked against the board's own checksum and started, in {installed.seconds.toFixed(0)} s.
          </p>
          <h3>Next</h3>
          <ol className="fw-steps">
            <li>
              Wait a few seconds for the board to start, then <Link to="/connection">connect to it</Link>. The version appears in the link's messages.
            </li>
            <li>
              If this was a new install or a major version change, check the frame type and <Link to="/calibration">calibrate</Link> the accelerometers, compass and radio again.
            </li>
            <li>
              Run the <Link to="/preflight">preflight check</Link> before the first flight.
            </li>
          </ol>
          <div className="fw-actions">
            <Link className="btn btn-primary" to="/connection">
              <Plug size={15} /> Connect
            </Link>
            <button className="btn" onClick={() => void startOver()}>
              <RotateCcw size={14} /> Install on another board
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
