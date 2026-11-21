import { Cable, FlaskConical, Gamepad2, Globe, HardDrive, Lock, ShieldCheck, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import { ROUTES, STAGES, type BuildStatus } from "../../app/routes";
import { BrandLogo } from "../../components/shell/BrandMark";
import { useUpdates } from "../../desktop/updates";
import { isDesktop } from "../../desktop/bridge";
import { useUi } from "../../state/uiStore";

/*
  The About page says what AERONEX is today. The progress list is read from
  the same route table as the sidebar, so it cannot drift from the app.
*/

function statusOf(s: BuildStatus): { label: string; tone: string; detail?: string } {
  if (s.kind === "ready") return { label: "Complete", tone: "ok" };
  if (s.kind === "partial") return { label: "Working", tone: "accent", detail: s.note };
  return { label: "Planned", tone: "idle" };
}

/* How the app keeps a real aircraft safe. Each line is something the code enforces. */
const SAFEGUARDS: { title: string; body: string }[] = [
  {
    title: "Commands for ArduCopter only",
    body: "Arming, modes, take-off, missions and calibration are sent only to a multicopter running ArduCopter. Any other autopilot is shown and read, never commanded.",
  },
  {
    title: "Every command confirmed",
    body: "Each command waits for the aircraft's acknowledgement and is retried in the MAVLink way. A refusal is reported in plain words, never assumed to have worked.",
  },
  {
    title: "No settings changed in flight",
    body: "Parameters are not written to an armed aircraft unless you confirm it, nothing is written until you press Upload, and the flight controller cannot be restarted while armed.",
  },
  {
    title: "The aircraft's own pre-arm checks",
    body: "Preflight Check follows ArduCopter's pre-arm result and its reasons, then adds battery, GPS and link checks on top. It never overrides the autopilot.",
  },
  {
    title: "Missions checked twice",
    body: "A route is checked against the measured ground, the fence and the battery as you draw it. Sending needs a GPS fix and a disarmed aircraft, and the mission is read back and compared afterwards.",
  },
  {
    title: "Motors only on purpose",
    body: "Motor tests need the propellers-off box ticked and stop when the link drops or you leave the tab. ESC calibration never restarts the board for you, because that start sends full throttle.",
  },
  {
    title: "Gentle keyboard flight",
    body: "Walking pace, a 10 m ceiling and a 20 m limit around the take-off point. If the tab loses focus the aircraft holds; if the link drops it lands.",
  },
  {
    title: "Firmware installed with care",
    body: "The build is matched to the board's own identity, the aircraft must be disarmed, and every byte is read back and compared before the board restarts.",
  },
];

/* The short facts someone deciding whether to use it looks for first. */
const FACTS: { icon: typeof Globe; title: string; body: string }[] = [
  { icon: Globe, title: "Runs in the browser", body: "Nothing to install. Chrome, Edge or Opera on a desktop for the hardware link; any modern browser for everything else." },
  { icon: WifiOff, title: "Works offline", body: "After one visit the app opens with no internet. Map areas can be saved for the field." },
  { icon: Lock, title: "Your data stays with you", body: "There is no server and no account. Plans, logs and settings are kept in this browser only." },
  { icon: FlaskConical, title: "Checked on real firmware", body: "Every release is flown against ArduPilot's own simulator build of ArduCopter 4.6 and 4.7." },
];

const REQUIREMENTS: [string, string][] = [
  ["Flight controller", "Pixhawk 2.4.8, Holybro Pixhawk 6C Mini, and other MAVLink boards running ArduCopter"],
  ["Firmware", "ArduCopter 4.6 and 4.7 (multicopters and traditional helicopters for firmware install)"],
  ["Link", "USB cable, or a telemetry radio that appears as a serial port"],
  ["Browser, for hardware", "Chrome, Edge or Opera on Windows, macOS or Linux (Web Serial), over https"],
  ["Browser, without hardware", "Any current browser with WebGL 2, including Firefox and Safari"],
  ["Screen", "Laptop or desktop recommended; every page also fits a tablet or phone"],
];

const CREDITS: [string, string][] = [
  ["ArduPilot", "The flight firmware AERONEX works with. Parameter names, descriptions and ranges come from the ArduPilot project's own documentation (GPL-3.0)."],
  ["MAVLink", "The open protocol the app speaks to the flight controller."],
  ["React, Three.js, MapLibre GL JS, Zustand, Lucide", "The interface, 3D views, maps, state and icons (MIT, BSD-3-Clause and ISC licences)."],
  ["Open CASCADE, through occt-import-js", "Reads STEP files for the Digital Twin (LGPL-2.1)."],
  ["Manrope and Saira Semi Condensed", "The typefaces (SIL Open Font License)."],
  ["Map and elevation data", "Sentinel-2 cloudless by EOX, OpenStreetMap contributors, Esri World Imagery, MapTiler, and Terrain Tiles on AWS. Each is credited on the map it appears on."],
];

export function AboutPage() {
  const openGuide = useUi((s) => s.toggle);
  // The Windows app knows its own version; in a browser the page is always the latest.
  const version = useUpdates((s) => s.status?.current ?? null);
  return (
    <div className="page-pad about">
      <section className="about-hero">
        <h1 className="about-logo">
          <BrandLogo />
        </h1>
        <p className="about-tagline">A ground station for ArduCopter drones that runs in your browser.</p>
        <p className="about-meta">
          <span className="pill accent plain">Pre-release</span>
          {version ? <span className="pill plain">Version {version} for Windows</span> : null}
          <span className="pill plain">ArduCopter 4.6 and 4.7</span>
          <span className="pill plain">Pixhawk 2.4.8 and 6C Mini</span>
        </p>
      </section>

      <p className="about-lede">
        AERONEX takes a multicopter from a drawing to a calibrated, checked aircraft, then flies it and tells you what went wrong. It connects to the
        flight controller over a USB cable or a telemetry radio, needs nothing installed, and comes with a virtual aircraft so every page can be learned
        before any hardware is plugged in.
      </p>

      <div className="about-facts">
        {FACTS.map((f) => (
          <div key={f.title} className="about-fact">
            <f.icon aria-hidden className="about-icon" />
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </div>
        ))}
      </div>

      <section className="about-section">
        <h2>What it does</h2>
        <p className="about-prose about-prose-gap">
          Four stages, in the order you would do them. Complete pages work end to end. Working pages do their job on real hardware, with the scope
          noted beside each.
        </p>
        <div className="about-progress">
          {STAGES.map((stage) => (
            <section key={stage.group} className="about-stage">
              <header>
                <h3>{stage.group}</h3>
                <p>{stage.summary}</p>
              </header>
              <ul>
                {ROUTES.filter((r) => r.group === stage.group).map((r) => {
                  const st = statusOf(r.status);
                  const Icon = r.icon;
                  return (
                    <li key={r.path}>
                      <Icon aria-hidden className="about-row-icon" />
                      <Link to={r.path} className="about-row-name">
                        {r.label}
                      </Link>
                      <span className="about-row-detail">{st.detail ?? ""}</span>
                      <span className={`pill ${st.tone} plain`}>{st.label}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>Built to be safe on a real aircraft</h2>
        <div className="about-safeguards">
          {SAFEGUARDS.map((s) => (
            <div key={s.title} className="about-safeguard">
              <ShieldCheck aria-hidden className="about-icon" />
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>How it is verified</h2>
        <div className="about-grid">
          <section className="about-card">
            <h3>Against the real firmware</h3>
            <p>
              AERONEX is run against ArduPilot's own simulator build of ArduCopter 4.6 and 4.7, the same flight code as a Pixhawk. The tests link over
              the app's real serial path, read every setting the app uses by name, send and read back missions and fences, fly them, release payloads,
              download logs, and check that the planner's flight-time prediction lands within 15% of the flight.
            </p>
          </section>
          <section className="about-card">
            <h3>By automated tests on every change</h3>
            <p>
              Several hundred unit tests cover the protocol, the planner, the simulator, the log reader and the firmware installer, which is tested
              against a simulated ArduPilot bootloader. Files from outside (logs, missions, settings, firmware) are tested with random and hostile
              input. Every page is checked for errors and accessibility at desktop, tablet and phone widths.
            </p>
          </section>
          <section className="about-card">
            <h3>Simulated data is always labelled</h3>
            <p>
              The virtual aircraft speaks MAVLink exactly as a flight controller does, so every page works on it. While it is linked, every page says
              the data is simulated, exports are marked, and the status bar reads Virtual aircraft.
            </p>
          </section>
          <section className="about-card">
            <h3>What has not been done yet</h3>
            <p>
              The app has not yet been through a flight-test programme on physical hardware. Before a first flight, check it on your own
              aircraft with the propellers off: connect, read the settings, run Preflight Check, test the motors, and send and read back a mission.
            </p>
          </section>
        </div>
      </section>

      <section className="about-section">
        <h2>Privacy and security</h2>
        <div className="about-grid">
          <section className="about-card">
            <h3>
              <HardDrive aria-hidden className="about-inline-icon" /> Where your data lives
            </h3>
            <p>
              Aircraft profiles, frame designs, mission plans, flight logs and settings are stored in this browser and nowhere else. AERONEX has no
              server, no account and no analytics. Reset app data in Settings removes all of it. Nothing on a flight controller is touched by a reset.
            </p>
          </section>
          <section className="about-card">
            <h3>
              <Globe aria-hidden className="about-inline-icon" /> What leaves your computer
            </h3>
            <p>
              Map pictures and ground heights are fetched from the provider you choose. Firmware is fetched from ArduPilot's server. If you add your
              own Anthropic key, your questions and the aircraft's readings (never its location) go to Anthropic to answer them. Keys are kept for the
              session unless you choose to remember them.
            </p>
          </section>
        </div>
        <p className="about-prose about-prose-top">
          The app runs under a strict content security policy: scripts load only from the app itself, and text from a file, a flight controller or the
          assistant is always shown as text, never run. To report a security problem, use Security, then Report a vulnerability, on the project's GitHub
          page.
        </p>
      </section>

      <section className="about-section">
        <h2>What you need</h2>
        <dl className="about-table">
          {REQUIREMENTS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="about-section">
        <h2>Under the hood</h2>
        <p className="about-prose">
          AERONEX talks to the flight controller through the browser's Web Serial API, using its own MAVLink 1 and 2 implementation that checks every
          frame against its checksum. Real hardware and the virtual aircraft share one command path, so the code that drives a drone is the code
          exercised every day. The virtual aircraft is a six-degree-of-freedom physics model with ArduCopter's own control laws. The app is built with
          React, TypeScript, Three.js and MapLibre, and is delivered as static files.
        </p>
      </section>

      <section className="about-section">
        <h2>Coming next</h2>
        <p className="about-prose">
          A survey grid for mapping flights, rally points, and winch delivery. After that, a desktop app with native serial and network links, then
          other vehicle types. Until then, ArduCopter is the only firmware AERONEX commands.
        </p>
      </section>

      <section className="about-section">
        <h2>Acknowledgements</h2>
        <dl className="about-table">
          {CREDITS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="about-prose about-prose-top">AERONEX is an independent project. It is not affiliated with or endorsed by ArduPilot, Holybro, or any map provider named here.</p>
        <p className="about-prose">
          AERONEX is open source under the{" "}
          <a href="https://github.com/Dwijvyas-9926/AERONEX_test/blob/main/LICENSE" target="_blank" rel="noreferrer">
            Apache License 2.0
          </a>
          , copyright 2026 Dwij Vyas. The licence covers the code, not the AERONEX name or logo. The libraries it includes are listed with their licences in{" "}
          <a href="https://github.com/Dwijvyas-9926/AERONEX_test/blob/main/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noreferrer">
            THIRD-PARTY-NOTICES.txt
          </a>
          {isDesktop() ? ", which is also in the folder AERONEX is installed in." : "."}
        </p>
      </section>

      <section className="about-creator">
        <span className="about-creator-label">Creator</span>
        <h2>Dwij Vyas</h2>
        <p>
          AERONEX is conceived, designed and engineered by Dwij Vyas. It grew out of a disaster-relief drone programme, where an aircraft has to be ready
          on the first attempt and the ground station must never get in the way. The aim is a ground station that is as dependable as professional
          tools and as easy to pick up as a web page.
        </p>
      </section>

      <div className="about-foot">
        <ShieldCheck className="about-icon" aria-hidden />
        <div>
          <strong>Safety and responsibility</strong>
          <p>
            AERONEX helps you prepare, configure, fly and review an aircraft. It is not flight-certified and is provided as it is, without warranty. It
            does not replace the manufacturer's documentation, the autopilot's own safety checks or your local aviation rules. The pilot is responsible
            for every flight: fly within the law, keep clear of people, and test on your own hardware with the propellers off before you rely on it.
          </p>
        </div>
      </div>

      <div className="about-cta">
        <Link className="btn btn-primary" to="/simulator">
          <Gamepad2 /> Try the virtual aircraft
        </Link>
        <Link className="btn" to="/connection">
          <Cable /> Connect an aircraft
        </Link>
        <button className="btn" onClick={() => openGuide("help")}>
          Open the guide <kbd>?</kbd>
        </button>
      </div>
    </div>
  );
}
