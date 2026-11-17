import { derive, type Airframe } from "./airframe";
import { SERVO_PARAM_DEFS, SERVO_RANGES, SERVO_TYPES } from "./servos";

/*
  The parameters the virtual flight controller understands, with ArduCopter's
  names, units and defaults (Copter 4.x). Only parameters that change what the
  simulated aircraft does are here: a parameter the model ignores would be a
  setting that appears to work and does nothing.

  Two groups are not ArduCopter defaults. The rate gains are scaled to the
  airframe, as a first tune would leave them, because the stock 0.135 is tuned
  for a mid-sized frame and oscillates on a small powerful one. And
  MOT_THST_HOVER starts at the value the autopilot would learn in flight.
*/
export interface ParamDef {
  name: string;
  def: number;
  help: string;
}

export const PARAM_DEFS: ParamDef[] = [
  { name: "ANGLE_MAX", def: 3000, help: "Maximum lean angle, centidegrees" },
  { name: "ATC_ANG_RLL_P", def: 4.5, help: "Roll angle gain" },
  { name: "ATC_ANG_PIT_P", def: 4.5, help: "Pitch angle gain" },
  { name: "ATC_ANG_YAW_P", def: 4.5, help: "Yaw angle gain" },
  { name: "ATC_RAT_RLL_P", def: 0.135, help: "Roll rate P" },
  { name: "ATC_RAT_RLL_I", def: 0.135, help: "Roll rate I" },
  { name: "ATC_RAT_RLL_D", def: 0.0036, help: "Roll rate D" },
  { name: "ATC_RAT_PIT_P", def: 0.135, help: "Pitch rate P" },
  { name: "ATC_RAT_PIT_I", def: 0.135, help: "Pitch rate I" },
  { name: "ATC_RAT_PIT_D", def: 0.0036, help: "Pitch rate D" },
  { name: "ATC_RAT_YAW_P", def: 0.18, help: "Yaw rate P" },
  { name: "ATC_RAT_YAW_I", def: 0.018, help: "Yaw rate I" },
  { name: "ATC_ACCEL_R_MAX", def: 110000, help: "Roll acceleration limit, centidegrees/s²" },
  { name: "ATC_ACCEL_P_MAX", def: 110000, help: "Pitch acceleration limit, centidegrees/s²" },
  { name: "ATC_ACCEL_Y_MAX", def: 27000, help: "Yaw acceleration limit, centidegrees/s²" },
  { name: "PSC_POSXY_P", def: 1.0, help: "Horizontal position gain" },
  { name: "PSC_VELXY_P", def: 2.0, help: "Horizontal velocity P" },
  { name: "PSC_VELXY_I", def: 1.0, help: "Horizontal velocity I" },
  { name: "PSC_VELXY_D", def: 0.5, help: "Horizontal velocity D" },
  { name: "PSC_POSZ_P", def: 1.0, help: "Altitude gain" },
  { name: "PSC_VELZ_P", def: 5.0, help: "Climb rate gain" },
  { name: "PSC_ACCZ_P", def: 0.5, help: "Vertical acceleration P" },
  { name: "PSC_ACCZ_I", def: 1.0, help: "Vertical acceleration I" },
  { name: "WPNAV_SPEED", def: 1000, help: "Mission horizontal speed, cm/s" },
  { name: "WPNAV_SPEED_UP", def: 250, help: "Mission climb speed, cm/s" },
  { name: "WPNAV_SPEED_DN", def: 150, help: "Mission descent speed, cm/s" },
  { name: "WPNAV_ACCEL", def: 250, help: "Mission horizontal acceleration, cm/s²" },
  { name: "WPNAV_RADIUS", def: 200, help: "Waypoint reached radius, cm" },
  { name: "WPNAV_ACCEL_Z", def: 100, help: "Mission vertical acceleration, cm/s²" },
  { name: "WPNAV_JERK", def: 1, help: "Mission horizontal jerk, m/s³" },
  { name: "LOIT_SPEED", def: 1250, help: "Loiter maximum speed, cm/s" },
  { name: "PILOT_SPEED_UP", def: 250, help: "Pilot climb speed, cm/s" },
  { name: "RTL_ALT", def: 1500, help: "Return altitude, cm" },
  { name: "RTL_SPEED", def: 0, help: "Return speed, cm/s (0 uses WPNAV_SPEED)" },
  { name: "RTL_LOIT_TIME", def: 5000, help: "Hover above home before landing, ms" },
  { name: "RTL_ALT_FINAL", def: 0, help: "Final return altitude, cm (0 lands)" },
  { name: "LAND_SPEED", def: 50, help: "Final landing speed, cm/s" },
  { name: "LAND_ALT_LOW", def: 1000, help: "Height at which the landing slows, cm" },
  { name: "DISARM_DELAY", def: 10, help: "Auto-disarm when sitting armed, s" },
  { name: "MOT_SPIN_ARM", def: 0.1, help: "Motor output when armed" },
  { name: "MOT_SPIN_MIN", def: 0.15, help: "Lowest motor output in flight" },
  { name: "MOT_THST_HOVER", def: 0.35, help: "Throttle that holds a hover" },
  { name: "MOT_SPOOL_TIME", def: 0.5, help: "Motor spool-up time before a take-off, s" },
  { name: "TKOFF_SLEW_TIME", def: 2, help: "Take-off throttle ramp, zero to full, s" },
  { name: "BATT_CAPACITY", def: 3300, help: "Battery capacity, mAh" },
  { name: "BATT_LOW_VOLT", def: 10.5, help: "Low battery voltage (0 disables)" },
  { name: "BATT_LOW_MAH", def: 0, help: "Low battery remaining capacity, mAh (0 disables)" },
  { name: "BATT_CRT_VOLT", def: 0, help: "Critical battery voltage (0 disables)" },
  { name: "BATT_CRT_MAH", def: 0, help: "Critical remaining capacity, mAh (0 disables)" },
  { name: "BATT_LOW_TIMER", def: 10, help: "Seconds below the voltage before it counts" },
  { name: "BATT_FS_LOW_ACT", def: 0, help: "Low battery action: 0 none, 1 Land, 2 RTL" },
  { name: "BATT_FS_CRT_ACT", def: 0, help: "Critical battery action: 0 none, 1 Land, 2 RTL" },
  { name: "BATT_ARM_VOLT", def: 0, help: "Refuse to arm below this voltage (0 disables)" },
  { name: "FS_THR_ENABLE", def: 1, help: "Radio failsafe: 0 off, 1 RTL, 3 Land" },
  { name: "FS_GCS_ENABLE", def: 0, help: "Ground station failsafe: 0 off, 1 RTL, 5 Land" },
  { name: "FS_GCS_TIMEOUT", def: 5, help: "Seconds without a ground station heartbeat" },
  { name: "FS_OPTIONS", def: 16, help: "Failsafe options bitmask" },
  { name: "FS_EKF_ACTION", def: 1, help: "Position lost: 1 Land, 2 AltHold, 3 Land" },
  { name: "FS_CRASH_CHECK", def: 1, help: "Disarm when a crash is detected" },
  { name: "RC_FS_TIMEOUT", def: 1, help: "Seconds of radio loss before failsafe" },
  { name: "FENCE_ENABLE", def: 0, help: "Geofence on" },
  { name: "FENCE_TYPE", def: 7, help: "Bitmask: 1 max altitude, 2 circle round home, 4 zones, 8 min altitude" },
  { name: "FENCE_ACTION", def: 1, help: "Breach action: 0 report, 1 RTL or Land, 2 Land, 3 SmartRTL or RTL, 4 Brake, 5 SmartRTL or Land" },
  { name: "FENCE_ALT_MAX", def: 100, help: "Fence ceiling, m" },
  { name: "FENCE_ALT_MIN", def: -10, help: "Fence floor, m; switches on once climbed above" },
  { name: "FENCE_OPTIONS", def: 0, help: "Bitmask: 2 inside any keep-in zone is enough" },
  { name: "FENCE_AUTOENABLE", def: 0, help: "3: fence on when armed" },
  { name: "FENCE_RADIUS", def: 300, help: "Fence radius, m" },
  { name: "FENCE_MARGIN", def: 2, help: "Fence margin, m" },
  { name: "ARMING_CHECK", def: 1, help: "Pre-arm checks on" },
  { name: "AUTO_OPTIONS", def: 0, help: "Bitmask: 1 allow arming in Auto, 2 allow take-off without raising throttle" },
  // Lowering a payload to the ground (NAV_PAYLOAD_PLACE).
  { name: "PLDP_THRESH", def: 0.9, help: "Touchdown when the descent's thrust falls below this share of its reference" },
  { name: "PLDP_RNG_MAX", def: 0, help: "Release only below this rangefinder height, m (0: no rangefinder needed)" },
  { name: "PLDP_DELAY", def: 0, help: "Seconds to wait after the release before climbing back" },
  { name: "PLDP_SPEED_DN", def: 0, help: "Lowering speed, m/s (0: the landing speed)" },
  { name: "SYSID_THISMAV", def: 1, help: "MAVLink system id" },
  // Servo outputs, transmitter switches and the gripper (see servos.ts).
  ...SERVO_PARAM_DEFS,
];

/*
  The range each parameter is held to. ArduCopter documents a range for every
  parameter and a ground station warns outside it; the simulator enforces it,
  because a model fed a negative speed or a NaN produces numbers that mean
  nothing, and says nothing is wrong.
*/
const RANGE: Record<string, [number, number]> = {
  ANGLE_MAX: [1000, 8000],
  ATC_ACCEL_R_MAX: [0, 500000],
  ATC_ACCEL_P_MAX: [0, 500000],
  ATC_ACCEL_Y_MAX: [0, 500000],
  WPNAV_SPEED: [20, 2000],
  WPNAV_SPEED_UP: [10, 1000],
  WPNAV_SPEED_DN: [10, 500],
  WPNAV_ACCEL: [50, 500],
  WPNAV_RADIUS: [5, 1000],
  WPNAV_ACCEL_Z: [50, 500],
  WPNAV_JERK: [1, 20],
  LOIT_SPEED: [20, 3500],
  PILOT_SPEED_UP: [50, 500],
  RTL_ALT: [0, 300000],
  RTL_SPEED: [0, 2000],
  RTL_LOIT_TIME: [0, 60000],
  RTL_ALT_FINAL: [0, 1000],
  LAND_SPEED: [30, 200],
  LAND_ALT_LOW: [100, 10000],
  DISARM_DELAY: [0, 127],
  MOT_SPIN_ARM: [0, 0.2],
  MOT_SPIN_MIN: [0, 0.3],
  MOT_THST_HOVER: [0.02, 0.8],
  MOT_SPOOL_TIME: [0.05, 2],
  TKOFF_SLEW_TIME: [0.25, 5],
  BATT_LOW_TIMER: [0, 120],
  FS_GCS_TIMEOUT: [2, 120],
  RC_FS_TIMEOUT: [0.5, 10],
  FENCE_ALT_MAX: [10, 1000],
  FENCE_ALT_MIN: [-100, 100],
  FENCE_RADIUS: [30, 10000],
  FENCE_MARGIN: [1, 10],
  // ArduCopter's documented ranges.
  PLDP_THRESH: [0.5, 0.9],
  PLDP_RNG_MAX: [0, 100],
  PLDP_DELAY: [0, 120],
  PLDP_SPEED_DN: [0, 5],
  ...SERVO_RANGES,
};

const DEF = new Map(PARAM_DEFS.map((d) => [d.name, d.def]));

/*
  How ArduCopter 4.6 stores each whole-number setting, as MAV_PARAM_TYPE
  (2 INT8, 4 INT16, 6 INT32), read from the declarations in its source. Every
  other parameter here is a float (9). The virtual aircraft reports these
  types and stores values the way the firmware does, so a page that would
  send 2.5 to an integer setting finds out here, not on the bench.
*/
export const PARAM_TYPES: Record<string, number> = {
  ANGLE_MAX: 4, RTL_ALT: 6, RTL_SPEED: 4, RTL_LOIT_TIME: 6, RTL_ALT_FINAL: 4, LAND_SPEED: 4, LAND_ALT_LOW: 4,
  DISARM_DELAY: 2, PILOT_SPEED_UP: 4, BATT_CAPACITY: 6, BATT_LOW_TIMER: 2, BATT_FS_LOW_ACT: 2, BATT_FS_CRT_ACT: 2,
  FS_THR_ENABLE: 2, FS_GCS_ENABLE: 2, FS_OPTIONS: 6, FS_EKF_ACTION: 2, FS_CRASH_CHECK: 2, FENCE_ENABLE: 2,
  FENCE_TYPE: 2, FENCE_ACTION: 2, FENCE_OPTIONS: 4, FENCE_AUTOENABLE: 2, ARMING_CHECK: 6, AUTO_OPTIONS: 6, SYSID_THISMAV: 4,
  ...SERVO_TYPES,
};
const INT_RANGE: Record<number, [number, number]> = { 2: [-128, 127], 4: [-32768, 32767], 6: [-2147483648, 2147483647] };

/**
 * What the firmware keeps when a ground station writes `value`: whole-number
 * settings are truncated after a 0.01 nudge (AP_Param::set_float) and held to
 * what the type can hold; floats are stored as 32-bit floats.
 */
export function storedValue(name: string, value: number): number {
  const t = PARAM_TYPES[name];
  if (t === undefined) return Math.fround(value);
  const [lo, hi] = INT_RANGE[t];
  const n = Math.trunc(value + (value < 0 ? -0.01 : 0.01));
  return Math.min(hi, Math.max(lo, n));
}

/** The value the simulator will use for a parameter, held inside its range. */
export function sanitizeParam(name: string, value: number): number {
  if (!Number.isFinite(value)) return DEF.get(name) ?? 0;
  const r = RANGE[name];
  if (r) return Math.min(r[1], Math.max(r[0], value));
  // Gains, thresholds and capacities: never negative.
  return Math.max(0, value);
}

/** Hold a whole set inside its ranges, and say which values had to be changed. */
export function sanitizeParams(p: Params): { params: Params; notes: string[] } {
  const out: Params = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    out[k] = sanitizeParam(k, v);
    if (out[k] !== v && DEF.has(k)) notes.push(`${k} was ${Number.isFinite(v) ? v : "not a number"}, outside its range; ${out[k]} was used.`);
  }
  return { params: out, notes };
}

export type Params = Record<string, number>;

/** Parameters for a virtual aircraft of this build, as a first tune would leave it. */
export function defaultParams(af: Airframe): Params {
  const p: Params = {};
  for (const d of PARAM_DEFS) p[d.name] = d.def;
  const dv = derive(af);
  /*
    Rate gain for the same closed-loop response on any frame: the stock gain
    suits a frame whose full roll command produces about 180 rad/s², and a
    frame with more authority needs proportionally less.
  */
  const authority = (2 * dv.a * af.motorMaxThrustN) / dv.Ixx;
  const scale = Math.min(1.2, Math.max(0.12, 180 / authority));
  for (const ax of ["RLL", "PIT"]) {
    p[`ATC_RAT_${ax}_P`] = round(0.135 * scale);
    p[`ATC_RAT_${ax}_I`] = round(0.135 * scale);
    p[`ATC_RAT_${ax}_D`] = round(0.0036 * scale);
  }
  const yawAuth = (2 * dv.kYaw * af.motorMaxThrustN) / dv.Izz;
  const ys = Math.min(2, Math.max(0.15, 9 / yawAuth));
  p.ATC_RAT_YAW_P = round(0.18 * ys);
  p.ATC_RAT_YAW_I = round(0.018 * ys);
  p.MOT_THST_HOVER = round(Math.min(0.8, Math.max(0.02, dv.hoverThrottle)));
  // An overpowered frame hovers below the stock idle and could never descend;
  // setting the idle under the hover point is part of any first tune.
  p.MOT_SPIN_MIN = round(Math.min(0.15, p.MOT_THST_HOVER * 0.5));
  p.MOT_SPIN_ARM = round(Math.min(0.1, p.MOT_SPIN_MIN * 0.7));
  p.BATT_CAPACITY = af.capacityMah;
  return p;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
