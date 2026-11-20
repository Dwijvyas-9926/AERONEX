import { ArrowDown, ArrowUp, CirclePause, Shield, Home as HomeIcon, Package, PlaneLanding, PlaneTakeoff, CircleCheck, CircleX, Download, FlaskConical, FolderOpen, SatelliteDish, Globe, Info, LandPlot, ListChecks, Play, Redo2, Save, Trash2, TriangleAlert, Undo2, Upload, X } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MODE_NAME } from "../../sim/autopilot";
import { NumInput } from "../../components/ui/NumInput";
import { defaultParams, type Params } from "../../sim/params";
import { predict, type FaultKind, type FaultPlan, type Prediction, type Verdict } from "../../sim/predict";
import { armedBlock, commandLink, missionBlock, vehicleBlock, COPTER_MODE } from "../../services/link/commandLink";
import { linkManager, rememberedParams } from "../../services/link/linkManager";
import { useLink } from "../../state/linkStore";
import { confirmAction, notify } from "../../state/notifyStore";
import { useParams } from "../../state/paramStore";
import { missionToPlan, planSteps, planToMission, routeLength, useSim, type Ending, type ReadPlan } from "../../state/simStore";
import { inPlanWords, useSentMission } from "../../state/sentMission";
import { FlightMap } from "../simulator/FlightMap";
import { makeTerrain, type TerrainKind } from "../../sim/terrain";
import { modelledParams, order } from "../simulator/SimulatorPage";
import { covers, realTerrain } from "../../geo/elevation";
import { fmtLatLon, toGlobal, toLocal, type LatLon } from "../../geo/geo";
import { checkPlan, flightSeconds } from "../../geo/planCheck";
import { useHomeSource } from "../../services/link/homeFollow";
import { fromWaypointFile, saveText, toWaypointFile } from "../../geo/planFile";
import { routeProfile } from "../../geo/profile";
import { demReach, ensureDem, useDem } from "../../state/mapStore";
import { CLEAR_WARN, HeightProfile } from "./HeightProfile";
import { FencePanel } from "./FencePanel";
import type { DragPhase, FenceDrawing, FenceLayer } from "./fenceLayer";
import { aroundRoute, FENCE_TYPE, isFlag, snap, zoneId, zonesToWire } from "../../geo/fence";
import { checkFence, marginXY } from "../../geo/fenceCheck";
import { distanceM } from "../../geo/geo";
import { fenceSync, useFence } from "../../state/fenceStore";
import { readFence, sendFence } from "../../services/link/fenceLink";
import { checkDeliveries, newDelivery, releaseKey, type DeliveryAt } from "../../mission/payload";
import { armAwayFindings, AWAY_M } from "../../mission/armHome";
import type { Payload } from "../../sim/vehicle";
import { DeliveryRow } from "./DeliveryRow";
import { usePayloadSetup } from "./usePayloadSetup";

// The map library is large and only this page needs it.
const RealMap = lazy(() => import("./RealMap"));
const FIELD = makeTerrain("flat");

const far = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

const VERDICT: Record<Verdict, { tone: "ok" | "warn" | "bad"; title: string }> = {
  completed: { tone: "ok", title: "Mission completed" },
  "came-home": { tone: "warn", title: "Came home early" },
  "landed-away": { tone: "warn", title: "Landed away from home" },
  holding: { tone: "warn", title: "Left hovering" },
  timeout: { tone: "warn", title: "Still flying" },
  refused: { tone: "bad", title: "Would not start" },
  crashed: { tone: "bad", title: "Crashed" },
  grounded: { tone: "bad", title: "Cannot take off" },
  stuck: { tone: "bad", title: "Could not get there" },
  "flew-away": { tone: "bad", title: "Flew away" },
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function NumCell({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  return <NumInput className="input mp-num" aria-label={label} value={value} min={min} max={max} onChange={onChange} />;
}

/** Which parameters a prediction should fly on, and where they came from. */
function useFlightParams(): { params: Params; source: string; fromAircraft: boolean; unread: { received: number; count: number | null } | null } {
  const sim = useSim();
  const virtual = useLink((s) => s.virtual);
  const status = useLink((s) => s.status);
  const live = useParams((s) => s.values);
  const count = useParams((s) => s.count);
  const received = useParams((s) => s.received);
  return useMemo(() => {
    const base = defaultParams(sim.airframe);
    if (status === "connected" && virtual && linkManager.sim) return { params: { ...linkManager.sim.ap.params }, source: "the virtual aircraft's current settings", fromAircraft: true, unread: null };
    if (status === "connected" && !virtual && count && received >= count) return { params: { ...base, ...modelledParams(live) }, source: "the settings just read from your aircraft", fromAircraft: true, unread: null };
    // A real aircraft is linked and its settings are not all here yet: nothing below is its own.
    const unread = status === "connected" && !virtual ? { received, count } : null;
    const saved = sim.useAircraftParams ? rememberedParams() : null;
    const got = modelledParams(saved?.values);
    if (saved && Object.keys(got).length) return { params: { ...base, ...got }, source: `the settings read from your aircraft on ${new Date(saved.at).toLocaleDateString()}`, fromAircraft: true, unread };
    return { params: base, source: "ArduCopter's default settings, tuned for this airframe", fromAircraft: false, unread };
  }, [sim.airframe, sim.useAircraftParams, status, virtual, live, count, received]);
}

interface Sitting {
  lat: number;
  lon: number;
  relAlt: number;
  armed: boolean;
  home: LatLon | null;
}

/** Where the linked aircraft is, when it has a position. */
function whereItSits(): Sitting | null {
  const l = useLink.getState();
  const p = l.telemetry.position?.value;
  if (l.status !== "connected" || !p || (p.lat === 0 && p.lon === 0)) return null;
  const h = l.telemetry.home?.value;
  return { lat: p.lat, lon: p.lon, relAlt: p.relAlt, armed: !!l.vehicle?.armed, home: h ? { lat: h.lat, lon: h.lon } : null };
}

function sameSitting(a: Sitting | null, b: Sitting | null): boolean {
  if (!a || !b) return a === b;
  const near = (x: LatLon | null, y: LatLon | null) => (!x || !y ? x === y : distanceM(x, y) < 1);
  return a.armed === b.armed && near(a, b) && near(a.home, b.home) && Math.abs(a.relAlt - b.relAlt) < 0.3;
}

export function MissionPlanningPage() {
  const sim = useSim();
  const nav = useNavigate();
  const status = useLink((s) => s.status);
  const virtual = useLink((s) => s.virtual);
  const linked = status === "connected";
  const { params, source, fromAircraft, unread } = useFlightParams();
  const payload = usePayloadSetup();
  /*
    The return-home height, the speeds, the fence and the battery failsafe are
    the aircraft's own settings. With a real aircraft linked they are read
    before anything is checked or sent, without the reader having to know to
    open the Parameters page first.
  */
  const askedFor = useRef(false);
  useEffect(() => {
    if (!unread) {
      askedFor.current = false;
      return;
    }
    if (askedFor.current || unread.count !== null) return;
    askedFor.current = true;
    void commandLink.ensureParamList().catch(() => (askedFor.current = false));
  }, [unread]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Prediction | null>(null);
  const [wind, setWind] = useState({ speed: 0, from: 270, gust: 30 });
  const [charge, setCharge] = useState(100);
  const [fault, setFault] = useState<"none" | FaultKind>("none");
  const [faultAt, setFaultAt] = useState<{ by: "waypoint" | "time"; value: number }>({ by: "waypoint", value: 1 });
  const [motor, setMotor] = useState({ n: 1, level: 0 });
  const dem = useDem();
  const homeSource = useHomeSource((h) => h.source);
  // Looked at a couple of times a second, not at telemetry rate.
  const [gpsBlock, setGpsBlock] = useState(() => vehicleBlock() ?? missionBlock() ?? armedBlock());
  // Where a linked aircraft sits, to the metre: it will set home there when it arms.
  const [sitting, setSitting] = useState<Sitting | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      const b = vehicleBlock() ?? missionBlock() ?? armedBlock();
      setGpsBlock((was) => (was?.body === b?.body ? was : b));
      const now = whereItSits();
      setSitting((was) => (sameSitting(was, now) ? was : now));
    }, 700);
    return () => window.clearInterval(t);
  }, []);
  const lastField = useRef<TerrainKind>(sim.terrain === "real" ? "hills" : sim.terrain);
  if (sim.terrain !== "real") lastField.current = sim.terrain;

  // A running simulator has its world already; the page shows that one.
  const simWorld = (linked && virtual && linkManager.sim?.terrain) || null;
  const real = simWorld ? simWorld.kind === "real" : sim.terrain === "real";
  const farthest = useMemo(() => Math.max(0, ...sim.points.map((p) => Math.hypot(p.n, p.e))), [sim.points]);
  const reach = demReach(farthest);
  const homeLat = sim.home.lat;
  const homeLon = sim.home.lon;
  useEffect(() => {
    if (real && !simWorld) void ensureDem({ lat: homeLat, lon: homeLon }, reach).catch(() => undefined);
  }, [real, simWorld, homeLat, homeLon, reach]);
  // The measured ground, as soon as any of it is there for this home.
  const measured = useMemo(() => (covers(dem.patch, { lat: homeLat, lon: homeLon }, 0) ? realTerrain(dem.patch) : null), [dem.patch, homeLat, homeLon]);
  useEffect(() => {
    // Home's height above the sea comes with the ground.
    if (real && !simWorld && measured && dem.patch && Math.abs(sim.home.altMsl - dem.patch.base) >= 1) sim.set("home", { ...sim.home, altMsl: Math.round(dem.patch.base) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, simWorld, measured]);
  const loaded = !real || !!simWorld || !!measured;

  // The landscape the aircraft will meet: the running simulator's, or the one chosen for it.
  const terrain = useMemo(() => simWorld ?? (sim.terrain === "real" ? (measured ?? FIELD) : makeTerrain(sim.terrain)), [simWorld, sim.terrain, measured]);
  const mission = useMemo(() => planToMission(sim.home, sim.takeoffAlt, sim.points, sim.ending, terrain.surface), [sim.home, sim.takeoffAlt, sim.points, sim.ending, terrain]);
  const length = routeLength(sim.points, sim.ending);
  // The mission's items in the plan's words, for the prediction's timeline.
  const steps = useMemo(() => planSteps(sim.points, sim.ending), [sim.points, sim.ending]);
  // The last waypoint carries its command on the map as well as in the list.
  const lastTag = sim.ending === "land" ? " Land" : sim.ending === "hold" ? " Hover" : "";
  const route = useMemo(
    () =>
      sim.points.map((p, i) => {
        const tags = [p.delivery ? (p.delivery.method === "drop" ? "Drop" : "Lower") : "", i === sim.points.length - 1 ? lastTag.trim() : ""].filter(Boolean);
        return { id: p.id, n: p.n, e: p.e, label: String(i + 1), tag: tags.join(" · "), target: !!p.delivery };
      }),
    [sim.points, lastTag],
  );
  const empty = sim.points.length === 0;
  // Measured ground stops somewhere. Past it the heights are not known, and must not be shown as if they were.
  const beyond = terrain.reach !== undefined && farthest > terrain.reach && (!!simWorld || dem.status !== "loading");
  // A prediction is for the home it was made from.
  useEffect(() => setResult(null), [homeLat, homeLon]);
  const groundKnown = loaded && !(terrain.reach !== undefined && farthest > terrain.reach);
  const profile = useMemo(() => routeProfile(sim.points, sim.takeoffAlt, sim.ending, params.RTL_ALT / 100, terrain.surface), [sim.points, sim.takeoffAlt, sim.ending, params.RTL_ALT, terrain]);
  const low = useMemo(() => (profile.lowest && groundKnown && profile.lowest.clear < CLEAR_WARN ? { n: profile.lowest.n, e: profile.lowest.e, clear: profile.lowest.clear } : null), [profile, groundKnown]);
  const mark = useMemo(
    () => (result && result.verdict !== "completed" && result.verdict !== "refused" && result.verdict !== "grounded" ? { n: result.stats.endN, e: result.stats.endE, label: result.verdict === "crashed" ? "Crash" : "Ends here", tone: (result.verdict === "crashed" ? "bad" : "ok") as "bad" | "ok" } : null),
    [result],
  );
  const windShown = useMemo(() => ({ speed: wind.speed, fromDeg: wind.from }), [wind.speed, wind.from]);

  /* ------------------------------------------------------------ the fence */
  const fence = useFence();
  const liveValues = useParams((s) => s.values);
  const fenceOther = useMemo(() => {
    const src: Record<string, number | undefined> = linked ? { ...params, ...liveValues } : { ...params };
    // Speeds in the planner's own units (centimetres), whatever this firmware calls them.
    return { WPNAV_SPEED: params.WPNAV_SPEED, WPNAV_ACCEL: params.WPNAV_ACCEL, RTL_ALT: params.RTL_ALT, OA_TYPE: src.OA_TYPE, FENCE_MARGIN_XY: src.FENCE_MARGIN_XY, FENCE_AUTOENABLE: src.FENCE_AUTOENABLE, FENCE_ALT_MAX_TP: src.FENCE_ALT_MAX_TP, FENCE_ALT_MIN_TP: src.FENCE_ALT_MIN_TP, BRD_SD_FENCE: src.BRD_SD_FENCE };
  }, [linked, params, liveValues]);
  const fenceFindings = useMemo(
    () => checkFence({ zones: fence.zones, limits: fence.limits, home: sim.home, other: fenceOther, plan: { points: sim.points, takeoffAlt: sim.takeoffAlt, ending: sim.ending } }),
    [fence.zones, fence.limits, sim.home, fenceOther, sim.points, sim.takeoffAlt, sim.ending],
  );
  const sync = fenceSync(fence);

  /* --------------------------------------------------------- deliveries */
  // Where the ground under a point is known: loaded, and within what was loaded.
  const groundAt = (n: number, e: number): number | null => (loaded && !(terrain.reach !== undefined && Math.max(Math.abs(n), Math.abs(e)) > terrain.reach) ? terrain.surface(n, e) : null);
  const deliveries = useMemo<DeliveryAt[]>(
    () => sim.points.flatMap((p, i) => (p.delivery ? [{ wp: i + 1, delivery: p.delivery, cruise: p.alt, ground: loaded && !(terrain.reach !== undefined && Math.max(Math.abs(p.n), Math.abs(p.e)) > terrain.reach) ? terrain.surface(p.n, p.e) : null }] : [])),
    [sim.points, loaded, terrain],
  );
  const carriedKg = deliveries.reduce((a, x) => a + x.delivery.kg, 0);
  const payloadFindings = useMemo(
    () =>
      checkDeliveries({
        deliveries,
        aircraft: payload.aircraft,
        aircraftSource: payload.source,
        restartPending: payload.restartPending,
        port: payload.port,
        airframe: sim.airframe,
        real,
        outputIssues: payload.outputIssues,
        // The floor as the Fence tab sets it: in force when the fence is on (or comes on at arming) and its type includes the floor.
        fenceFloor: isFlag(fence.limits.FENCE_TYPE, FENCE_TYPE.ALT_MIN) && (fence.limits.FENCE_ENABLE >= 1 || (fenceOther.FENCE_AUTOENABLE ?? 0) > 0) ? fence.limits.FENCE_ALT_MIN : null,
      }),
    [deliveries, payload, sim.airframe, real, fence.limits, fenceOther.FENCE_AUTOENABLE],
  );
  /** The payloads hanging below at take-off, each with what lets it go. */
  const payloads = useMemo<Payload[]>(() => deliveries.map((x) => ({ kg: x.delivery.kg, hangM: x.delivery.hangM, release: releaseKey(x.delivery.release), open: x.delivery.release.kind === "servo" ? x.delivery.release.open : undefined })), [deliveries]);
  const defaultRelease = () => (payload.options.find((o) => !o.problem) ?? payload.options[0]).release;

  /*
    The aircraft arms where it sits, and ArduCopter sets home there. Drawn
    from one home and flown from another, every height moves with the ground
    between them: after landing at the last waypoint, say, a second flight
    would let a payload go at the wrong height.
  */
  const away = useMemo(() => {
    if (!linked || !sitting) return [];
    const at = toLocal(sim.home, sitting.lat, sitting.lon);
    // The aircraft's own height above its home is the step, on the ground, when its home is the plan's.
    const homeSame = sitting.home !== null && distanceM(sitting.home, sim.home) <= AWAY_M;
    return armAwayFindings({
      armed: sitting.armed,
      at,
      groundThere: loaded && !(terrain.reach !== undefined && Math.max(Math.abs(at.n), Math.abs(at.e)) > terrain.reach) ? terrain.surface(at.n, at.e) : null,
      reported: homeSame ? sitting.relAlt : null,
      deliveries,
      putBack: virtual ? "Put it back at home on the Simulator page before flying, or fly from where it is knowing this." : "Carry it back to home before arming. Or arm it here, let home move to it, then set the heights again and send the mission before starting it.",
    });
  }, [linked, sitting, sim.home, deliveries, virtual, terrain, loaded]);

  const checks = useMemo(() => {
    const own = checkPlan({ points: sim.points, takeoffAlt: sim.takeoffAlt, ending: sim.ending, params, airframe: sim.airframe, profile, groundKnown, real, groundReach: beyond ? (terrain.reach ?? null) : null, ground: terrain.surface });
    // The route against the fence, from the fence's own check, with the fence as drawn here.
    const route = fenceFindings.filter((x) => x.scope === "route").map((x) => ({ sev: x.sev, text: x.text }));
    const notSent = linked && sync.known && !sync.same ? [{ sev: "warn" as const, text: "The fence on the Fence tab is not the one on the aircraft. These checks use the one here; send it, or the aircraft flies with its own." }] : [];
    // The release is the aircraft's own; say which settings it was checked against when they are not live.
    const against = deliveries.length && payload.aircraft && !payload.live ? [{ sev: "note" as const, text: `The payload release is checked against ${payload.source}. Link the aircraft to check it as it is now.` }] : [];
    const order = { bad: 0, warn: 1, note: 2 };
    return [...away, ...own, ...route, ...notSent, ...payloadFindings, ...against].sort((a, b) => order[a.sev] - order[b.sev]);
  }, [sim.points, sim.takeoffAlt, sim.ending, params, sim.airframe, profile, groundKnown, real, beyond, terrain, fenceFindings, linked, sync.known, sync.same, payloadFindings, deliveries.length, payload, away]);
  const [allAlt, setAllAlt] = useState(30);
  const [tab, setTab] = useState<"plan" | "fence" | "predict">("plan");
  const [drawing, setDrawing] = useState<FenceDrawing | null>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const [fenceReading, setFenceReading] = useState(false);
  const [fenceSending, setFenceSending] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "fence") setDrawing(null);
  }, [tab]);

  const finishDrawing = () => {
    const d = drawingRef.current;
    if (!d || d.shape !== "polygon" || d.points.length < 3) return;
    fence.addZone({ id: zoneId(), shape: "polygon", role: d.role, points: d.points });
    setDrawing(null);
  };

  /** A click on the map while a zone is being drawn. */
  const placeCorner = (n: number, e: number) => {
    const d = drawingRef.current;
    if (!d) return;
    const at = snap(toGlobal(sim.home, n, e));
    if (d.shape === "circle") {
      if (!d.points.length) setDrawing({ ...d, points: [at] });
      else {
        const r = Math.max(1, Math.round(distanceM(d.points[0], at)));
        fence.addZone({ id: zoneId(), shape: "circle", role: d.role, centre: d.points[0], radiusM: r });
        setDrawing(null);
      }
      return;
    }
    setDrawing({ ...d, points: [...d.points, at] });
  };

  const fenceLayer = useMemo<FenceLayer>(() => {
    const drag = (phase: DragPhase, apply: (record: boolean) => void) => {
      if (phase === "start") fence.begin();
      else apply(false);
    };
    return {
      zones: fence.zones,
      selected: fence.selected,
      // A zone is drawn dashed for its own faults, not for a route that crosses it.
      bad: fenceFindings.filter((x) => x.sev === "bad" && x.zone && x.scope === "fence").map((x) => x.zone!),
      drawing,
      editing: tab === "fence",
      onSelect: (id) => fence.select(id),
      onVertex: (id, i, to, phase) => drag(phase, (record) => fence.moveVertex(id, i, to, record)),
      onInsert: (id, i, at) => fence.insertVertex(id, i, at),
      onRemoveVertex: (id, i) => fence.removeVertex(id, i),
      onCentre: (id, to, phase) => drag(phase, (record) => fence.updateZone(id, { centre: snap(to) }, record)),
      onRadius: (id, r, phase) => drag(phase, (record) => fence.updateZone(id, { radiusM: r }, record)),
      onClose: finishDrawing,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fence.zones, fence.selected, fenceFindings, drawing, tab]);

  // The circle round home is drawn while it is in use, or while the fence is being edited.
  const showCircle = isFlag(fence.limits.FENCE_TYPE, FENCE_TYPE.CIRCLE) && (fence.limits.FENCE_ENABLE >= 1 || tab === "fence");
  const circleRadius = showCircle ? fence.limits.FENCE_RADIUS : null;

  // Read the aircraft's fence once per link, when its settings are in.
  const fenceAsked = useRef(false);
  useEffect(() => {
    if (!linked) {
      fenceAsked.current = false;
      useFence.getState().forgetAircraft();
      return;
    }
    if (unread || fenceAsked.current) return;
    fenceAsked.current = true;
    setFenceReading(true);
    readFence()
      .then((got) => {
        const st = useFence.getState();
        if (st.edited) {
          st.adopt(got, false);
          return;
        }
        const changes = !fenceSync({ zones: st.zones, limits: st.limits, aircraft: got }).same;
        st.adopt(got, true);
        if (changes) notify("info", "Fence read from the aircraft", `${got.zones.length ? `${got.zones.length} ${got.zones.length === 1 ? "zone" : "zones"}` : "No zones"}, and its fence is ${got.limits.FENCE_ENABLE >= 1 ? "on" : "off"}. The Fence tab shows it.`);
      })
      .catch((e: Error) => {
        fenceAsked.current = false;
        notify("warn", "The aircraft's fence could not be read", e.message);
      })
      .finally(() => setFenceReading(false));
  }, [linked, unread]);

  const fenceBlock = (() => {
    if (!linked) return "Link an aircraft first";
    if (unread) return "Reading the aircraft's settings first";
    const l = useLink.getState();
    if (!l.virtual && l.vehicle?.armed) return "Disarm before changing the fence";
    return vehicleBlock()?.title ?? null;
  })();

  const sendTheFence = async () => {
    const draft = { zones: fence.zones, limits: fence.limits };
    const bad = fenceFindings.filter((x) => x.sev === "bad");
    if (!virtual) {
      const L = draft.limits;
      const parts = [
        L.FENCE_ENABLE >= 1 ? "The fence will be ON" : "The fence will be OFF",
        isFlag(L.FENCE_TYPE, FENCE_TYPE.ALT_MAX) ? `ceiling ${L.FENCE_ALT_MAX} m` : "",
        isFlag(L.FENCE_TYPE, FENCE_TYPE.ALT_MIN) ? `floor ${L.FENCE_ALT_MIN} m` : "",
        isFlag(L.FENCE_TYPE, FENCE_TYPE.CIRCLE) ? `${L.FENCE_RADIUS} m from home` : "",
        isFlag(L.FENCE_TYPE, FENCE_TYPE.POLYGON) ? `${draft.zones.length} ${draft.zones.length === 1 ? "zone" : "zones"}` : "",
      ].filter(Boolean);
      const ok = await confirmAction({
        title: "Send this fence to your aircraft?",
        body: `${parts.join(", ")}, margin ${L.FENCE_MARGIN} m. It replaces the aircraft's fence: its zones and its FENCE_ settings. The zones are read back and checked before the fence is turned on.${bad.length ? ` The fence check found ${bad.length} ${bad.length === 1 ? "problem" : "problems"}: ${bad[0].text}` : ""}`,
        confirmLabel: "Send the fence",
        tone: bad.length ? "danger" : "default",
      });
      if (!ok) return;
    }
    setFenceSending("Sending…");
    try {
      const got = await sendFence(draft, (step) => setFenceSending(`${step}…`));
      fence.synced(got);
      notify("success", "Fence sent and checked", `The ${virtual ? "virtual " : ""}aircraft holds ${got.zones.length ? `${got.zones.length} ${got.zones.length === 1 ? "zone" : "zones"}` : "no zones"} and the settings sent, read back the same. The fence is ${got.limits.FENCE_ENABLE >= 1 ? "on" : "off"}.`);
    } catch (e) {
      notify("error", "The fence was not sent", `${(e as Error).message} What the aircraft holds now is shown once it is read again.`);
      // What it holds now is not known: read it again rather than guess.
      useFence.getState().forgetAircraft();
      fenceAsked.current = false;
      readFence()
        .then((got) => useFence.getState().adopt(got, false))
        .catch(() => undefined);
    } finally {
      setFenceSending(null);
    }
  };

  const readTheFence = async () => {
    setFenceReading(true);
    try {
      const got = await readFence();
      fence.adopt(got, true);
      notify("success", "Fence read from the aircraft", `${got.zones.length ? `${got.zones.length} ${got.zones.length === 1 ? "zone" : "zones"}` : "No zones"}; the fence is ${got.limits.FENCE_ENABLE >= 1 ? "on" : "off"}. Undo brings back the one that was here.`);
    } catch (e) {
      notify("error", "The fence could not be read", (e as Error).message);
    } finally {
      setFenceReading(false);
    }
  };

  const wrapRoute = () => {
    const pad = Math.max(20, marginXY(fence.limits, fenceOther) * 3 + 10);
    fence.addZone({ id: zoneId(), shape: "polygon", role: "in", points: aroundRoute(sim.home, sim.points, pad) });
    notify("success", "Keep-in area drawn round the route", `${Math.round(pad)} m clear of home and every waypoint. Drag its corners to fit the field.`);
  };
  const fileBox = useRef<HTMLInputElement>(null);

  const moveHome = (to: LatLon) => {
    sim.moveHome(to);
    setResult(null);
  };

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const finishRef = useRef(finishDrawing);
  finishRef.current = finishDrawing;
  // Ctrl or ⌘ Z, and Shift with it or Ctrl Y to go forward again. Not while typing: a box has its own undo.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
      // Drawing a zone: Enter closes it, Backspace takes back a corner, Escape gives up.
      const d = drawingRef.current;
      if (d && !typing && !e.ctrlKey && !e.metaKey) {
        if (e.key === "Escape") setDrawing(null);
        else if (e.key === "Enter") finishRef.current();
        else if (e.key === "Backspace") setDrawing({ ...d, points: d.points.slice(0, -1) });
        else return;
        e.preventDefault();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || typing) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      // Undo follows the tab: the fence's own history on the Fence tab.
      const s = tabRef.current === "fence" ? useFence.getState() : useSim.getState();
      if (k === "y" || e.shiftKey) s.redo();
      else s.undo();
      setResult(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  /** The weight and hang of a delivery already planned at a place, which a mission read back does not carry. */
  const knownPayload = (n: number, e: number) => {
    const p = sim.points.find((x) => x.delivery && Math.hypot(x.n - n, x.e - e) < 2);
    return p?.delivery ? { kg: p.delivery.kg, hangM: p.delivery.hangM } : null;
  };

  /** Puts a mission, from the aircraft or a file, into the planner, and says what did not fit. */
  const adopt = (got: ReadPlan, from: string) => {
    if (!got.points.length && got.takeoffAlt === null) {
      notify("warn", `${from} holds no mission`, "There was nothing to load, so the plan here is unchanged.");
      return;
    }
    sim.loadPlan({ takeoffAlt: got.takeoffAlt ?? sim.takeoffAlt, points: got.points, ending: got.ending, ...(got.home && !simWorld ? { home: got.home } : {}) });
    setResult(null);
    const what = `${got.points.length} ${got.points.length === 1 ? "waypoint" : "waypoints"} loaded. Undo brings the old plan back.`;
    if (got.notes.length) notify("warn", `Loaded from ${from.toLowerCase()}, with changes`, `${got.notes.join(" ")} ${what}`);
    else notify("success", `Loaded from ${from.toLowerCase()}`, what);
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      // With the virtual aircraft flying, home stays where it is and the waypoints keep their places on the ground.
      const items = fromWaypointFile(await file.text());
      const got = missionToPlan(items, sim.home, terrain.surface, knownPayload);
      if (got.home && simWorld) {
        const ref = got.home;
        got.points = got.points.map((w) => {
          const g = toGlobal(ref, w.n, w.e);
          const l = toLocal(sim.home, g.lat, g.lon);
          return { ...w, n: Math.round(l.n), e: Math.round(l.e) };
        });
      }
      adopt(got, "The file");
    } catch (e) {
      notify("error", "That file could not be opened", (e as Error).message);
    }
  };

  const saveFile = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    saveText(`aeronex-plan-${stamp}.waypoints`, toWaypointFile(mission));
    notify("success", "Plan saved", "The file opens here, in Mission Planner and in QGroundControl.");
  };

  const send = async () => {
    // A delivery's heights are measured from the ground under it. Not knowing it is not a warning: the aircraft could be sent into a hillside.
    const blind = deliveries.find((x) => x.ground === null);
    if (blind) {
      notify("error", "The mission was not sent", `The ground's height under waypoint ${blind.wp} is not known, and its delivery's heights are measured from it. Wait for the ground heights to load, or move the waypoint within them.`);
      return;
    }
    if (!virtual) {
      // The last look before a real aircraft is told where to go.
      const highest = Math.max(sim.takeoffAlt, ...sim.points.map((w) => w.alt));
      const bad = checks.filter((c) => c.sev === "bad");
      const ok = await confirmAction({
        title: `Send this mission to your aircraft?`,
        body: `${sim.points.length} ${sim.points.length === 1 ? "waypoint" : "waypoints"}, ${far(farthest)} from home at the farthest, up to ${Math.round(highest)} m above home, ending with ${sim.ending === "rtl" ? "a return home" : sim.ending === "land" ? "a landing at the last waypoint" : "a hover at the last waypoint"}.${deliveries.length ? ` It lets go of ${deliveries.length === 1 ? "a payload" : `${deliveries.length} payloads`} at ${deliveries.length === 1 ? "waypoint" : "waypoints"} ${deliveries.map((x) => x.wp).join(", ")}: load ${deliveries.length === 1 ? "it" : "them"} and close the release before arming.` : ""} It replaces the mission the aircraft holds now.${bad.length ? ` The plan check found ${bad.length} ${bad.length === 1 ? "problem" : "problems"}: ${bad[0].text}` : ""}${homeSource === "aircraft" ? "" : " The aircraft has no GPS position yet, so home here is where you placed it, not where the aircraft is. Heights are counted from where it takes off."}${sync.known && !sync.same ? " The fence on the Fence tab differs from the aircraft's and is not sent with the mission." : ""}`,
        confirmLabel: "Send the mission",
        tone: bad.length || farthest > 2000 || homeSource !== "aircraft" ? "danger" : "default",
      });
      if (!ok) return;
    }
    await order("Send the mission", async () => {
      let sendError: Error | null = null;
      await commandLink.uploadMission(mission).catch((e: Error) => {
        // Over a poor link the aircraft's "got it" can be the message that is lost. A refusal is final;
        // silence is not: the read-back below decides.
        if (!/stopped answering/.test(e.message)) throw e;
        sendError = e;
      });
      // What matters is what the aircraft holds, so it is read back and compared.
      const differs = await commandLink.verifyMission(mission).catch((e: Error) => {
        throw sendError ?? e;
      });
      if (differs && sendError) throw sendError;
      if (differs) throw new Error(`The mission was sent, but the aircraft does not hold what was sent. ${differs} Send it again, and do not fly until it reads back the same.`);
      useSentMission.getState().set(steps);
      notify("success", "Mission sent and checked", `${mission.length - 1} commands are on the ${virtual ? "virtual " : ""}aircraft, and reading them back gave the same mission.`);
    });
  };

  const read = () =>
    order("Read the mission", async () => {
      const items = await commandLink.downloadMission();
      const known = useLink.getState().telemetry.home?.value;
      adopt(missionToPlan(items, known ? { ...known } : sim.home, terrain.surface, knownPayload), "The aircraft");
    });

  const flyNow = () =>
    order("Fly the mission", async () => {
      // These arm and fly with one press. Only the virtual aircraft is ever flown from a button like this, whatever put the button on screen.
      if (!useLink.getState().virtual) throw new Error("This flies the virtual aircraft only. A real aircraft is linked: fly it from your transmitter.");
      await commandLink.uploadMission(mission);
      useSentMission.getState().set(steps);
      // Hang the payloads on the virtual aircraft, as if loaded on the ground. Its own gripper and servo settings decide whether they let go.
      linkManager.sim?.loadPayloads(payloads, false);
      const g = await commandLink.setMode(COPTER_MODE.GUIDED);
      if (g !== 0) return g;
      const a = await commandLink.arm(true);
      if (a !== 0) return a;
      const m = await commandLink.setMode(COPTER_MODE.AUTO);
      if (m !== 0) return m;
      const r = await commandLink.startMission();
      if (r === 0) nav("/simulator");
      return r;
    });

  const run = () => {
    setBusy(true);
    // Let the button repaint before a second of arithmetic.
    window.setTimeout(() => {
      try {
        const faults: FaultPlan[] =
          fault === "none"
            ? []
            : [{ kind: fault, motor: motor.n, level: motor.level / 100, at: faultAt.by === "time" ? { time: faultAt.value } : { waypoint: faultAt.value + 1 } }];
        // Flown with the fence as drawn here: what the aircraft will hold once it is sent.
        setResult(
          predict(
            sim.airframe,
            { ...params, ...fence.limits },
            sim.home,
            mission,
            // With no aircraft's settings, each release is taken to work as planned; otherwise the aircraft's own gripper and servos decide.
            { windSpeed: wind.speed, windFromDeg: wind.from, gust: wind.gust / 100, soc: charge / 100, faults, fence: zonesToWire(fence.zones), payloads, assumeRelease: !fromAircraft, deliveryNames: deliveries.map((x) => `Waypoint ${x.wp}`) },
            7,
            terrain,
          ),
        );
      } catch (e) {
        notify("error", "The prediction failed", (e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const v = result ? VERDICT[result.verdict] : null;

  return (
    <div className="page-pad">
      <header className="page-head">
        <div>
          <h1>Mission Planning</h1>
          <p>Draw the route, check it against the ground, predict the flight, then send it to the aircraft.</p>
        </div>
        <div className="actions">
          <button className="btn" disabled={!linked} onClick={read} title={linked ? undefined : "Connect an aircraft first"}>
            <Download /> Read from aircraft
          </button>
          <button className="btn btn-primary" disabled={!linked || empty || !!gpsBlock || !!unread} onClick={send} title={!linked ? "Connect an aircraft first" : gpsBlock ? gpsBlock.title : unread ? "Reading the aircraft's settings first" : undefined}>
            <Upload /> Send to {virtual ? "virtual aircraft" : "aircraft"}
          </button>
        </div>
      </header>

      {/* The plan in six numbers, so the state of it can be read without reading the page. */}
      <dl className="mp-glance" aria-label="The plan at a glance">
        <div>
          <dt>Waypoints</dt>
          <dd>
            {sim.points.length}
            {deliveries.length > 0 && (
              <small title={`${deliveries.length === 1 ? "A payload" : `${deliveries.length} payloads`}, ${carriedKg.toFixed(carriedKg < 10 ? 2 : 0)} kg in all`}>
                {deliveries.length === 1 ? "1 delivery" : `${deliveries.length} deliveries`}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>{empty ? "–" : length >= 1000 ? <>{(length / 1000).toFixed(2)}<small>km</small></> : <>{Math.round(length)}<small>m</small></>}</dd>
        </div>
        <div title="Take-off, the legs at cruise speed, the waits and the landing. The prediction gives the real figure.">
          <dt>Flight time, about</dt>
          <dd>{empty ? "–" : clock(flightSeconds({ points: sim.points, takeoffAlt: sim.takeoffAlt, ending: sim.ending, params, profile, ground: terrain.surface }))}</dd>
        </div>
        <div>
          <dt>Highest point</dt>
          <dd>{Math.round(Math.max(sim.takeoffAlt, ...sim.points.map((w) => w.alt)))}<small>m above home</small></dd>
        </div>
        <div title="The closest the whole route comes to the ground, not only at the waypoints.">
          <dt>Closest to the ground</dt>
          <dd className={!profile.lowest || !groundKnown ? "na" : profile.lowest.clear < 0 ? "bad" : profile.lowest.clear < CLEAR_WARN ? "warn" : undefined}>
            {!profile.lowest ? "–" : !groundKnown ? "not known" : <>{Math.round(profile.lowest.clear)}<small>m</small></>}
          </dd>
        </div>
        <div title={fmtLatLon(sim.home)}>
          <dt>Home</dt>
          <dd className="word">{simWorld ? "Virtual aircraft" : homeSource === "aircraft" ? "Aircraft GPS" : homeSource === "waiting" ? "Waiting for GPS" : real ? "Placed by you" : "Practice field"}</dd>
        </div>
      </dl>

      <div className="mp-grid">
        <section className="panel mp-map">
          <div className="panel-head">
            <h2 className="h3">Route</h2>
            <div className="segmented mp-world" role="group" aria-label="What the route is drawn on" title={simWorld ? "The virtual aircraft is flying in this world. Stop it to change." : undefined}>
              <button aria-pressed={real} disabled={!!simWorld} onClick={() => { sim.set("terrain", "real"); setResult(null); }}>
                <Globe /> Real map
              </button>
              <button aria-pressed={!real} disabled={!!simWorld} onClick={() => { sim.set("terrain", lastField.current); setResult(null); }}>
                <LandPlot /> Practice field
              </button>
            </div>
          </div>
          {unread && !gpsBlock && (
            <div className="callout info mp-away" role="status">
              <Info />
              <span>
                <strong>Reading the aircraft's settings{unread.count ? `: ${unread.received} of ${unread.count}` : ""}.</strong> The return-home height, speeds, fence and battery failsafe are the aircraft's own. The
                checks here use them, so the mission can be sent once they are all read.
              </span>
            </div>
          )}
          {gpsBlock && (
            <div className="callout warn mp-away" role="status">
              <SatelliteDish />
              <span>
                <strong>{gpsBlock.title}.</strong> {gpsBlock.body} You can still plan, predict and fly it in the simulator.
              </span>
            </div>
          )}
          {real ? (
            <Suspense fallback={<div className="rmap rmap-loading">Loading the map…</div>}>
              <RealMap
                home={sim.home}
                route={route}
                closeRoute={sim.ending === "rtl"}
                ghost={result?.track}
                fenceRadius={circleRadius}
                fenceLayer={fenceLayer}
                wind={windShown}
                mark={mark}
                low={low}
                homeLocked={!!simWorld || homeSource === "aircraft"}
                onPick={(n, e) => {
                  if (tab === "fence") return placeCorner(n, e);
                  sim.addPoint(n, e);
                  setResult(null);
                }}
                onMovePoint={(id, n, e) => {
                  sim.updatePoint(id, { n: Math.round(n), e: Math.round(e) });
                  setResult(null);
                }}
                onMoveHome={moveHome}
              />
            </Suspense>
          ) : (
            <FlightMap
              route={route}
              closeRoute={sim.ending === "rtl"}
              ghost={result?.track}
              boxes={result?.bodies.map((b) => ({ id: b.id, n: b.pos[0], e: b.pos[1], state: b.state }))}
              fenceRadius={circleRadius}
              origin={sim.home}
              fenceLayer={fenceLayer}
              wind={windShown}
              mark={mark}
              terrain={terrain}
              onPick={(n, e) => {
                if (tab === "fence") return placeCorner(n, e);
                sim.addPoint(n, e);
                setResult(null);
              }}
              minSpan={80}
            />
          )}
          {real && !simWorld && dem.status === "error" && (
            <div className="callout warn mp-away" role="status">
              <TriangleAlert />
              <span>
                <strong>The ground heights could not be loaded.</strong> {dem.error} Until they are, clearances and predictions here assume level ground.
              </span>
              <button className="btn btn-sm" onClick={() => void ensureDem(sim.home, reach).catch(() => undefined)}>
                Try again
              </button>
            </div>
          )}
          {groundKnown && (
            <HeightProfile
              profile={profile}
              real={real}
              loading={real && !simWorld && dem.status === "loading"}
              drops={deliveries.flatMap((x) => (x.ground === null ? [] : [{ wp: x.wp, from: x.cruise, to: x.ground + (x.delivery.method === "drop" ? x.delivery.heightM : x.delivery.hangM) }]))}
            />
          )}
        </section>

        <div className="stack">
          {/* One thing at a time beside the map: the plan, or the prediction of it. */}
          <div className="mp-tabs" role="tablist" aria-label="Plan, fence or prediction">
            <button role="tab" id="mp-tab-plan" aria-selected={tab === "plan"} aria-controls="mp-plan" onClick={() => setTab("plan")}>
              <ListChecks /> Plan
              {checks.some((c) => c.sev === "bad") ? <i className="mp-dot bad" title="The plan check found a problem" /> : checks.some((c) => c.sev === "warn") ? <i className="mp-dot warn" title="The plan check has warnings" /> : null}
            </button>
            <button role="tab" id="mp-tab-fence" aria-selected={tab === "fence"} aria-controls="mp-fence" onClick={() => setTab("fence")}>
              <Shield /> Fence
              {fenceFindings.some((c) => c.sev === "bad") ? <i className="mp-dot bad" title="The fence check found a problem" /> : linked && sync.known && !sync.same ? <i className="mp-dot warn" title="Not sent to the aircraft" /> : fenceFindings.some((c) => c.sev === "warn") ? <i className="mp-dot warn" title="The fence check has warnings" /> : null}
            </button>
            <button role="tab" id="mp-tab-predict" aria-selected={tab === "predict"} aria-controls="mp-predict" onClick={() => setTab("predict")}>
              <FlaskConical /> Predict
              {result && v ? <i className={`mp-dot ${v.tone}`} title={v.title} /> : null}
            </button>
          </div>
          <section className="panel" id="mp-plan" role="tabpanel" aria-labelledby="mp-tab-plan" hidden={tab !== "plan"}>
            <div className="panel-head">
              <h2 className="h3">Plan</h2>
              <div className="mp-tools" role="group" aria-label="Plan tools">
                <button className="icon-btn" disabled={!sim.canUndo} onClick={() => { sim.undo(); setResult(null); }} aria-label="Undo" title="Undo (Ctrl Z)">
                  <Undo2 />
                </button>
                <button className="icon-btn" disabled={!sim.canRedo} onClick={() => { sim.redo(); setResult(null); }} aria-label="Redo" title="Redo (Ctrl Shift Z)">
                  <Redo2 />
                </button>
                <button className="icon-btn" onClick={() => fileBox.current?.click()} aria-label="Open a plan file" title="Open a plan file (.waypoints), from here, Mission Planner or QGroundControl">
                  <FolderOpen />
                </button>
                <button className="icon-btn" disabled={empty} onClick={saveFile} aria-label="Save the plan to a file" title="Save the plan to a file that Mission Planner and QGroundControl also open">
                  <Save />
                </button>
                <button
                  className="icon-btn"
                  disabled={empty}
                  onClick={() => {
                    sim.clearPoints();
                    setResult(null);
                  }}
                  aria-label="Remove every waypoint"
                  title="Remove every waypoint (Undo brings them back)"
                >
                  <Trash2 />
                </button>
                <input
                  ref={fileBox}
                  type="file"
                  accept=".waypoints,.txt,.mission"
                  hidden
                  onChange={(e) => {
                    void openFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            <div className="panel-body mp-plan">
              {empty ? (
                <p className="mp-empty">
                  {real
                    ? "Click the map to place the first waypoint. Home is the H. Link your aircraft and home goes to its GPS position by itself; with no aircraft, press the home button on the map and click where it will take off."
                    : "Click the map to place the first waypoint. Home is the H in the middle; the grid is in metres."}
                </p>
              ) : (
                <table className={`mp-table${real ? " real" : ""}`}>
                  <thead>
                    <tr>
                      <th>#</th>
                      {real ? (
                        <th colSpan={2}>Latitude, longitude</th>
                      ) : (
                        <>
                          <th>North (m)</th>
                          <th>East (m)</th>
                        </>
                      )}
                      <th>Height (m)</th>
                      <th title="Height of the waypoint above the ground beneath it">Clear (m)</th>
                      <th>Wait (s)</th>
                      <th aria-label="Move or remove" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="mp-cmd">
                      <td className="c-n">
                        <PlaneTakeoff aria-label="Take off" />
                      </td>
                      <td className="c-what" colSpan={2}>
                        <strong>Take off</strong>
                        <small>Straight up from home</small>
                      </td>
                      <td className="c-h" data-label="Height (m)">
                        <NumCell label="Take-off height" value={sim.takeoffAlt} min={2} max={500} onChange={(x) => sim.set("takeoffAlt", x)} />
                      </td>
                      <td className="c-rest" colSpan={3} />
                    </tr>
                    {sim.points.map((p, i) => {
                      const ground = terrain.surface(p.n, p.e);
                      const known = loaded && !(terrain.reach !== undefined && Math.max(Math.abs(p.n), Math.abs(p.e)) > terrain.reach);
                      return (
                        <Fragment key={p.id}>
                        <tr className={`mp-wp${p.delivery ? " has-delivery" : ""}`}>
                          <td className="num c-n">{i + 1}</td>
                          {real ? (
                            <td colSpan={2} className="num mp-pos c-pos" title={`${Math.round(Math.hypot(p.n, p.e))} m from home. Drag its marker on the map to move it.`}>
                              {fmtLatLon(toGlobal(sim.home, p.n, p.e))}
                            </td>
                          ) : (
                            <>
                              <td className="c-north" data-label="North (m)"><NumCell label={`Waypoint ${i + 1} north`} value={p.n} min={-20000} max={20000} onChange={(x) => sim.updatePoint(p.id, { n: x })} /></td>
                              <td className="c-east" data-label="East (m)"><NumCell label={`Waypoint ${i + 1} east`} value={p.e} min={-20000} max={20000} onChange={(x) => sim.updatePoint(p.id, { e: x })} /></td>
                            </>
                          )}
                          <td className="c-h" data-label="Height (m)"><NumCell label={`Waypoint ${i + 1} height`} value={p.alt} min={2} max={500} onChange={(x) => sim.updatePoint(p.id, { alt: x })} /></td>
                          {known ? (
                            <td className={`num mp-clear c-clear${p.alt - ground < 10 ? " low" : ""}`} data-label="Clear (m)" title={`The ground here is ${ground.toFixed(0)} m above home`}>
                              {terrain.isWater(p.n, p.e) ? "water" : Math.round(p.alt - ground)}
                            </td>
                          ) : (
                            <td className="num mp-clear c-clear" data-label="Clear (m)" title={loaded ? "Too far from home: the ground heights do not reach here" : "The ground heights are still loading"}>
                              {loaded ? "?" : "…"}
                            </td>
                          )}
                          <td className="c-wait" data-label="Wait (s)"><NumCell label={`Waypoint ${i + 1} wait`} value={p.holdS} min={0} max={600} onChange={(x) => sim.updatePoint(p.id, { holdS: x })} /></td>
                          <td className="c-act">
                            <div className="mp-acts">
                            <button
                              className={`icon-btn mp-deliver-btn${p.delivery ? " on" : ""}`}
                              aria-pressed={!!p.delivery}
                              aria-label={p.delivery ? `Stop delivering a payload at waypoint ${i + 1}` : `Deliver a payload at waypoint ${i + 1}`}
                              title={p.delivery ? "Remove the delivery here (Undo brings it back)" : "Deliver a payload here: drop it, or lower it to the ground"}
                              onClick={() => {
                                sim.updatePoint(p.id, { delivery: p.delivery ? undefined : newDelivery("drop", defaultRelease()) });
                                setResult(null);
                              }}
                            >
                              <Package />
                            </button>
                            <button className="icon-btn" disabled={i === 0} aria-label={`Move waypoint ${i + 1} earlier`} title="Fly this one earlier" onClick={() => { sim.shiftPoint(p.id, -1); setResult(null); }}>
                              <ArrowUp />
                            </button>
                            <button className="icon-btn" disabled={i === sim.points.length - 1} aria-label={`Move waypoint ${i + 1} later`} title="Fly this one later" onClick={() => { sim.shiftPoint(p.id, 1); setResult(null); }}>
                              <ArrowDown />
                            </button>
                            <button className="icon-btn" aria-label={`Remove waypoint ${i + 1}`} title="Remove" onClick={() => { sim.removePoint(p.id); setResult(null); }}>
                              <X />
                            </button>
                            </div>
                          </td>
                        </tr>
                        {p.delivery && (
                          <DeliveryRow
                            wp={i + 1}
                            delivery={p.delivery}
                            cruise={p.alt}
                            ground={groundAt(p.n, p.e)}
                            options={payload.options}
                            port={payload.port}
                            params={params}
                            onChange={(d) => {
                              sim.updatePoint(p.id, { delivery: d });
                              setResult(null);
                            }}
                            onRemove={() => {
                              sim.updatePoint(p.id, { delivery: undefined });
                              setResult(null);
                            }}
                          />
                        )}
                        </Fragment>
                      );
                    })}
                    {/* The last command, as a row of its own, so the list is the whole mission. */}
                    <tr className={`mp-cmd end ${sim.ending}`}>
                      <td className="c-n">{sim.ending === "rtl" ? <HomeIcon aria-hidden /> : sim.ending === "land" ? <PlaneLanding aria-hidden /> : <CirclePause aria-hidden />}</td>
                      <td className="c-what" colSpan={6}>
                        <strong>{sim.ending === "rtl" ? "Return home and land" : sim.ending === "land" ? `Land at waypoint ${sim.points.length}` : `Hover at waypoint ${sim.points.length}`}</strong>
                        <small>
                          {sim.ending === "rtl"
                            ? `Flies back to home at ${(params.RTL_ALT / 100).toFixed(0)} m or its own height if higher, then lands.`
                            : sim.ending === "land"
                              ? "Descends and lands where the last waypoint is, away from home."
                              : "Stays in the air there until you take over. Nothing lands it."}
                        </small>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
              {empty && (
                <div className="mp-line">
                  <span className="mp-step">Take off to</span>
                  <NumCell label="Take-off height" value={sim.takeoffAlt} min={2} max={500} onChange={(x) => sim.set("takeoffAlt", x)} />
                  <span className="muted">m</span>
                </div>
              )}
              <div className="mp-line">
                <span className="mp-step">At the end</span>
                <div className="segmented" role="group" aria-label="How the mission ends">
                  {(
                    [
                      ["rtl", "Return home and land"],
                      ["land", "Land where it is"],
                      ["hold", "Hover there"],
                    ] as [Ending, string][]
                  ).map(([k, l]) => (
                    <button key={k} aria-pressed={sim.ending === k} onClick={() => { sim.set("ending", k); setResult(null); }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {sim.points.length > 1 && (
                <div className="mp-line">
                  <span className="mp-step">Every height</span>
                  <NumCell label="Height for every waypoint" value={allAlt} min={2} max={500} onChange={setAllAlt} />
                  <span className="muted">m</span>
                  <button className="btn btn-sm" onClick={() => { sim.setAllHeights(allAlt); setResult(null); }}>
                    Set all waypoints
                  </button>
                </div>
              )}
              {!empty && (
                <div className="mp-check" aria-live="polite">
                  <h4>Plan check</h4>
                  {checks.some((c) => c.sev !== "note") ? null : (
                    <p className="mp-check-ok">
                      <CircleCheck aria-hidden /> Nothing wrong that can be seen from the numbers. Predict the flight to see how it goes.
                    </p>
                  )}
                  <ul>
                    {checks.map((c) => (
                      <li key={c.text} className={c.sev}>
                        {c.sev === "bad" ? <CircleX aria-hidden /> : c.sev === "warn" ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
                        <span>{c.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          <section className="panel" id="mp-fence" role="tabpanel" aria-labelledby="mp-tab-fence" hidden={tab !== "fence"}>
            <div className="panel-head">
              <h2 className="h3">Geofence</h2>
            </div>
            <FencePanel
              home={sim.home}
              findings={fenceFindings}
              drawing={drawing}
              onDraw={setDrawing}
              onFinish={finishDrawing}
              canWrapRoute={sim.points.length > 0}
              onWrapRoute={wrapRoute}
              linked={linked}
              virtual={virtual}
              sendBlock={fenceBlock}
              reading={fenceReading}
              sending={fenceSending}
              onSend={() => void sendTheFence()}
              onRead={() => void readTheFence()}
            />
          </section>

          <section className="panel" id="mp-predict" role="tabpanel" aria-labelledby="mp-tab-predict" hidden={tab !== "predict"}>
            <div className="panel-head">
              <h2 className="h3">Predict this flight</h2>
            </div>
            <div className="panel-body mp-predict">
              <p className="mp-source">
                Flies <strong>{sim.airframe.name}</strong> ({sim.airframe.massKg} kg, {sim.airframe.cells}S {sim.airframe.capacityMah} mAh) on {source}.{" "}
                <Link to="/simulator">Change the aircraft</Link>
              </p>
              <div className="mp-fields">
                <label className="field">
                  <span>Wind (m/s)</span>
                  <NumCell label="Wind speed" value={wind.speed} min={0} max={30} onChange={(x) => setWind({ ...wind, speed: x })} />
                </label>
                <label className="field">
                  <span>From (°)</span>
                  <NumCell label="Wind direction" value={wind.from} min={0} max={359} onChange={(x) => setWind({ ...wind, from: x })} />
                </label>
                <label className="field">
                  <span>Gusts (%)</span>
                  <NumCell label="Gust strength" value={wind.gust} min={0} max={100} onChange={(x) => setWind({ ...wind, gust: x })} />
                </label>
                <label className="field">
                  <span>Battery (%)</span>
                  <NumCell label="Battery at take-off" value={charge} min={5} max={100} onChange={setCharge} />
                </label>
              </div>
              <div className="mp-fault">
                <label className="field">
                  <span>What goes wrong</span>
                  <select className="select" value={fault} onChange={(e) => setFault(e.target.value as "none" | FaultKind)}>
                    <option value="none">Nothing</option>
                    <option value="motor">A motor loses thrust</option>
                    <option value="gps">GPS is lost</option>
                    <option value="radio">The radio transmitter is lost</option>
                    <option value="gcs">This app loses the link</option>
                  </select>
                </label>
                {fault !== "none" && (
                  <>
                    <label className="field">
                      <span>When</span>
                      <select className="select" value={faultAt.by} onChange={(e) => setFaultAt({ by: e.target.value as "waypoint" | "time", value: e.target.value === "time" ? 30 : 1 })}>
                        <option value="waypoint">On reaching waypoint</option>
                        <option value="time">Seconds after arming</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{faultAt.by === "waypoint" ? "Waypoint" : "Seconds"}</span>
                      <NumCell label="When the fault happens" value={faultAt.value} min={faultAt.by === "waypoint" ? 1 : 1} max={faultAt.by === "waypoint" ? Math.max(1, sim.points.length) : 2400} onChange={(x) => setFaultAt({ ...faultAt, value: x })} />
                    </label>
                  </>
                )}
                {fault === "motor" && (
                  <>
                    <label className="field">
                      <span>Motor</span>
                      <NumCell label="Which motor" value={motor.n} min={1} max={4} onChange={(x) => setMotor({ ...motor, n: x })} />
                    </label>
                    <label className="field">
                      <span>Thrust left (%)</span>
                      <NumCell label="Thrust left" value={motor.level} min={0} max={95} onChange={(x) => setMotor({ ...motor, level: x })} />
                    </label>
                  </>
                )}
              </div>
              <div className="mp-run">
                <button className="btn btn-primary" disabled={empty || busy} onClick={run}>
                  <FlaskConical /> {busy ? "Flying it…" : "Predict the flight"}
                </button>
                {linked && virtual && (
                  <button className="btn" disabled={empty} onClick={flyNow}>
                    <Play /> Fly it live in the simulator
                  </button>
                )}
              </div>
            </div>
          </section>
          {result && v && tab === "predict" && (
            <section className={`panel mp-result in-col ${v.tone}`} aria-live="polite">
              <div className="mp-verdict">
                {v.tone === "ok" ? <CircleCheck /> : v.tone === "bad" ? <CircleX /> : <TriangleAlert />}
                <div>
                  <h2 className="h3">{v.title}</h2>
                  <p>{result.headline}</p>
                </div>
              </div>
              {result.verdict !== "refused" && result.verdict !== "grounded" && (
                <dl className="readouts mp-stats">
                  <div className="readout"><dt>Flight time</dt><dd>{clock(result.stats.durationS)}</dd></div>
                  <div className="readout"><dt>Distance flown</dt><dd>{result.stats.distanceM >= 1000 ? (result.stats.distanceM / 1000).toFixed(2) : Math.round(result.stats.distanceM)}<small>{result.stats.distanceM >= 1000 ? "km" : "m"}</small></dd></div>
                  <div className="readout"><dt>Battery left</dt><dd className={result.stats.endSoc < 0.2 ? "bad" : undefined}>{Math.round(result.stats.endSoc * 100)}<small>%</small></dd></div>
                  <div className="readout"><dt>Battery used</dt><dd>{Math.round(result.stats.usedMah)}<small>mAh</small></dd></div>
                  <div className="readout"><dt>Lowest voltage</dt><dd>{result.stats.minVolts.toFixed(1)}<small>V</small></dd></div>
                  <div className="readout"><dt>Peak current</dt><dd>{Math.round(result.stats.maxAmps)}<small>A</small></dd></div>
                  <div className="readout"><dt>Top speed</dt><dd>{result.stats.maxSpeed.toFixed(1)}<small>m/s</small></dd></div>
                  <div className="readout"><dt>Steepest lean</dt><dd>{Math.round(result.stats.maxLeanDeg)}<small>°</small></dd></div>
                  <div className="readout"><dt>Peak throttle</dt><dd className={result.stats.maxThrottle > 0.9 ? "bad" : undefined}>{Math.round(result.stats.maxThrottle * 100)}<small>%</small></dd></div>
                  <div className="readout"><dt>Commands done</dt><dd>{result.stats.reached.length}<small>of {result.stats.commands}</small></dd></div>
                </dl>
              )}
              <div className="mp-cols">
                <div>
                  <h4>What it means</h4>
                  <ul className="mp-findings" tabIndex={0} aria-label="What the prediction found">
                    {result.findings.map((f) => (
                      <li key={f.text} className={f.sev}>
                        {f.text}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>What happened, in order</h4>
                  <ol className="mp-timeline">
                    {result.events
                      .filter((e) => e.kind && e.kind !== "prearm")
                      .map((e, i) => (
                        <li key={i} className={e.sev}>
                          <span className="num">{clock(e.t)}</span>
                          {/* The model counts mission items; the reader counts waypoints. */}
                          {inPlanWords(e.text, steps)}
                        </li>
                      ))}
                  </ol>
                </div>
              </div>
              <p className="mp-caveat">
                A prediction from a model of ArduCopter with no obstacles or sensor noise.{" "}
                {real && groundKnown
                  ? "The ground is measured data of about 30 m detail, typically right to 10 m; trees, buildings and wires are not in it."
                  : real
                    ? "The ground heights were not loaded, so it flew over level ground."
                    : "The ground is the practice landscape, not a real place."}{" "}
                The final mode was {MODE_NAME[result.track.at(-1)?.mode ?? 0] ?? "unknown"}.
                Use it to find mistakes in a plan and its settings, not as a promise.
              </p>
            </section>
          )}
        </div>
      </div>

    </div>
  );
}
