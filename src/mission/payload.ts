import { G, type Airframe } from "../sim/airframe";
import type { MissionItem } from "../sim/autopilot";

/*
  Payload delivery: a waypoint where the aircraft lets something go.

  Everything here is a pure function, built on how ArduCopter runs a mission,
  read from its source (4.6.3 and 4.7.2):

  - A "do" command (DO_GRIPPER, DO_SET_SERVO) runs the moment the navigation
    command before it completes, and the aircraft sets off for the next
    navigation command in that same instant (AP_Mission::advance_current_nav_cmd).
    A release written straight after an ordinary waypoint therefore happens as
    the aircraft starts to fly away. So a drop here is a sequence that keeps
    it still: arrive at cruise height and stop, come straight down, settle,
    release, wait while the payload falls clear, climb straight back up.
  - A waypoint with a wait makes the aircraft stop on it; one without lets it
    round the corner towards the next (ModeAuto::do_nav_wp sets the next
    destination only when there is no wait). Every point of the sequence has
    a wait of at least a second, so it never cuts the corner over the drop
    site.
  - DO_GRIPPER's action is 0 to release and 1 to grab (GRIPPER_ACTIONS; the
    ArduPilot wiki's mission list has these the other way round). It reports
    "Gripper Released" even when the gripper is off and nothing moves
    (AP_Mission::start_command_do_gripper), so whether a release will work is
    decided from the aircraft's settings here, never from that message.
  - NAV_PAYLOAD_PLACE lowers the aircraft at PLDP_SPEED_DN (or the landing
    speed), measures the thrust it needs for two seconds once the descent is
    steady, and releases when the thrust falls below PLDP_THRESH of that for
    half a second: the payload has taken its own weight on the ground. Only a
    gripper is released (PayloadPlace::run); with none it climbs back still
    holding the load. If it has come down param 1 metres without touching, it
    gives up and climbs back, keeping the payload. If the aircraft itself
    lands, it releases there.
  - A do command before the take-off runs as the mission starts, on the
    ground, and does not stop Auto from starting (is_takeoff_next skips do
    commands): the release is closed there, before anything lifts.
*/

/** What lets the payload go. */
export type Release = { kind: "gripper" } | { kind: "servo"; servo: number; open: number; closed: number };

export type Method = "drop" | "lower";

export interface Delivery {
  method: Method;
  release: Release;
  /**
   * Height above the ground at the point, m. For a drop, where it lets go.
   * For lowering, where the slow descent that feels for the ground starts.
   */
  heightM: number;
  /** Drop: seconds to hover still before letting go. */
  settleS: number;
  /** Drop: seconds to stay put after letting go, while the payload falls clear. */
  afterS: number;
  /** Lower: how far it may descend feeling for the ground before it gives up and keeps the payload, m. */
  giveUpM: number;
  /** Weight of this payload, kg. */
  kg: number;
  /** How far below the aircraft the payload hangs, m: on a short hook a few tenths, on a line more. */
  hangM: number;
}

/** The command ids used here. */
export const PAYLOAD_CMD = { WAYPOINT: 16, LOITER_TIME: 19, TAKEOFF: 22, PAYLOAD_PLACE: 94, SET_SERVO: 183, GRIPPER: 211 } as const;
/** GRIPPER_ACTIONS. */
export const GRIP = { RELEASE: 0, GRAB: 1 } as const;
/** Do commands carry no place; MAV_FRAME_MISSION says so. ArduPilot ignores the frame of a command without one. */
const FRAME_MISSION = 2;
const FRAME_REL = 3;

export const DROP_DEFAULTS = { heightM: 10, settleS: 3, afterS: 3 } as const;
export const LOWER_DEFAULTS = { heightM: 15, giveUpM: 20 } as const;

export function newDelivery(method: Method, release: Release, kg = 0.5): Delivery {
  return method === "drop"
    ? { method, release, heightM: DROP_DEFAULTS.heightM, settleS: DROP_DEFAULTS.settleS, afterS: DROP_DEFAULTS.afterS, giveUpM: LOWER_DEFAULTS.giveUpM, kg, hangM: 0.3 }
    : { method, release, heightM: LOWER_DEFAULTS.heightM, settleS: DROP_DEFAULTS.settleS, afterS: DROP_DEFAULTS.afterS, giveUpM: LOWER_DEFAULTS.giveUpM, kg, hangM: 0.3 };
}

/** The same delivery made a different kind, keeping what it can. */
export function switchMethod(d: Delivery, method: Method): Delivery {
  if (d.method === method) return d;
  const heightM = method === "lower" ? Math.max(d.heightM, LOWER_DEFAULTS.heightM) : DROP_DEFAULTS.heightM;
  return { ...d, method, heightM, giveUpM: Math.max(d.giveUpM, heightM + 5), release: method === "lower" ? { kind: "gripper" } : d.release };
}

const clampN = (v: unknown, lo: number, hi: number, otherwise: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : otherwise);

/** A delivery as saved in the browser or read from a file, put right if damaged. Null if it is not one. */
export function soundDelivery(raw: unknown): Delivery | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Partial<Delivery>;
  if (d.method !== "drop" && d.method !== "lower") return undefined;
  const r = d.release as Partial<Release> | undefined;
  let release: Release = { kind: "gripper" };
  if (r && r.kind === "servo") {
    const s = r as Partial<Extract<Release, { kind: "servo" }>>;
    release = { kind: "servo", servo: Math.round(clampN(s.servo, 1, 32, 9)), open: Math.round(clampN(s.open, 500, 2500, 1900)), closed: Math.round(clampN(s.closed, 500, 2500, 1100)) };
  }
  return {
    method: d.method,
    release,
    heightM: clampN(d.heightM, 1, 500, d.method === "drop" ? DROP_DEFAULTS.heightM : LOWER_DEFAULTS.heightM),
    settleS: clampN(d.settleS, 1, 120, DROP_DEFAULTS.settleS),
    afterS: clampN(d.afterS, 1, 120, DROP_DEFAULTS.afterS),
    giveUpM: clampN(d.giveUpM, 1, 500, LOWER_DEFAULTS.giveUpM),
    kg: clampN(d.kg, 0, 50, 0.5),
    hangM: clampN(d.hangM, 0, 30, 0.3),
  };
}

export const sameRelease = (a: Release, b: Release) => (a.kind === "gripper" ? b.kind === "gripper" : b.kind === "servo" && a.servo === b.servo);
export const releaseKey = (r: Release) => (r.kind === "gripper" ? "gripper" : `servo:${r.servo}`);

type Pos = { x: number; y: number };
const item = (command: number, frame: number, p1: number, p2: number, at: Pos | null, z: number): Omit<MissionItem, "seq"> => ({ command, frame, p1, p2, p3: 0, p4: 0, x: at?.x ?? 0, y: at?.y ?? 0, z });

/** The command that lets go. */
export function releaseCommand(r: Release): Omit<MissionItem, "seq"> {
  return r.kind === "gripper" ? item(PAYLOAD_CMD.GRIPPER, FRAME_MISSION, 1, GRIP.RELEASE, null, 0) : item(PAYLOAD_CMD.SET_SERVO, FRAME_MISSION, r.servo, r.open, null, 0);
}

/** The command that holds on. */
export function closeCommand(r: Release): Omit<MissionItem, "seq"> {
  return r.kind === "gripper" ? item(PAYLOAD_CMD.GRIPPER, FRAME_MISSION, 1, GRIP.GRAB, null, 0) : item(PAYLOAD_CMD.SET_SERVO, FRAME_MISSION, r.servo, r.closed, null, 0);
}

/** Heights are tenths of a metre at most: a mission keeps centimetres, and a plan is not more exact than that. */
const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * The mission items for one delivery at a waypoint, in place of the plain
 * waypoint. `at` is the point; `cruise` its height above home; `ground` the
 * ground's height there above home; `holdS` the waypoint's own wait.
 */
export function deliveryCommands(d: Delivery, at: Pos, cruise: number, ground: number, holdS: number): Omit<MissionItem, "seq">[] {
  const arrive = item(PAYLOAD_CMD.WAYPOINT, FRAME_REL, Math.max(1, Math.round(holdS)), 0, at, tenth(cruise));
  const leave = item(PAYLOAD_CMD.WAYPOINT, FRAME_REL, 1, 0, at, tenth(cruise));
  const low = tenth(ground + d.heightM);
  if (d.method === "lower") {
    /*
      Down to the starting height first, on a waypoint of its own. ArduCopter
      4.6 flies a PAYLOAD_PLACE to its place at the height it is already at
      and lowers from there (shift_alt_to_current_alt); 4.7 flies to the
      command's own height. Already there, both start lowering at once, from
      the height asked.
    */
    return [arrive, item(PAYLOAD_CMD.WAYPOINT, FRAME_REL, 1, 0, at, low), item(PAYLOAD_CMD.PAYLOAD_PLACE, FRAME_REL, Math.round(d.giveUpM), 0, at, low), leave];
  }
  return [
    arrive,
    item(PAYLOAD_CMD.WAYPOINT, FRAME_REL, Math.max(1, Math.round(d.settleS)), 0, at, low),
    releaseCommand(d.release),
    item(PAYLOAD_CMD.LOITER_TIME, FRAME_REL, Math.max(1, Math.round(d.afterS)), 0, at, low),
    leave,
  ];
}

/** The releases a plan uses, each once, in the order first used. */
export function releasesUsed(deliveries: Delivery[]): Release[] {
  const out: Release[] = [];
  for (const d of deliveries) if (!out.some((r) => sameRelease(r, d.release))) out.push(d.release);
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading a mission back                                              */
/* ------------------------------------------------------------------ */

const isRelease = (it: MissionItem | undefined) => !!it && ((it.command === PAYLOAD_CMD.GRIPPER && Math.round(it.p2) === GRIP.RELEASE) || it.command === PAYLOAD_CMD.SET_SERVO);
const isClose = (it: MissionItem | undefined) => !!it && it.command === PAYLOAD_CMD.GRIPPER && Math.round(it.p2) === GRIP.GRAB;
const near = (a: MissionItem, b: MissionItem) => Math.abs(a.x - b.x) <= 12 && Math.abs(a.y - b.y) <= 12; // about a metre
const placed = (it: MissionItem) => it.x !== 0 || it.y !== 0;

/** What a release command lets go with. `closed` is the servo's other position, if the mission says it. */
export function releaseOf(it: MissionItem, closedFor: Map<number, number>): Release {
  if (it.command === PAYLOAD_CMD.GRIPPER) return { kind: "gripper" };
  const servo = Math.round(it.p1);
  const open = Math.round(it.p2);
  return { kind: "servo", servo, open, closed: closedFor.get(servo) ?? (open >= 1500 ? 1100 : 1900) };
}

export interface FoundDelivery {
  /** Items used, from the waypoint on. */
  length: number;
  delivery: Omit<Delivery, "heightM" | "kg" | "hangM"> & { lowAlt: number };
  /** The waypoint's own wait. */
  holdS: number;
  /** It was written by something else and is rebuilt as AERONEX flies a drop. */
  rebuilt: boolean;
}

/**
 * A delivery starting at mission item `i`, a waypoint, if there is one.
 * Recognises the sequences written above, and the plain pattern other ground
 * stations write (a waypoint, then a release straight after it).
 */
export function findDelivery(items: MissionItem[], i: number, closedFor: Map<number, number>): FoundDelivery | null {
  const a = items[i];
  if (!a || a.command !== PAYLOAD_CMD.WAYPOINT || !placed(a)) return null;
  const b = items[i + 1];
  const c = items[i + 2];
  const d = items[i + 3];
  const e = items[i + 4];
  const hold = (p1: number) => (p1 <= 1 ? 0 : Math.round(p1));
  // Lower, as written here: arrive, come down to the start, place, leave.
  if (b && b.command === PAYLOAD_CMD.WAYPOINT && near(a, b) && c && c.command === PAYLOAD_CMD.PAYLOAD_PLACE && (!placed(c) || near(a, c)) && d && d.command === PAYLOAD_CMD.WAYPOINT && near(a, d) && Math.abs(d.z - a.z) < 0.5) {
    return {
      length: 4,
      delivery: { method: "lower", release: { kind: "gripper" }, settleS: DROP_DEFAULTS.settleS, afterS: DROP_DEFAULTS.afterS, giveUpM: Math.max(1, c.p1), lowAlt: b.z },
      holdS: hold(a.p1),
      rebuilt: false,
    };
  }
  // Lower straight from a waypoint: ArduCopter 4.6 starts lowering from that waypoint's height, 4.7 from the command's.
  if (b && b.command === PAYLOAD_CMD.PAYLOAD_PLACE && (!placed(b) || near(a, b))) {
    const leaves = c && c.command === PAYLOAD_CMD.WAYPOINT && near(a, c) && Math.abs(c.z - a.z) < 0.5;
    return {
      length: leaves ? 3 : 2,
      delivery: { method: "lower", release: { kind: "gripper" }, settleS: DROP_DEFAULTS.settleS, afterS: DROP_DEFAULTS.afterS, giveUpM: Math.max(1, b.p1), lowAlt: b.z > 0 ? b.z : a.z },
      holdS: hold(a.p1),
      rebuilt: true,
    };
  }
  // Drop, as written here: arrive, come down and settle, release, wait, leave.
  if (b && b.command === PAYLOAD_CMD.WAYPOINT && near(a, b) && isRelease(c) && d && (d.command === PAYLOAD_CMD.LOITER_TIME || d.command === PAYLOAD_CMD.WAYPOINT) && near(a, d) && e && e.command === PAYLOAD_CMD.WAYPOINT && near(a, e)) {
    return {
      length: 5,
      delivery: { method: "drop", release: releaseOf(c, closedFor), settleS: Math.max(1, b.p1), afterS: Math.max(1, d.p1), giveUpM: LOWER_DEFAULTS.giveUpM, lowAlt: b.z },
      holdS: hold(a.p1),
      rebuilt: false,
    };
  }
  // A release straight after a waypoint: let go there, at its height.
  if (isRelease(b)) {
    return {
      length: 2,
      delivery: { method: "drop", release: releaseOf(b, closedFor), settleS: Math.max(1, Math.round(a.p1)), afterS: DROP_DEFAULTS.afterS, giveUpM: LOWER_DEFAULTS.giveUpM, lowAlt: a.z },
      holdS: 0,
      rebuilt: true,
    };
  }
  return null;
}

/** The closing commands before the take-off: what each servo release closes to. */
export function closingBeforeTakeoff(items: MissionItem[]): { closedFor: Map<number, number>; count: number } {
  const closedFor = new Map<number, number>();
  let count = 0;
  for (const it of items.slice(1)) {
    if (it.command === PAYLOAD_CMD.TAKEOFF) break;
    if (isClose(it)) count++;
    else if (it.command === PAYLOAD_CMD.SET_SERVO) {
      closedFor.set(Math.round(it.p1), Math.round(it.p2));
      count++;
    }
  }
  return { closedFor, count };
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

type Speeds = { up: number; down: number; slow: number; delayS: number };

/** Speeds a delivery is flown at, m/s, from the aircraft's settings (older names, as the app uses). */
export function deliverySpeeds(p: Record<string, number | undefined>): Speeds {
  const up = Math.max(0.3, (p.WPNAV_SPEED_UP ?? 250) / 100);
  const down = Math.max(0.3, (p.WPNAV_SPEED_DN ?? 150) / 100);
  const land = Math.max(0.1, (p.LAND_SPEED ?? 50) / 100);
  // ArduCopter limits the placing descent to the mission's own descent speed too.
  const slow = Math.min(p.PLDP_SPEED_DN && p.PLDP_SPEED_DN > 0 ? p.PLDP_SPEED_DN : land, down);
  return { up, down, slow, delayS: Math.max(0, p.PLDP_DELAY ?? 0) };
}

/** Seconds a delivery adds to the flight, beyond flying to the waypoint. */
export function deliverySeconds(d: Delivery, cruise: number, ground: number, p: Record<string, number | undefined>): number {
  const s = deliverySpeeds(p);
  const low = ground + d.heightM;
  // Down from the waypoint to it and back up; or, when it is above the waypoint, up to it and back down.
  const there = cruise >= low ? (cruise - low) / s.down + (cruise - low) / s.up : (low - cruise) / s.up + (low - cruise) / s.down;
  // Each stop costs a second or so to settle.
  if (d.method === "drop") return 1 + there + d.settleS + d.afterS + 1 + 3;
  // Lowering: to the start and a second there, steady the descent and measure the thrust (about 3 s), the slow part to the ground and back up.
  const feel = Math.max(0, Math.min(d.heightM, d.giveUpM) - d.hangM);
  return 1 + there + 1 + 3 + feel / s.slow + 0.5 + s.delayS + feel / s.up + 1 + 3;
}

/* ------------------------------------------------------------------ */
/* The release on the aircraft                                         */
/* ------------------------------------------------------------------ */

/** May DO_SET_SERVO move an output with this function? (AP_ServoRelayEvents::do_set_servo) */
export function servoCommandAllowed(fn: number): boolean {
  return fn === 0 || fn === 1 || fn === 22 || fn === 23 || fn === 28 || (fn >= 51 && fn <= 66) || (fn >= 140 && fn <= 155);
}

export interface ReleaseOption {
  release: Release;
  label: string;
  /** Why it would not work now; null when it would. */
  problem: string | null;
}

/** Outputs SERVO1..n that exist in these settings. */
const servoNumbers = (p: Record<string, number>) => Object.keys(p).map((k) => /^SERVO(\d+)_FUNCTION$/.exec(k)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);

/**
 * The releases this aircraft has: its gripper, and each output left free for
 * a mission to move (Disabled). `port` names an output the way it is printed
 * on the board. `restartPending` is the settings saved since the last start.
 */
export function releaseOptions(p: Record<string, number> | null, port: (servo: number) => string, restartPending: string[] = []): ReleaseOption[] {
  if (!p) return [{ release: { kind: "gripper" }, label: "Gripper", problem: null }];
  const out: ReleaseOption[] = [];
  const grip = servoNumbers(p).filter((n) => p[`SERVO${n}_FUNCTION`] === 28);
  out.push({ release: { kind: "gripper" }, label: grip.length ? `Gripper on ${grip.map(port).join(", ")}` : "Gripper", problem: gripperProblem(p, port, restartPending) });
  for (const n of servoNumbers(p)) {
    const fn = p[`SERVO${n}_FUNCTION`];
    // Outputs a mission may move that are free for a release: not the gripper's own, not a sprayer's.
    if (fn === 28 || fn === 22 || fn === 23 || !servoCommandAllowed(fn)) continue;
    const follows = fn === 1 ? n : fn >= 51 && fn <= 66 ? fn - 50 : fn >= 140 && fn <= 155 ? fn - 139 : null;
    out.push({
      release: { kind: "servo", servo: n, open: 1900, closed: 1100 },
      label: `Servo on ${port(n)}${follows ? ` (follows channel ${follows})` : ""}`,
      problem: restartPending.includes(`SERVO${n}_FUNCTION`) ? `Restart the flight controller first: ${port(n)} was changed since it started.` : null,
    });
  }
  return out;
}

/** Why the gripper would not let go on command; null when it would. */
export function gripperProblem(p: Record<string, number>, port: (servo: number) => string, restartPending: string[] = []): string | null {
  if (p.GRIP_ENABLE !== 1) return "The gripper is off (GRIP_ENABLE is 0). The aircraft would still report “Gripper Released”, but nothing would move. Set it up on the Servo Outputs page.";
  if (p.GRIP_TYPE !== undefined && p.GRIP_TYPE !== 1 && p.GRIP_TYPE !== 2) return `The gripper has no type (GRIP_TYPE is ${p.GRIP_TYPE}), so nothing would move. Set it up on the Servo Outputs page.`;
  const outs = servoNumbers(p).filter((n) => p[`SERVO${n}_FUNCTION`] === 28);
  if ((p.GRIP_TYPE ?? 1) === 1 && !outs.length) return "No output is set to Payload release (gripper), so the gripper has nothing to move. Pick its output on the Servo Outputs page.";
  const pending = restartPending.filter((n) => n === "GRIP_ENABLE" || n === "GRIP_TYPE" || outs.some((o) => n === `SERVO${o}_FUNCTION`));
  if (pending.length) return `Restart the flight controller first: ${pending.join(", ")} changed since it started, and the gripper only starts at start-up.`;
  if (p.GRIP_GRAB !== undefined && p.GRIP_GRAB === p.GRIP_RELEASE) return `Grab and release are the same position (${p.GRIP_GRAB} µs), so it would never open.`;
  void port;
  return null;
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

export interface PayloadFinding {
  sev: "bad" | "warn" | "note";
  text: string;
}

export interface DeliveryAt {
  /** Waypoint number, from 1. */
  wp: number;
  delivery: Delivery;
  /** Height of the waypoint above home. */
  cruise: number;
  /** Height of the ground at the point above home, or null where it is not known. */
  ground: number | null;
}

export interface PayloadCheckInput {
  deliveries: DeliveryAt[];
  /** The aircraft's settings (older names added), or null when no aircraft's settings are known. */
  aircraft: Record<string, number> | null;
  /** Where those settings came from, for the reader. */
  aircraftSource: string;
  restartPending: string[];
  port: (servo: number) => string;
  airframe: Airframe;
  /** Real ground, with the measured data's limits. */
  real: boolean;
  /** Issues the Servo Outputs check raises about an output, as titles. */
  outputIssues?: (servo: number) => string[];
  /** The fence's floor, m above home, when it will be in force; null when it will not. */
  fenceFloor?: number | null;
}

const kgText = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(kg < 10 ? 1 : 0)} kg`);

/** Everything worth knowing about the deliveries before they fly, worst first. */
export function checkDeliveries(inp: PayloadCheckInput): PayloadFinding[] {
  const out: PayloadFinding[] = [];
  const { deliveries, aircraft: p, airframe: af } = inp;
  if (!deliveries.length) return out;
  const at = (x: DeliveryAt) => `Waypoint ${x.wp}`;

  // The release, on this aircraft.
  if (!p) {
    out.push({ sev: "warn", text: "No aircraft's settings are known, so whether its release will work is not checked. Link the aircraft: it is checked before the mission is sent." });
  } else {
    const seen = new Map<string, number[]>();
    for (const x of deliveries) seen.set(releaseKey(x.delivery.release), [...(seen.get(releaseKey(x.delivery.release)) ?? []), x.wp]);
    const reported = new Set<string>();
    for (const x of deliveries) {
      const r = x.delivery.release;
      const key = releaseKey(r);
      if (reported.has(key)) continue;
      reported.add(key);
      if (r.kind === "gripper") {
        const why = gripperProblem(p, inp.port, inp.restartPending);
        if (why) out.push({ sev: "bad", text: `${at(x)}: ${why}` });
      } else {
        const fn = p[`SERVO${r.servo}_FUNCTION`];
        const name = inp.port(r.servo);
        if (fn === undefined) out.push({ sev: "bad", text: `${at(x)}: this aircraft has no output SERVO${r.servo}.` });
        else if (!servoCommandAllowed(fn)) out.push({ sev: "bad", text: `${at(x)}: ${name} (SERVO${r.servo}) is in use as something else (function ${fn}). ArduPilot refuses to move it from a mission (“Channel ${r.servo} is already in use”), so nothing would drop. Set it to “Mission or button” on the Servo Outputs page.` });
        else if (fn === 1 || (fn >= 51 && fn <= 66) || (fn >= 140 && fn <= 155)) out.push({ sev: "warn", text: `${at(x)}: ${name} also follows a transmitter channel. The mission moves it, but the moment that switch moves it takes the output back, open or closed.` });
        if (inp.restartPending.includes(`SERVO${r.servo}_FUNCTION`)) out.push({ sev: "bad", text: `${at(x)}: restart the flight controller first: ${name}'s function changed since it started.` });
        if (r.open === r.closed) out.push({ sev: "bad", text: `${at(x)}: open and closed are the same pulse (${r.open} µs) on ${name}, so it would never let go.` });
        if (r.open < 800 || r.open > 2200 || r.closed < 800 || r.closed > 2200) out.push({ sev: "warn", text: `${at(x)}: ${name} is sent ${r.open} µs to open and ${r.closed} µs to close. Most servos are made for about 1000–2000 µs; beyond 800–2200 they strain against their stops.` });
        for (const t of inp.outputIssues?.(r.servo) ?? []) out.push({ sev: "warn", text: `${at(x)}: ${t} (see Servo Outputs).` });
      }
      const wps = seen.get(key)!;
      if (wps.length > 1) {
        out.push({
          sev: "bad",
          text:
            r.kind === "gripper"
              ? `The gripper is used at waypoints ${wps.join(" and ")}. It lets go of everything it holds at the first, so there is nothing left for the others. Use one release per payload (a second servo for a second payload).`
              : `${inp.port(r.servo)} is used at waypoints ${wps.join(" and ")}. It opens at the first and has nothing left to drop after. Use one release per payload.`,
        });
      }
    }
    if (deliveries.some((x) => x.delivery.release.kind === "gripper")) {
      if (((p.FS_OPTIONS ?? 0) & 32) !== 0) out.push({ sev: "warn", text: "FS_OPTIONS has “Release Gripper” on: a battery, radio or link failsafe opens the gripper wherever the aircraft is, over whatever is below. Turn that option off unless dropping anywhere is safer than carrying the load home." });
      if (((p.FLIGHT_OPTIONS ?? 0) & 4) !== 0) out.push({ sev: "note", text: "FLIGHT_OPTIONS has “Release gripper on thrust loss” on: if a motor fails it drops the payload to stay in the air." });
      if ((p.GRIP_AUTOCLOSE ?? 0) > 0) out.push({ sev: "note", text: `The gripper closes again ${p.GRIP_AUTOCLOSE} s after each release (GRIP_AUTOCLOSE).` });
    }
  }

  // Each delivery.
  const s = deliverySpeeds(p ?? {});
  for (const x of deliveries) {
    const d = x.delivery;
    if (x.ground === null) {
      out.push({ sev: "bad", text: `${at(x)}: the ground's height there is not known, so the ${d.method === "drop" ? "release" : "lowering"} height above it cannot be worked out. Load the ground heights, or move home or the point.` });
      continue;
    }
    // The fence's floor holds in a delivery as anywhere: below it is a breach, and the fence's action takes over.
    const lowest = x.ground + (d.method === "drop" ? d.heightM : d.hangM);
    if (inp.fenceFloor !== undefined && inp.fenceFloor !== null && lowest <= inp.fenceFloor) {
      out.push({ sev: "bad", text: `${at(x)}: the ${d.method === "drop" ? "release" : "lowering"} goes down to ${Math.round(lowest)} m above home, below the fence's floor (FENCE_ALT_MIN ${inp.fenceFloor} m). The aircraft would breach the fence there and the fence's action would take over${d.method === "drop" ? " before the payload is let go" : ""}. Lower the floor below the delivery, or turn the floor off on the Fence tab.` });
    }
    if (!(d.kg > 0)) out.push({ sev: "warn", text: `${at(x)}: the payload's weight is not set. It decides whether the aircraft can lift it${d.method === "lower" ? " and whether the touchdown can be felt" : ""}.` });
    const low = x.ground + d.heightM;
    if (low > x.cruise + 0.5) out.push({ sev: "note", text: `${at(x)}: the ${d.method === "drop" ? "release" : "lowering"} height (${Math.round(d.heightM)} m above the ground) is above the waypoint, so it climbs to it there.` });
    if (d.method === "drop") {
      const clear = d.hangM + 1.5;
      if (d.heightM < clear) out.push({ sev: "bad", text: `${at(x)}: letting go ${d.heightM} m above the ground leaves too little room under a payload hanging ${d.hangM} m below. Release at ${Math.ceil(clear)} m or higher, or lower it to the ground instead.` });
      else if (inp.real && d.heightM < 15) out.push({ sev: "warn", text: `${at(x)}: the release is ${Math.round(d.heightM)} m above the ground as the elevation data has it, and that data is typically right only to 10 m, with no trees or buildings. Check the drop site's real height, or release higher.` });
      if (d.heightM > 30) out.push({ sev: "note", text: `${at(x)}: a drop from ${Math.round(d.heightM)} m lands hard and drifts with the wind unless the payload has a parachute.` });
    } else {
      if (d.release.kind !== "gripper") out.push({ sev: "bad", text: `${at(x)}: lowering to the ground releases only a gripper. With a servo release the aircraft would touch down, climb back and keep the payload.` });
      const total = af.massKg + deliveries.filter((y) => y.wp >= x.wp).reduce((a, y) => a + y.delivery.kg, 0);
      const share = total > 0 ? d.kg / total : 0;
      const thresh = p?.PLDP_THRESH ?? 0.9;
      const need = 1 - thresh;
      if (d.kg > 0 && share < need) {
        out.push({ sev: "bad", text: `${at(x)}: the touchdown cannot be felt. The payload is ${Math.round(share * 100)}% of the weight there (${kgText(d.kg)} of ${kgText(total)}), and ArduCopter releases only when the thrust it needs falls by more than ${Math.round(need * 100)}% (PLDP_THRESH ${thresh}). It would ${d.giveUpM > d.heightM ? "come down until the aircraft itself lands, then let go" : "reach its give-up depth and climb back with the payload"}. Use a heavier payload, or drop it from a height instead.` });
      } else if (d.kg > 0 && share < need + 0.05) {
        out.push({ sev: "warn", text: `${at(x)}: the payload is ${Math.round(share * 100)}% of the weight there, close to the ${Math.round(need * 100)}% fall in thrust that counts as touchdown (PLDP_THRESH ${thresh}). A gust or a firm descent can release it early or not at all.` });
      }
      if (p && (p.PLDP_RNG_MAX ?? 0) > 0) {
        if (!(p.RNGFND1_TYPE > 0)) out.push({ sev: "bad", text: `${at(x)}: PLDP_RNG_MAX is ${p.PLDP_RNG_MAX} m but no rangefinder is set up (RNGFND1_TYPE is 0). ArduCopter abandons the lowering and climbs back with the payload.` });
        else if (d.hangM > p.PLDP_RNG_MAX) out.push({ sev: "warn", text: `${at(x)}: the payload hangs ${d.hangM} m below the aircraft, more than PLDP_RNG_MAX (${p.PLDP_RNG_MAX} m): it touches the ground before the rangefinder allows a release, and the aircraft keeps descending onto it.` });
      }
      // It must be coming down steadily for two seconds before it can tell.
      const measure = s.slow * 2.5 + d.hangM + 1;
      if (d.heightM < measure) out.push({ sev: "bad", text: `${at(x)}: lowering starts only ${d.heightM} m above the ground. ArduCopter measures the thrust over two seconds of steady descent first (about ${measure.toFixed(1)} m at ${s.slow.toFixed(1)} m/s with this payload's hang), so it would touch down before it could tell. Start at ${Math.ceil(measure + 2)} m or higher.` });
      if (d.giveUpM < d.heightM - d.hangM) out.push({ sev: "bad", text: `${at(x)}: it gives up after descending ${d.giveUpM} m, but the payload is ${(d.heightM - d.hangM).toFixed(1)} m above the ground there. It would climb back with the payload. Let it descend at least ${Math.ceil(d.heightM - d.hangM + 3)} m.` });
      else if (inp.real && d.giveUpM < d.heightM + 10) out.push({ sev: "note", text: `${at(x)}: it gives up after ${d.giveUpM} m. With elevation data good to about 10 m, the ground may be lower than it looks; if it gives up, it climbs back with the payload.` });
      else if (!inp.real && d.giveUpM < d.heightM + 2) out.push({ sev: "note", text: `${at(x)}: it gives up only ${(d.giveUpM - d.heightM + d.hangM).toFixed(1)} m past the expected touchdown.` });
      const secs = Math.max(0, d.heightM - d.hangM) / s.slow;
      out.push({ sev: "note", text: `${at(x)}: it lowers at ${s.slow.toFixed(1)} m/s (${p?.PLDP_SPEED_DN ? "PLDP_SPEED_DN" : "the landing speed"}), about ${Math.round(secs)} s from ${Math.round(d.heightM)} m to the ground, ${p?.PLDP_DELAY ? `waits ${p.PLDP_DELAY} s (PLDP_DELAY) and ` : ""}climbs back.` });
    }
  }

  // Lift.
  const carried = deliveries.reduce((a, x) => a + x.delivery.kg, 0);
  if (carried > 0) {
    const weight = (af.massKg + carried) * G;
    const twr = (4 * af.motorMaxThrustN) / weight;
    const hover = weight / (4 * af.motorMaxThrustN);
    const what = `${kgText(af.massKg + carried)} at take-off with ${kgText(carried)} of payload`;
    if (twr < 1.5) out.push({ sev: "bad", text: `The aircraft weighs ${what}: thrust to weight ${twr.toFixed(2)} : 1. It cannot fly that safely; 2 : 1 is the usual minimum. (${af.name}, as set on the Simulator page.)` });
    else if (hover > 0.6) out.push({ sev: "warn", text: `The aircraft weighs ${what} and needs about ${Math.round(hover * 100)}% throttle to hover, leaving little in hand for wind or a failing motor. (${af.name}, as set on the Simulator page.)` });
  }
  const order = { bad: 0, warn: 1, note: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

/* ------------------------------------------------------------------ */
/* In words                                                            */
/* ------------------------------------------------------------------ */

const m = (v: number) => `${Math.round(v * 10) / 10} m`;

export function releaseName(r: Release, port: (servo: number) => string): string {
  return r.kind === "gripper" ? "the gripper" : `the servo on ${port(r.servo)}`;
}

/** What it will do there, in order, in one sentence. */
export function deliverySentence(d: Delivery, cruise: number, ground: number | null, port: (servo: number) => string, params: Record<string, number | undefined>): string {
  const above = ground === null ? "" : ` (${m(ground + d.heightM)} above home)`;
  if (d.method === "drop") {
    return `Stops overhead at ${m(cruise)}, comes straight down to ${m(d.heightM)} above the ground${above}, holds still ${d.settleS} s, opens ${releaseName(d.release, port)}, waits ${d.afterS} s, then climbs back to ${m(cruise)}.`;
  }
  const slow = deliverySpeeds(params).slow;
  return `Stops overhead at ${m(cruise)}, comes down to ${m(d.heightM)} above the ground${above}, then lowers at ${slow.toFixed(1)} m/s until it feels the payload touch down, opens the gripper and climbs back. If it has come down ${m(d.giveUpM)} without touching, it climbs back holding the payload.`;
}

