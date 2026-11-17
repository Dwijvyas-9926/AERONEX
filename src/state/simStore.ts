import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PRESETS, type Airframe } from "../sim/airframe";
import { CMD, type Home, type MissionItem } from "../sim/autopilot";
import { M_PER_DEG, toGlobal, toLocal, type LatLon } from "../geo/geo";
import type { TerrainKind } from "../sim/terrain";
import { closeCommand, closingBeforeTakeoff, deliveryCommands, findDelivery, releasesUsed, soundDelivery, type Delivery } from "../mission/payload";

/* What the simulator flies and where, and the mission being planned. Kept in
   this browser, so a plan survives a reload. */

export interface PlanPoint {
  id: string;
  /** Metres north and east of home. */
  n: number;
  e: number;
  alt: number;
  /** Seconds to wait there. */
  holdS: number;
  /** A payload let go here, if one is. */
  delivery?: Delivery;
}

export type Ending = "rtl" | "land" | "hold";

interface SimState {
  airframe: Airframe;
  home: Home;
  /** Battery at the start, 0–1. */
  soc: number;
  terrain: TerrainKind;
  /** Start from the parameters last read from a real aircraft, where there are any. */
  useAircraftParams: boolean;
  takeoffAlt: number;
  points: PlanPoint[];
  ending: Ending;
  set: <K extends keyof Omit<SimState, Actions>>(k: K, v: SimState[K]) => void;
  /** Home as the aircraft reports it. Like moveHome, but not a step to undo: it was not the reader's doing. */
  followHome: (to: LatLon, altMsl?: number) => void;
  /** Swaps a waypoint with the one before (-1) or after (1). */
  shiftPoint: (id: string, by: -1 | 1) => void;
  /** Gives every waypoint the same height. */
  setAllHeights: (alt: number) => void;
  /** Replaces the whole plan, as when a file is opened or a mission is read. */
  loadPlan: (plan: Pick<SimState, "takeoffAlt" | "points" | "ending"> & { home?: Home }) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Moves home; the waypoints stay where they are on the ground. */
  moveHome: (to: LatLon, altMsl?: number) => void;
  addPoint: (n: number, e: number) => void;
  updatePoint: (id: string, patch: Partial<PlanPoint>) => void;
  removePoint: (id: string) => void;
  clearPoints: () => void;
}

type Actions = "set" | "addPoint" | "updatePoint" | "removePoint" | "clearPoints" | "moveHome" | "followHome" | "shiftPoint" | "setAllHeights" | "loadPlan" | "undo" | "redo" | "canUndo" | "canRedo";

const uid = () => Math.random().toString(36).slice(2, 9);

/*
  Undo for the plan. A plan is the home point, the take-off height, the
  waypoints and the ending; each change to any of them first puts the plan as
  it was on a stack. Typing in one box is one step, not one per keystroke.
  The stacks live outside the saved state: undo is for this sitting.
*/
type Plan = Pick<SimState, "home" | "takeoffAlt" | "points" | "ending">;
const PLAN_KEYS = new Set(["home", "takeoffAlt", "points", "ending"]);
const past: Plan[] = [];
const future: Plan[] = [];
let lastStep = { what: "", at: 0 };
const planOf = (s: SimState): Plan => ({ home: s.home, takeoffAlt: s.takeoffAlt, points: s.points, ending: s.ending });

function remember(s: SimState, what: string): Pick<SimState, "canUndo" | "canRedo"> {
  const now = Date.now();
  if (!(what === lastStep.what && what.startsWith("edit:") && now - lastStep.at < 1200)) {
    past.push(planOf(s));
    if (past.length > 100) past.shift();
  }
  lastStep = { what, at: now };
  future.length = 0;
  return { canUndo: true, canRedo: false };
}

/** For tests: forget the undo history. */
export function forgetHistory() {
  past.length = 0;
  future.length = 0;
  lastStep = { what: "", at: 0 };
  useSim.setState({ canUndo: false, canRedo: false });
}

export const useSim = create<SimState>()(
  persist(
    (set) => ({
      airframe: PRESETS[0],
      home: { lat: 23.0225, lon: 72.5714, altMsl: 53 },
      soc: 1,
      terrain: "hills",
      useAircraftParams: true,
      takeoffAlt: 20,
      points: [],
      ending: "rtl",
      canUndo: false,
      canRedo: false,
      set: (k, v) =>
        set((s) => {
          // Home's height above the sea arriving with the ground data is not something to undo.
          const step = PLAN_KEYS.has(k) && !(k === "home" && (v as Home).lat === s.home.lat && (v as Home).lon === s.home.lon);
          return { ...(step ? remember(s, `edit:${k}`) : {}), [k]: v } as Partial<SimState>;
        }),
      addPoint: (n, e) => set((s) => ({ ...remember(s, "add"), points: [...s.points, { id: uid(), n: Math.round(n), e: Math.round(e), alt: s.points.at(-1)?.alt ?? s.takeoffAlt, holdS: 0 }] })),
      updatePoint: (id, patch) => set((s) => ({ ...remember(s, `edit:${id}:${Object.keys(patch).join()}`), points: s.points.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removePoint: (id) => set((s) => ({ ...remember(s, "remove"), points: s.points.filter((p) => p.id !== id) })),
      clearPoints: () => set((s) => (s.points.length ? { ...remember(s, "clear"), points: [] } : {})),
      moveHome: (to, altMsl) => set((s) => ({ ...remember(s, "home"), home: { lat: to.lat, lon: to.lon, altMsl: altMsl ?? s.home.altMsl }, points: rehomed(s.home, to, s.points) })),
      followHome: (to, altMsl) => set((s) => ({ home: { lat: to.lat, lon: to.lon, altMsl: altMsl ?? s.home.altMsl }, points: rehomed(s.home, to, s.points) })),
      shiftPoint: (id, by) =>
        set((s) => {
          const i = s.points.findIndex((p) => p.id === id);
          const j = i + by;
          if (i < 0 || j < 0 || j >= s.points.length) return {};
          const points = [...s.points];
          [points[i], points[j]] = [points[j], points[i]];
          return { ...remember(s, "order"), points };
        }),
      setAllHeights: (alt) => set((s) => ({ ...remember(s, "heights"), points: s.points.map((p) => ({ ...p, alt })) })),
      loadPlan: (plan) => set((s) => ({ ...remember(s, "load"), takeoffAlt: plan.takeoffAlt, points: plan.points, ending: plan.ending, ...(plan.home ? { home: plan.home } : {}) })),
      undo: () =>
        set((s) => {
          const was = past.pop();
          if (!was) return {};
          future.push(planOf(s));
          lastStep = { what: "", at: 0 };
          return { ...was, canUndo: past.length > 0, canRedo: true };
        }),
      redo: () =>
        set((s) => {
          const next = future.pop();
          if (!next) return {};
          past.push(planOf(s));
          lastStep = { what: "", at: 0 };
          return { ...next, canUndo: true, canRedo: future.length > 0 };
        }),
    }),
    {
      name: "aeronex.sim.v1",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (old) => ({ terrain: "hills", ...(old as object) }) as SimState,
      // Whether there is something to undo belongs to this sitting, not the saved plan.
      partialize: ({ canUndo: _u, canRedo: _r, ...rest }) => rest,
      merge: (saved, now) => ({ ...now, ...sound(saved as Partial<SimState>, now), canUndo: false, canRedo: false }),
    },
  ),
);

// Declared as functions, not constants: the saved state is read while the store is being made, above.
function num(v: unknown, lo: number, hi: number, otherwise: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : otherwise;
}

/**
 * What was saved in the browser, with anything broken put right. A plan saved
 * by an older version, or damaged by hand, must not stop the app starting.
 */
function sound(saved: Partial<SimState> | undefined, now: SimState): Partial<SimState> {
  if (!saved || typeof saved !== "object") return {};
  const out: Partial<SimState> = { ...saved };
  const h = saved.home as Partial<Home> | undefined;
  out.home = { lat: num(h?.lat, -85, 85, now.home.lat), lon: num(h?.lon, -180, 180, now.home.lon), altMsl: num(h?.altMsl, -500, 9000, now.home.altMsl) };
  out.takeoffAlt = num(saved.takeoffAlt, 2, 500, now.takeoffAlt);
  out.soc = num(saved.soc, 0.05, 1, 1);
  out.ending = saved.ending === "land" || saved.ending === "hold" ? saved.ending : "rtl";
  out.terrain = (["flat", "hills", "highlands", "real"] as const).includes(saved.terrain as TerrainKind) ? saved.terrain : now.terrain;
  out.points = (Array.isArray(saved.points) ? saved.points : [])
    .filter((p) => p && Number.isFinite(p.n) && Number.isFinite(p.e))
    .map((p) => {
      const delivery = soundDelivery(p.delivery);
      return { id: typeof p.id === "string" ? p.id : uid(), n: p.n, e: p.e, alt: num(p.alt, 2, 500, 20), holdS: num(p.holdS, 0, 600, 0), ...(delivery ? { delivery } : {}) };
    });
  const a = saved.airframe as Partial<Airframe> | undefined;
  if (!a || !(a.massKg! > 0) || !(a.motorMaxThrustN! > 0) || !(a.capacityMah! > 0) || !(a.cells! > 0) || !(a.diagonalM! > 0) || !(a.propDiaM! > 0)) out.airframe = now.airframe;
  return out;
}

/** The same waypoints, measured from a new home: each stays over the same ground. */
export function rehomed(from: LatLon, to: LatLon, points: PlanPoint[]): PlanPoint[] {
  return points.map((p) => {
    const g = toGlobal(from, p.n, p.e);
    const l = toLocal(to, g.lat, g.lon);
    return { ...p, n: Math.round(l.n), e: Math.round(l.e) };
  });
}

/**
 * The plan as MAVLink mission items.
 *
 * Item 0 is home, as ArduPilot expects; then the payload releases closed,
 * a take-off, the waypoints, and the ending. Altitudes are relative to home
 * (frame 3). A waypoint with a delivery becomes the sequence that flies it
 * (deliveryCommands); `ground` gives the ground's height above home there,
 * which its release height is measured from.
 */
export function planToMission(home: Home, takeoffAlt: number, points: PlanPoint[], ending: Ending, ground: (n: number, e: number) => number = () => 0): MissionItem[] {
  const ll = (n: number, e: number) => ({
    x: Math.round((home.lat + n / M_PER_DEG) * 1e7),
    y: Math.round((home.lon + e / (M_PER_DEG * Math.cos((home.lat * Math.PI) / 180))) * 1e7),
  });
  const z = { p1: 0, p2: 0, p3: 0, p4: 0 };
  const items: MissionItem[] = [{ seq: 0, frame: 0, command: CMD.WAYPOINT, ...z, ...ll(0, 0), z: home.altMsl }];
  const push = (it: Omit<MissionItem, "seq">) => items.push({ ...it, seq: items.length });
  // Every release starts closed, whatever was last done to it on the ground.
  for (const r of releasesUsed(points.flatMap((p) => (p.delivery ? [p.delivery] : [])))) push(closeCommand(r));
  push({ frame: 3, command: CMD.TAKEOFF, ...z, x: 0, y: 0, z: takeoffAlt });
  for (const p of points) {
    if (p.delivery) for (const it of deliveryCommands(p.delivery, ll(p.n, p.e), p.alt, ground(p.n, p.e), p.holdS)) push(it);
    else push({ frame: 3, command: CMD.WAYPOINT, ...z, p1: p.holdS, ...ll(p.n, p.e), z: p.alt });
  }
  if (ending === "rtl") push({ frame: 3, command: CMD.RTL, ...z, x: 0, y: 0, z: 0 });
  if (ending === "land") push({ frame: 3, command: CMD.LAND, ...z, x: 0, y: 0, z: 0 });
  return items;
}

/**
 * What each item of planToMission's mission is, in the plan's own words, by
 * sequence number: so "reached item 7" can be told as "waypoint 2, back up".
 */
export function planSteps(points: PlanPoint[], ending: Ending): string[] {
  const steps = ["home"];
  for (const r of releasesUsed(points.flatMap((p) => (p.delivery ? [p.delivery] : [])))) steps.push(r.kind === "gripper" ? "the gripper closed" : `servo ${r.servo} closed`);
  steps.push("the take-off height");
  points.forEach((p, i) => {
    const w = `waypoint ${i + 1}`;
    if (!p.delivery) steps.push(w);
    else if (p.delivery.method === "drop") steps.push(w, `${w}, down to the release height`, `${w}, the release`, `${w}, after the drop`, `${w}, back up`);
    else steps.push(w, `${w}, down to where lowering starts`, `${w}, lowered and released`, `${w}, back up`);
  });
  if (ending === "rtl") steps.push("the return home");
  if (ending === "land") steps.push("the landing");
  return steps;
}

/** Length of the route over the ground, including the leg home, in metres. */
export function routeLength(points: PlanPoint[], ending: Ending): number {
  let d = 0;
  let at = { n: 0, e: 0 };
  for (const p of points) {
    d += Math.hypot(p.n - at.n, p.e - at.e);
    at = p;
  }
  if (ending === "rtl") d += Math.hypot(at.n, at.e);
  return d;
}

export interface ReadPlan {
  home: Home | null;
  takeoffAlt: number | null;
  points: PlanPoint[];
  ending: Ending;
  /** What could not be kept, in words for the reader. */
  notes: string[];
}

const NAMES: Record<number, string> = { 17: "loiter without end", 18: "loiter turns", 19: "loiter for a time", 82: "spline waypoint", 93: "delay", 94: "lower and release payload", 112: "condition delay", 115: "condition yaw", 177: "jump", 178: "change speed", 179: "set home", 181: "set relay", 183: "set servo", 201: "region of interest", 203: "camera control", 205: "camera mount", 206: "camera trigger distance", 189: "landing start", 211: "gripper" };

/**
 * A mission, as an aircraft or a file holds it, turned back into a plan.
 *
 * The planner knows a take-off, waypoints with a wait, payload deliveries
 * and one ending. A mission can hold much more. Whatever does not fit is
 * left out and named in `notes`, because sending the plan back would remove
 * it from the aircraft. `ground` gives the ground's height above home, from
 * which a delivery's release height is measured.
 */
export function missionToPlan(
  items: MissionItem[],
  fallbackHome: Home,
  ground: (n: number, e: number) => number = () => 0,
  /** The weight and hang already known for a delivery at a place (a mission does not carry them); null when none is. */
  known: (n: number, e: number) => Pick<Delivery, "kg" | "hangM"> | null = () => null,
): ReadPlan {
  const notes: string[] = [];
  const first = items[0];
  // Item 0 is where ArduPilot keeps home.
  const home: Home | null = first && (first.x !== 0 || first.y !== 0) ? { lat: first.x / 1e7, lon: first.y / 1e7, altMsl: Number.isFinite(first.z) ? first.z : fallbackHome.altMsl } : null;
  const ref = home ?? fallbackHome;
  const points: PlanPoint[] = [];
  let takeoffAlt: number | null = null;
  let ending: Ending = "hold";
  let ended = false;
  const dropped = new Map<string, number>();
  const frames = new Set<string>();
  let afterEnd = 0;
  let rebuilt = 0;
  let unweighed = 0;
  // The closing commands before the take-off belong to the deliveries; they are written again from them.
  const { closedFor, count: closing } = closingBeforeTakeoff(items);
  let skipClosing = closing;
  let tookOff = false;

  const height = (it: MissionItem): number => {
    // 3 and 6: above home. 0 and 5: above sea level. 10 and 11: above the ground.
    if (it.frame === 0 || it.frame === 5) {
      frames.add("above sea level");
      return it.z - ref.altMsl;
    }
    if (it.frame === 10 || it.frame === 11) frames.add("above the ground");
    return it.z;
  };
  const place = (it: MissionItem, holdS: number, alt = height(it), delivery?: Delivery) => {
    const l = toLocal(ref, it.x / 1e7, it.y / 1e7);
    const n = Math.round(l.n);
    const e = Math.round(l.e);
    points.push({ id: uid(), n, e, alt: Math.max(2, Math.min(500, Math.round(alt * 10) / 10)), holdS: Math.max(0, Math.min(600, Math.round(holdS))), ...(delivery ? { delivery } : {}) });
  };
  const drop = (name: string) => dropped.set(name, (dropped.get(name) ?? 0) + 1);

  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    if (ended) {
      afterEnd++;
      continue;
    }
    const here = it.x !== 0 || it.y !== 0;
    if (!tookOff && skipClosing > 0 && ((it.command === 211 && Math.round(it.p2) === 1) || it.command === 183)) {
      skipClosing--;
      continue;
    }
    if (it.command === CMD.TAKEOFF) {
      tookOff = true;
      if (takeoffAlt === null) takeoffAlt = Math.max(2, Math.min(500, it.z));
      continue;
    }
    if (it.command === CMD.WAYPOINT && here) {
      const found = findDelivery(items, i, closedFor);
      if (found) {
        const l = toLocal(ref, it.x / 1e7, it.y / 1e7);
        const g = ground(l.n, l.e);
        const low = height({ ...it, z: found.delivery.lowAlt });
        const { lowAlt: _l, ...kept } = found.delivery;
        const had = known(l.n, l.e);
        if (!had) unweighed++;
        const delivery: Delivery = { ...kept, heightM: Math.max(1, Math.round((low - g) * 10) / 10), kg: had?.kg ?? 0.5, hangM: had?.hangM ?? 0.3 };
        place(it, found.holdS, height(it), delivery);
        if (found.rebuilt) rebuilt++;
        i += found.length - 1;
        continue;
      }
    }
    if (it.command === CMD.WAYPOINT || it.command === CMD.LOITER_TIME) {
      if (here) place(it, it.p1);
      else drop("waypoint with no position");
    } else if (it.command === CMD.LOITER_UNLIM) {
      if (here) place(it, 0);
      ending = "hold";
      ended = true;
    } else if (it.command === CMD.RTL) {
      ending = "rtl";
      ended = true;
    } else if (it.command === CMD.LAND) {
      // A landing somewhere else is a flight there first.
      if (here && points.length) {
        const last = points[points.length - 1];
        const l = toLocal(ref, it.x / 1e7, it.y / 1e7);
        if (Math.hypot(l.n - last.n, l.e - last.e) > 2) place(it, 0, last.alt);
      } else if (here) place(it, 0, takeoffAlt ?? 20);
      ending = "land";
      ended = true;
    } else {
      drop(NAMES[it.command] ?? `command ${it.command}`);
    }
  }
  if (!points.length && ending !== "rtl") ending = "rtl";

  if (dropped.size) {
    const total = [...dropped.values()].reduce((a, b) => a + b, 0);
    notes.push(`${total} ${total === 1 ? "command was" : "commands were"} left out because this planner cannot show ${total === 1 ? "it" : "them"}: ${[...dropped].map(([k, c]) => (c > 1 ? `${k} (${c})` : k)).join(", ")}. Sending this plan back will remove ${total === 1 ? "it" : "them"} from the mission.`);
  }
  if (afterEnd) notes.push(`${afterEnd} ${afterEnd === 1 ? "command" : "commands"} after the landing or return ${afterEnd === 1 ? "was" : "were"} left out.`);
  if (rebuilt) notes.push(`${rebuilt === 1 ? "A payload release was" : `${rebuilt} payload releases were`} written another way. ${rebuilt === 1 ? "It is" : "They are"} shown as AERONEX flies a delivery (stop over the point, come down to the height asked, let go or lower, climb back); check each before sending, as sending will write ${rebuilt === 1 ? "it" : "them"} that way.`);
  if (unweighed) notes.push(`A mission does not carry a payload's weight: ${unweighed === 1 ? "its delivery is" : `${unweighed} deliveries are`} shown at 0.5 kg. Set the real ${unweighed === 1 ? "weight" : "weights"}.`);
  for (const f of frames) {
    notes.push(
      f === "above sea level"
        ? "Some heights were stored above sea level. They are shown here above home, using home's height above the sea, and will be sent back as heights above home."
        : "Some heights were stored above the ground (terrain following). They are shown here as heights above home, which is not the same thing: check every height before sending.",
    );
  }
  return { home, takeoffAlt, points, ending, notes };
}
