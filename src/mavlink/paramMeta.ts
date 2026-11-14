import url46 from "./params/copter-4.6.json?url";
import url47 from "./params/copter-4.7.json?url";

/*
  What each ArduCopter parameter is for: its plain name, description, units,
  range, options and bits, taken from the firmware's own documentation.

  The definitions are generated from the ArduCopter 4.7.2 and 4.6.3 sources by
  scripts/param-metadata/generate.py, which runs ArduPilot's param_parse.py
  (the tool behind Mission Planner's metadata and ardupilot.org). Each set is
  about 150 KB compressed, so it is fetched only when a page needs it.

  Everything here except the loader is a pure function, tested without a
  browser.
*/

/** One parameter's definition. Short keys keep the bundled file small. */
export interface ParamDef {
  /** Display name */
  n: string;
  /** Description */
  d: string;
  /** Units, as ArduPilot writes them (m/s, cdeg, PWM …) */
  u?: string;
  /** Documented range [low, high] */
  r?: [number, number];
  /** Suggested step */
  i?: number;
  /** Named options [value, label] */
  v?: [number, string][];
  /** Named bits [bit, label] */
  b?: [number, string][];
  /** Takes effect only after a reboot */
  rb?: 1;
  /** Marked "Advanced" by ArduPilot */
  adv?: 1;
  /** Set by the flight controller; not to be written */
  ro?: 1;
  /** Written by a calibration */
  cal?: 1;
  /** Changes on its own (counters, learned values) */
  vol?: 1;
  /** Where the helicopter definition differs */
  h?: Partial<ParamDef>;
}

export interface MetaSet {
  firmware: string;
  source: string;
  units: Record<string, string>;
  params: Record<string, ParamDef>;
}

export type MetaVersion = "4.7" | "4.6";

/* ---------------- Loading ---------------- */

const URLS: Record<MetaVersion, string> = { "4.7": url47, "4.6": url46 };
const cache = new Map<MetaVersion, Promise<MetaSet>>();

/** Fetch one version's definitions, once per session. */
export function loadMeta(version: MetaVersion): Promise<MetaSet> {
  let p = cache.get(version);
  if (!p) {
    p = fetch(URLS[version]).then((r) => {
      if (!r.ok) throw new Error(`Parameter definitions not loaded (${r.status})`);
      return r.json() as Promise<MetaSet>;
    });
    // A failed fetch is not cached, so the next visit tries again.
    p.catch(() => cache.delete(version));
    cache.set(version, p);
  }
  return p;
}

/**
 * Which firmware's definitions fit these settings. 4.7 renamed a set of
 * parameters (WPNAV_SPEED became WP_SPD and so on), so the names present say
 * which documentation applies. With nothing to go on, the newer one.
 */
export function metaVersionFor(values: Record<string, number>): MetaVersion {
  if (Number.isFinite(values.WP_SPD) || Number.isFinite(values.RTL_ALT_M) || Number.isFinite(values.ARMING_SKIPCHK)) return "4.7";
  if (Number.isFinite(values.WPNAV_SPEED) || Number.isFinite(values.PSC_ACCZ_P) || Number.isFinite(values.ARMING_CHECK)) return "4.6";
  return "4.7";
}

const HELI_FRAMES = new Set([6, 11, 13]);

/** A parameter's definition for this aircraft: the helicopter one on a helicopter frame. */
export function defFor(meta: MetaSet | null | undefined, name: string, values?: Record<string, number>): ParamDef | undefined {
  const d = meta?.params[name];
  if (!d) return undefined;
  if (d.h && values && HELI_FRAMES.has(values.FRAME_CLASS)) return { ...d, ...d.h };
  return d;
}

/* ---------------- Formatting ---------------- */

export const trimNum = (v: number) => (Number.isInteger(v) ? String(v) : parseFloat(v.toPrecision(7)).toString());

/** "m/s" → "meters per second"; unknown units are shown as written. */
export function unitText(meta: MetaSet | null | undefined, u: string | undefined): string | undefined {
  if (!u) return undefined;
  return meta?.units[u] ?? u;
}

/** The label of the option this value selects, if it is one. */
export function optionLabel(def: ParamDef | undefined, value: number): string | undefined {
  return def?.v?.find(([v]) => v === value)?.[1];
}

/** Bit numbers set in a value (non-negative whole numbers only). */
export function bitsOf(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) return [];
  const out: number[] = [];
  // Parameters are 32-bit at most; avoid JS's 32-bit signed shifts.
  for (let bit = 0, v = value; v > 0 && bit < 64; bit++, v = Math.floor(v / 2)) if (v % 2 === 1) out.push(bit);
  return out;
}

/** Labels of the named bits a value sets. */
export function bitLabels(def: ParamDef | undefined, value: number): string[] {
  if (!def?.b) return [];
  const set = new Set(bitsOf(value));
  return def.b.filter(([bit]) => set.has(bit)).map(([, label]) => label);
}

/** Toggle one bit of a bitmask value. */
export function withBit(value: number, bit: number, on: boolean): number {
  const p = 2 ** bit;
  const has = Math.floor(Math.max(0, value) / p) % 2 === 1;
  const base = Math.max(0, Math.trunc(value));
  if (on === has) return base;
  return on ? base + p : base - p;
}

/** One line saying what the value means: "Quad", "GPS, Compass", "15 m/s". */
export function describeValue(_meta: MetaSet | null | undefined, def: ParamDef | undefined, value: number | undefined): string {
  if (value === undefined) return "";
  const opt = optionLabel(def, value);
  if (opt) return opt;
  if (def?.b) {
    if (value === 0) return "None";
    const labels = bitLabels(def, value);
    if (labels.length) return labels.length > 3 ? `${labels.slice(0, 3).join(", ")} +${labels.length - 3}` : labels.join(", ");
  }
  return def?.u ? `${trimNum(value)} ${def.u}` : trimNum(value);
}

/* ---------------- Checking a value ---------------- */

/** MAV_PARAM_TYPE: how the flight controller stores the value. */
const INT_LIMITS: Record<number, [number, number]> = {
  1: [0, 255], // UINT8
  2: [-128, 127], // INT8
  3: [0, 65535], // UINT16
  4: [-32768, 32767], // INT16
  5: [0, 4294967295], // UINT32
  6: [-2147483648, 2147483647], // INT32
};

export type CheckLevel = "error" | "outside" | "warn";
export interface Check {
  /** error: cannot be sent. outside: beyond the documented range, needs an explicit override. warn: worth a look. */
  level: CheckLevel;
  text: string;
}

/**
 * What is wrong with writing `value` to this parameter, worst first. `type` is
 * the MAV_PARAM_TYPE the flight controller reported for it, when known.
 */
export function checkValue(def: ParamDef | undefined, value: number, type?: number): Check[] {
  const out: Check[] = [];
  if (!Number.isFinite(value)) return [{ level: "error", text: "Not a number." }];
  if (def?.ro) out.push({ level: "error", text: "Read-only: the flight controller sets this itself." });

  const lim = type !== undefined ? INT_LIMITS[type] : undefined;
  const wantsWhole = !!lim || !!def?.b;
  if (wantsWhole && !Number.isInteger(value)) out.push({ level: "error", text: "Must be a whole number." });
  if (lim && (value < lim[0] || value > lim[1])) out.push({ level: "error", text: `Too large for this setting: it holds ${lim[0]} to ${lim[1]}.` });

  if (def?.r) {
    const [lo, hi] = def.r;
    const isOption = !!optionLabel(def, value);
    if (!isOption && (value < lo || value > hi)) {
      out.push({ level: "outside", text: `Outside the documented range, ${trimNum(lo)} to ${trimNum(hi)}${def.u ? ` ${def.u}` : ""}.` });
    }
  } else if (def?.v && !def.b && !optionLabel(def, value)) {
    out.push({ level: "warn", text: "Not one of the documented options." });
  }

  if (def?.b && Number.isInteger(value)) {
    if (value < 0) {
      out.push({ level: "warn", text: "A negative bitmask sets every bit; check the description says that is allowed." });
    } else {
      const named = new Set(def.b.map(([bit]) => bit));
      const extra = bitsOf(value).filter((bit) => !named.has(bit));
      if (extra.length) out.push({ level: "warn", text: `Sets bit${extra.length > 1 ? "s" : ""} ${extra.join(", ")}, which ArduPilot does not document.` });
    }
  }
  const order: Record<CheckLevel, number> = { error: 0, outside: 1, warn: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** The worst level among checks, or null when there is nothing to say. */
export const worst = (checks: Check[]): CheckLevel | null => checks[0]?.level ?? null;

/* ---------------- Groups ---------------- */

const GROUP_ALIASES: Record<string, string> = { BATTA: "BATT", BATTB: "BATT", BATTC: "BATT", BATTD: "BATT", BATTE: "BATT", BATTF: "BATT", BATTG: "BATT", RNGFNDA: "RNGFND", ARM: "ARMING" };

/** The group a parameter belongs to: SERVO3_FUNCTION → SERVO, BATT2_MONITOR → BATT. */
export function groupOf(name: string): string {
  const head = name.split("_")[0].replace(/\d+$/, "") || name;
  return GROUP_ALIASES[head] ?? head;
}

/** Plain titles for the groups a Copter user meets most. Others show their prefix. */
export const GROUP_TITLES: Record<string, string> = {
  ACRO: "Acro mode",
  ANGLE: "Lean angle",
  AROT: "Autorotation",
  AUTO: "Auto mode",
  AVD: "ADS-B avoidance",
  BCN: "Beacons",
  BTN: "Buttons",
  CUST: "Custom board orientation",
  DDS: "ROS 2 (DDS)",
  DEV: "Developer options",
  DID: "Remote ID",
  EAHRS: "External AHRS",
  EFI: "Engine (EFI)",
  ESRC: "EKF sources",
  FILT: "Notch filters",
  FRSKY: "FrSky telemetry",
  H: "Helicopter",
  MSP: "MSP telemetry and OSD",
  NET: "Networking",
  PLDP: "Payload place",
  SPRAY: "Sprayer",
  TCAL: "Temperature calibration",
  TERR: "Terrain",
  TMODE: "Toy mode",
  VID: "Video",
  WEB: "Web server",
  ADSB: "ADS-B traffic",
  AHRS: "Attitude estimate (AHRS)",
  ARMING: "Arming checks",
  ATC: "Attitude control",
  AUTOTUNE: "AutoTune",
  AVOID: "Obstacle avoidance",
  BARO: "Barometer",
  BATT: "Battery monitor",
  BRD: "Board",
  CAM: "Camera",
  CAN: "CAN bus",
  CHUTE: "Parachute",
  CIRCLE: "Circle mode",
  COMPASS: "Compass",
  DISARM: "Disarming",
  EK: "EKF (position estimate)",
  ESC: "ESC telemetry",
  FENCE: "Geofence",
  FFT: "In-flight vibration analysis (FFT)",
  FHLD: "FlowHold mode",
  FLOW: "Optical flow",
  FLTMODE: "Flight modes",
  FOLL: "Follow mode",
  FORMAT: "Parameter format",
  FRAME: "Frame",
  FS: "Failsafes",
  GCS: "Ground station",
  GEN: "Generator",
  GND: "Ground",
  GPS: "GPS",
  GRIP: "Gripper",
  GUID: "Guided mode",
  INS: "Inertial sensors (IMU)",
  LAND: "Landing",
  LGR: "Landing gear",
  LOG: "Onboard logging",
  LOIT: "Loiter mode",
  MAV: "MAVLink",
  MIS: "Mission",
  MNT: "Camera mount (gimbal)",
  MOT: "Motors",
  NTF: "Lights and buzzer",
  OA: "Path planning around obstacles",
  OSD: "On-screen display",
  PHLD: "PosHold mode",
  PILOT: "Pilot input",
  PLND: "Precision landing",
  PRX: "Proximity sensors",
  PSC: "Position control",
  RALLY: "Rally points",
  RC: "RC input",
  RCMAP: "RC channel mapping",
  RELAY: "Relays",
  RNGFND: "Rangefinder",
  RPM: "RPM sensors",
  RSSI: "Radio signal (RSSI)",
  RTL: "Return to launch",
  SCHED: "Scheduler",
  SCR: "Lua scripts",
  SERIAL: "Serial ports",
  SERVO: "Outputs (servos and motors)",
  SID: "System identification",
  SIM: "Simulation (SITL only)",
  SIMPLE: "Simple mode",
  SRTL: "SmartRTL",
  STAT: "Statistics",
  SURFTRAK: "Surface tracking",
  SYSID: "System ID",
  TEMP: "Temperature sensors",
  TERRAIN: "Terrain",
  THR: "Throttle",
  THROW: "Throw mode",
  TKOFF: "Take-off",
  TUNE: "In-flight tuning knob",
  VISO: "Visual odometry",
  VTX: "Video transmitter",
  WINCH: "Winch",
  WP: "Waypoint navigation",
  WPNAV: "Waypoint navigation",
  WVANE: "Weathervaning",
  ZIGZ: "ZigZag mode",
};

export const groupTitle = (g: string) => GROUP_TITLES[g] ?? g;

/* ---------------- Search ---------------- */

/** Does a parameter match a search? Name, display name and description all count. */
export function matchesSearch(name: string, def: ParamDef | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  if (!def) return false;
  const words = q.split(/\s+/);
  const hay = `${def.n} ${def.d}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
