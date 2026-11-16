/*
  What ArduPilot's numbers in a log mean, from its source (ArduCopter 4.7:
  ArduCopter/mode.h, libraries/AP_Vehicle/ModeReason.h,
  libraries/AP_Logger/AP_Logger.h) and the ERR table in ArduPilot's
  "Diagnosing problems using logs".
*/

export const COPTER_MODE: Record<number, string> = {
  0: "Stabilize", 1: "Acro", 2: "AltHold", 3: "Auto", 4: "Guided", 5: "Loiter", 6: "RTL", 7: "Circle", 9: "Land",
  11: "Drift", 13: "Sport", 14: "Flip", 15: "AutoTune", 16: "PosHold", 17: "Brake", 18: "Throw", 19: "Avoid_ADSB",
  20: "Guided_NoGPS", 21: "Smart_RTL", 22: "FlowHold", 23: "Follow", 24: "ZigZag", 25: "SystemID", 26: "AutoRotate",
  27: "Auto_RTL", 28: "Turtle",
};

export const modeName = (n: number) => COPTER_MODE[n] ?? `Mode ${n}`;

/** Why the mode changed (MODE.Rsn). */
export const MODE_REASON: Record<number, string> = {
  0: "unknown", 1: "radio switch", 2: "ground station", 3: "radio failsafe", 4: "battery failsafe", 5: "ground station failsafe",
  6: "EKF failsafe", 7: "GPS glitch", 8: "mission end", 9: "throttle land escape", 10: "fence breach", 11: "terrain failsafe",
  12: "brake timeout", 13: "flip complete", 14: "avoidance", 15: "avoidance recovery", 16: "throw complete", 17: "terminate",
  18: "toy mode", 19: "crash failsafe", 25: "failsafe", 26: "initialised", 30: "servo test", 31: "startup", 32: "script",
  33: "unavailable", 41: "mission command", 43: "fence return", 45: "auto RTL exit", 48: "radio failsafe recovery",
  50: "dead-reckoning failsafe", 51: "takeoff failsafe", 52: "DDS command", 53: "aux switch", 55: "fence re-enable",
};

/** Mode reasons that mean a failsafe took over. */
export const FAILSAFE_REASONS = new Set([3, 4, 5, 6, 7, 10, 11, 19, 25, 50, 51]);

/** EV ids. */
export const EVENT: Record<number, string> = {
  10: "Armed", 11: "Disarmed", 15: "Throttle up after arming", 17: "Landing detected (maybe)", 18: "Landed", 19: "GPS lost",
  21: "Flip started", 22: "Flip finished", 25: "Home set", 26: "Simple mode on", 27: "Simple mode off", 28: "Took off",
  29: "Super Simple mode on", 30: "AutoTune started", 31: "AutoTune off", 32: "AutoTune restarted", 33: "AutoTune succeeded",
  34: "AutoTune failed", 35: "AutoTune reached a limit", 36: "AutoTune pilot testing", 37: "AutoTune gains saved",
  38: "Trim saved", 39: "Waypoint saved", 41: "Fence on", 42: "Fence off", 46: "Gripper grab", 47: "Gripper release",
  49: "Parachute disabled", 50: "Parachute enabled", 51: "Parachute released", 52: "Landing gear down", 53: "Landing gear up",
  54: "Motors emergency stopped", 55: "Motors emergency stop cleared", 56: "Motor interlock off", 57: "Motor interlock on",
  60: "EKF altitude reset", 61: "Landing cancelled by pilot", 62: "EKF yaw reset", 67: "GPS primary changed",
  73: "Landing repositioned", 74: "Standby on", 75: "Standby off",
  76: "Fence ceiling on", 77: "Fence ceiling off", 78: "Fence circle on", 79: "Fence circle off", 80: "Fence floor on",
  81: "Fence floor off", 82: "Fence polygons on", 83: "Fence polygons off",
  85: "EKF sources set to primary", 86: "EKF sources set to secondary", 87: "EKF sources set to tertiary",
};

export const EV_ARMED = 10;
export const EV_DISARMED = 11;
export const EV_LANDED = 18;
export const EV_NOT_LANDED = 28;

export const ERR_SUBSYSTEM: Record<number, string> = {
  1: "Main loop", 2: "Radio", 3: "Compass", 4: "Optical flow", 5: "Radio failsafe", 6: "Battery failsafe", 7: "GPS failsafe",
  8: "Ground station failsafe", 9: "Fence", 10: "Flight mode change", 11: "GPS", 12: "Crash check", 13: "Flip",
  14: "AutoTune", 15: "Parachute", 16: "EKF check", 17: "EKF failsafe", 18: "Barometer", 19: "CPU load",
  20: "ADS-B failsafe", 21: "Terrain data", 22: "Navigation", 23: "Terrain failsafe", 24: "EKF primary",
  25: "Thrust loss check", 26: "Sensor failsafe", 27: "Leak failsafe", 28: "Pilot input", 29: "Vibration failsafe",
  30: "Internal error", 31: "Dead-reckoning failsafe",
};

export interface ErrMeaning {
  text: string;
  /** "bad" a problem happened, "ok" it cleared, "note" for information. */
  tone: "bad" | "warn" | "ok" | "note";
}

/** The meaning of one ERR row (Subsys, ECode). */
export function errMeaning(sub: number, code: number): ErrMeaning {
  const s = ERR_SUBSYSTEM[sub] ?? `Subsystem ${sub}`;
  if (sub === 10) return { text: `Could not change to ${modeName(code)} mode (position estimate not good enough)`, tone: "warn" };
  if (sub === 24) return { text: `EKF lane ${code + 1} became primary`, tone: "note" };
  if (code === 0) return { text: `${s}: cleared`, tone: "ok" };
  switch (sub) {
    case 2: return code === 2 ? { text: "Radio: no frames from the receiver for 2 s", tone: "bad" } : { text: `Radio error ${code}`, tone: "warn" };
    case 3: return { text: code === 1 ? "Compass failed to start" : code === 4 ? "Compass unhealthy (could not be read)" : `Compass error ${code}`, tone: "bad" };
    case 5: case 6: case 7: case 8: case 17: case 20: case 23: case 26: case 27: case 31:
      return { text: `${s} triggered`, tone: "bad" };
    case 9: return { text: `Fence breached: ${["", "ceiling", "circle", "ceiling and circle", "polygon", "floor"][code] ?? `type ${code}`}`, tone: "bad" };
    case 11: return code === 2 ? { text: "GPS glitch", tone: "bad" } : { text: `GPS error ${code}`, tone: "warn" };
    case 12: return { text: code === 1 ? "Crash detected: motors disarmed" : code === 2 ? "Loss of control detected" : `Crash check ${code}`, tone: "bad" };
    case 13: return { text: "Flip abandoned", tone: "warn" };
    case 15: return { text: code === 2 ? "Parachute not released: too low" : code === 3 ? "Parachute not released: landed" : `Parachute error ${code}`, tone: "warn" };
    case 16: return code === 2 ? { text: "EKF variance too high", tone: "bad" } : { text: `EKF check ${code}`, tone: "warn" };
    case 18: return { text: code === 2 ? "Barometer glitch" : code === 4 ? "Barometer unhealthy" : `Barometer error ${code}`, tone: "bad" };
    case 19: return { text: "CPU load watchdog: main loop too slow", tone: "bad" };
    case 21: return { text: "Terrain data missing", tone: "warn" };
    case 22: return { text: ["", "", "Navigation: could not set destination", "Navigation: RTL restarted", "Navigation: circle could not start", "Navigation: destination outside the fence", "Navigation: RTL needs a rangefinder"][code] ?? `Navigation error ${code}`, tone: "warn" };
    case 25: return { text: "Thrust loss detected: high throttle, still descending", tone: "bad" };
    case 29: return { text: code === 1 ? "Vibration compensation switched on" : `Vibration failsafe ${code}`, tone: "bad" };
    case 30: return { text: "Internal error in the flight software", tone: "bad" };
    default: return { text: `${s}: error ${code}`, tone: "warn" };
  }
}

/** GPS.Status / GPS_RAW_INT.fix_type. */
export const GPS_FIX: Record<number, string> = { 0: "no GPS", 1: "no fix", 2: "2D fix", 3: "3D fix", 4: "DGPS", 5: "RTK float", 6: "RTK fixed" };

/** Motors per ArduCopter FRAME_CLASS. */
export const FRAME_MOTORS: Record<number, number> = { 1: 4, 2: 6, 3: 8, 4: 8, 5: 6, 7: 3, 10: 1, 11: 2, 12: 12, 14: 10 };
export const FRAME_CLASS: Record<number, string> = {
  0: "undefined", 1: "quad", 2: "hexa", 3: "octa", 4: "octaquad", 5: "Y6", 6: "heli", 7: "tri", 8: "single", 9: "coax",
  10: "bicopter", 11: "heli dual", 12: "dodecahexa", 13: "heli quad", 14: "deca", 15: "scripting matrix", 16: "6DoF scripting", 17: "dynamic scripting",
};
