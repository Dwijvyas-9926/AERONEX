/*
  The flight replayed: the aircraft in the simulator's 3D world, flying the
  logged positions and attitudes, with its instruments, the map and a
  timeline to scrub. The time is shared with the Charts tab: pause here and
  the charts' cursor is on the same moment.
*/
import { Map as MapIcon, Pause, Play, Rewind, SkipBack, SkipForward } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toLocal } from "../../geo/geo";
import { clock } from "../../logs/analyze";
import { replayAt, replayHome, replayPath, type ReplayState } from "../../logs/replay";
import { makeTerrain } from "../../sim/terrain";
import { useSettings } from "../../state/settingsStore";
import { useSim, type PlanPoint } from "../../state/simStore";
import { Pfd } from "../flightdata/Pfd";
import type { ReplayPose, WorldView } from "../simulator/world/FlightWorld";
import { useLogs } from "./store";

const FlightWorld = lazy(() => import("../simulator/world/FlightWorld"));
const RealMap = lazy(() => import("../mission-planning/RealMap"));

const FLAT = makeTerrain("flat");
const SPEEDS = [0.5, 1, 2, 5, 10, 20];
const VIEWS: [WorldView, string][] = [
  ["chase", "Chase"],
  ["orbit", "Orbit"],
  ["ground", "Ground"],
  ["top", "Top"],
  ["fpv", "Onboard"],
];
/** Mission commands that have a position to fly to. */
const NAV_CMDS = new Set([16, 17, 18, 19, 21, 82]);

export function Replay() {
  const open = useLogs((s) => s.open)!;
  const cursor = useLogs((s) => s.cursor);
  const setCursor = useLogs((s) => s.setCursor);
  const graphics = useSettings((s) => s.graphics);
  const units = useSettings((s) => s.units);
  const airframe = useSim((s) => s.airframe);
  const f = open.flight;
  const home = useMemo(() => replayHome(f), [f]);
  const path = useMemo(() => replayPath(f, 3000, home), [f, home]);
  const start = f.flying.length ? Math.max(0, f.flying[0].from - 3) : 0;
  const [t, setT] = useState(() => (cursor !== null ? cursor : start));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<WorldView>("chase");
  const [showMap, setShowMap] = useState(true);
  const source = useRef<ReplayPose | null>(null);
  const tRef = useRef(t);
  const [state, setState] = useState<ReplayState>(() => replayAt(f, t, home));

  // The logged mission, where it has one, drawn as the plan.
  const route = useMemo<PlanPoint[]>(() => {
    if (!home) return [];
    return f.mission
      .filter((m) => m.seq > 0 && NAV_CMDS.has(m.command) && (m.lat || m.lng))
      .map((m) => {
        const ne = toLocal(home, m.lat, m.lng);
        return { id: `m${m.seq}`, n: ne.n, e: ne.e, alt: m.frame === 0 ? m.alt - home.alt : m.alt, holdS: 0 };
      });
  }, [f, home]);

  // Follow the shared cursor when it is moved elsewhere (a finding, the charts).
  useEffect(() => {
    if (cursor !== null && Math.abs(cursor - tRef.current) > 0.25) {
      tRef.current = cursor;
      setT(cursor);
    }
  }, [cursor]);

  // Play: advance the time every frame; refresh the instruments ten times a second.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    let lastT = NaN;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        tRef.current = Math.min(f.duration, tRef.current + dt * speed);
        if (tRef.current >= f.duration) setPlaying(false);
      }
      const s = replayAt(f, tRef.current, home);
      source.current = { t: s.t, n: s.n, e: s.e, d: s.d, roll: s.roll, pitch: s.pitch, yaw: s.yaw, throttle: s.throttle, armed: s.armed };
      // The instruments only need redrawing when the time has moved.
      if (now - lastUi > 100 && s.t !== lastT) {
        lastUi = now;
        lastT = s.t;
        setState(s);
        if (playing) {
          setT(tRef.current);
          setCursor(tRef.current);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, f, home, setCursor]);

  const seek = (x: number) => {
    const v = Math.max(0, Math.min(f.duration, x));
    tRef.current = v;
    setT(v);
    setCursor(v);
  };

  // Keyboard: space plays, arrows step.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") seek(tRef.current + (e.shiftKey ? 10 : 1));
      else if (e.key === "ArrowLeft") seek(tRef.current - (e.shiftKey ? 10 : 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f]);

  if (!f.att && !f.pos) return <p className="lp-empty">This log has neither attitude nor position, so there is nothing to replay.</p>;

  const imp = units === "imperial";
  const ghost = path.map((p) => ({ n: p.n, e: p.e }));
  const jumps = open.analysis.findings.filter((x) => x.at !== undefined && x.severity !== "info");
  const D = Math.max(1, f.duration);
  return (
    <div className="lp-replay">
      <div className="lp-replay-main">
        <div className="lp-world world">
          <Suspense fallback={<div className="world-loading">Building the landscape…</div>}>
            <FlightWorld
              terrain={FLAT}
              airframe={airframe}
              route={route}
              takeoffAlt={0}
              ending="hold"
              wind={{ speed: 0, fromDeg: 0 }}
              view={view}
              graphics={graphics}
              object={null}
              forward="-z"
              up="+y"
              scalePercent={100}
              fenceRadius={null}
              source={source}
            />
          </Suspense>
          <div className="world-hud top">
            <span className={`world-chip ${state.armed ? "on" : ""}`}>{state.mode || "Mode"}</span>
            <span className="world-chip">{state.flying ? "Flying" : state.armed ? "Armed, on the ground" : "Disarmed"}</span>
            {!state.hasPosition && f.pos && <span className="world-chip">No position yet</span>}
            {!f.pos && <span className="world-chip">No position in this log: attitude only</span>}
          </div>
          <div className="world-hud views" role="group" aria-label="Camera">
            {VIEWS.map(([k, label]) => (
              <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <aside className="lp-replay-side">
          <div className="lp-pfd">
            <Pfd
              roll={state.roll}
              pitch={state.pitch}
              heading={state.yaw}
              speed={Number.isFinite(state.speed) ? (imp ? state.speed * 2.23694 : state.speed) : 0}
              speedUnit={imp ? "mph" : "m/s"}
              altitude={Number.isFinite(state.altRel) ? (imp ? state.altRel * 3.28084 : state.altRel) : 0}
              altUnit={imp ? "ft" : "m"}
              climb={Number.isFinite(state.climb) ? state.climb : 0}
              throttle={state.throttle * 100}
              stale={false}
              hasData={!!f.att}
            />
          </div>
          <dl className="lp-readouts">
            <div><dt>Battery</dt><dd>{Number.isFinite(state.volt) ? `${state.volt.toFixed(2)} V` : "—"}{Number.isFinite(state.remPct) && state.remPct >= 0 ? ` · ${state.remPct.toFixed(0)}%` : ""}</dd></div>
            <div><dt>Throttle</dt><dd>{(state.throttle * 100).toFixed(0)}%</dd></div>
            <div><dt>Satellites</dt><dd>{Number.isFinite(state.sats) ? state.sats : "—"}</dd></div>
            <div><dt>From home</dt><dd>{state.hasPosition ? `${Math.hypot(state.n, state.e).toFixed(0)} m` : "—"}</dd></div>
          </dl>
          {home && (
            <div className="lp-minimap">
              <button className="btn btn-ghost" onClick={() => setShowMap((x) => !x)} aria-expanded={showMap}>
                <MapIcon size={15} /> {showMap ? "Hide map" : "Show map"}
              </button>
              {showMap && (
                <Suspense fallback={<div className="world-loading">Loading the map…</div>}>
                  <div className="lp-map">
                    <RealMap home={{ lat: home.lat, lon: home.lon }} route={route.map((r, i) => ({ id: r.id, n: r.n, e: r.e, label: String(i + 1) }))} ghost={ghost} mark={state.hasPosition ? { n: state.n, e: state.e, label: clock(state.t), tone: "ok" } : null} homeLocked />
                  </div>
                </Suspense>
              )}
            </div>
          )}
        </aside>
      </div>
      <div className="lp-transport">
        <button className="btn btn-icon" onClick={() => seek(0)} aria-label="Back to the start">
          <SkipBack size={16} />
        </button>
        <button className="btn btn-icon" onClick={() => seek(t - 10)} aria-label="Back 10 seconds">
          <Rewind size={16} />
        </button>
        <button className="btn btn-primary btn-icon" onClick={() => {
            if (t >= f.duration - 0.05) {
              seek(start);
              setPlaying(true);
            } else setPlaying((p) => !p);
          }} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="btn btn-icon" onClick={() => seek(t + 10)} aria-label="Forward 10 seconds">
          <SkipForward size={16} />
        </button>
        <span className="lp-time">
          {clock(t)} <small>/ {clock(f.duration)}</small>
        </span>
        <div className="lp-scrub">
          <div className="lp-scrub-track" aria-hidden>
            {f.flying.map((x, k) => (
              <span key={k} className="fly" style={{ left: `${(x.from / D) * 100}%`, width: `${((x.to - x.from) / D) * 100}%` }} />
            ))}
            {jumps.map((x) => (
              <span key={x.id} className={`pin ${x.severity}`} style={{ left: `${(x.at! / D) * 100}%` }} />
            ))}
          </div>
          <input type="range" min={0} max={f.duration} step={0.05} value={t} onChange={(e) => seek(+e.target.value)} aria-label="Time in the log" aria-valuetext={clock(t)} />
        </div>
        <div className="lp-seg" role="radiogroup" aria-label="Replay speed">
          {SPEEDS.map((x) => (
            <button key={x} role="radio" aria-checked={speed === x} className={speed === x ? "on" : ""} onClick={() => setSpeed(x)}>
              {x}×
            </button>
          ))}
        </div>
      </div>
      {jumps.length > 0 && (
        <div className="lp-jumps">
          <span>Jump to:</span>
          {jumps.slice(0, 8).map((x) => (
            <button key={x.id} className={`lp-jump ${x.severity}`} onClick={() => seek(Math.max(0, x.at! - 3))}>
              {clock(x.at!)} {x.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
