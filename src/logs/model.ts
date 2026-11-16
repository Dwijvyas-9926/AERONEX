/*
  One flight, whatever log it came from. The tables of a DataFlash .bin or a
  MAVLink .tlog are mapped onto the same few series (attitude, position, GPS,
  battery, vibration, motor outputs, compass, EKF, board power, CPU load),
  converted to one set of units, plus a single timeline of modes, events,
  errors and messages. The checks, the charts and the replay all read this.

  Units: angles in degrees, distances in metres, altitudes in metres (AMSL
  unless named rel), speeds in m/s, volts, amps, mAh, magnetic field in
  milligauss, throttle 0..1, motor outputs in microseconds, time in seconds
  since the start of the log.

  A .bin is what the autopilot recorded on board, at full rate. A .tlog is what
  the ground station received over the link: fewer samples, no desired-vs-actual
  for every axis, no per-IMU detail. Where a series cannot be had from a .tlog it
  is left out rather than guessed, and the checks say what they could not test.
*/
import { EV_ARMED, EV_DISARMED, EV_LANDED, EV_NOT_LANDED, EVENT, errMeaning, FRAME_MOTORS, MODE_REASON, modeName } from "./ardupilot";
import { isNumeric, num, scaled, text, type RawLog, type Table } from "./types";

export type Tone = "bad" | "warn" | "ok" | "note";

export interface Sampled {
  t: Float64Array;
}
export interface Attitude extends Sampled {
  roll: Float64Array;
  pitch: Float64Array;
  yaw: Float64Array;
  /** What the controller asked for, sample by sample (NaN where not known). */
  desRoll: Float64Array;
  desPitch: Float64Array;
  desYaw: Float64Array | null;
}
export interface Position extends Sampled {
  lat: Float64Array;
  lng: Float64Array;
  /** Metres above mean sea level. */
  alt: Float64Array;
  /** Metres above home, NaN when not known. */
  rel: Float64Array;
}
export interface GpsTrack extends Sampled {
  instance: number;
  /** Fix type: 0 no GPS, 1 no fix, 2 2D, 3 3D, 4 DGPS, 5 RTK float, 6 RTK fixed. */
  status: Float64Array;
  sats: Float64Array;
  /** Horizontal dilution of precision, NaN when not known. */
  hdop: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  alt: Float64Array;
  speed: Float64Array;
}
export interface Battery extends Sampled {
  instance: number;
  volt: Float64Array;
  /** Amps, NaN when the battery monitor has no current sensor. */
  curr: Float64Array;
  /** mAh used since boot, NaN when not known. */
  used: Float64Array;
  /** Percent left as the autopilot estimates it, NaN when not known. */
  remPct: Float64Array;
}
export interface Vibration extends Sampled {
  imu: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Accelerometer clipping events counted since boot. */
  clip: Float64Array;
}
export interface Control extends Sampled {
  /** Throttle sent to the motors, 0..1. */
  thrOut: Float64Array;
  /** The autopilot's estimate of hover throttle, 0..1 (NaN when not logged). */
  thrHover: Float64Array;
  /** Desired and actual altitude above home, and climb rates, NaN when not logged. */
  altTarget: Float64Array;
  alt: Float64Array;
  climbTarget: Float64Array;
  climb: Float64Array;
}
export interface Outputs extends Sampled {
  /** PWM per servo channel, ch[0] is output 1. */
  ch: Float64Array[];
}
export interface Compass extends Sampled {
  instance: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}
export interface Ekf extends Sampled {
  /** Innovation test ratios: below 1 passes, the EKF failsafe uses FS_EKF_THRESH (0.8). */
  vel: Float64Array;
  posH: Float64Array;
  posV: Float64Array;
  mag: Float64Array;
  /** Which EKF lane was primary, per sample, -1 when not known. */
  lane: Float64Array;
}
export interface BoardPower extends Sampled {
  vcc: Float64Array;
  vservo: Float64Array;
  flags: Float64Array;
}
export interface Load extends Sampled {
  /** Main loop load in percent. */
  load: Float64Array;
  /** Loops that ran over time in each reporting period, and the total in it. */
  slow: Float64Array;
  loops: Float64Array;
}

export interface ModeChange {
  t: number;
  mode: number;
  name: string;
  /** Why (MODE.Rsn), null when the log does not say. */
  reason: number | null;
}
export interface TimelineItem {
  t: number;
  kind: "mode" | "event" | "error" | "message" | "arm";
  text: string;
  tone: Tone;
  /** The raw id: event id, ERR subsystem*1000+code, mode number, MAVLink severity. */
  code: number;
}
export interface ParamInfo {
  name: string;
  /** The value when the log began. */
  value: number;
  /** The value at the end of the log. */
  last: number;
  /** The firmware default, when the log says (ArduPilot 4.7 and later). */
  default: number | null;
  /** Changes during the log after the first value. */
  changes: { t: number; value: number }[];
}
export interface MissionItem {
  seq: number;
  command: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  lat: number;
  lng: number;
  alt: number;
  frame: number;
}
export interface Span {
  from: number;
  /** End of the span; equals the log's end when the log ended in it (see `open`). */
  to: number;
  /** The log ended before this span did. */
  open: boolean;
}

export interface Flight {
  kind: RawLog["kind"];
  name: string;
  vehicle: "copter" | "plane" | "rover" | "sub" | "other" | "unknown";
  /** "ArduCopter V4.7.2 (fb773567)" or null. */
  firmware: string | null;
  /** [major, minor, patch] when known. */
  version: [number, number, number] | null;
  startUtc: number | null;
  duration: number;
  att: Attitude | null;
  pos: Position | null;
  gps: GpsTrack[];
  bat: Battery[];
  vibe: Vibration[];
  ctl: Control | null;
  out: Outputs | null;
  mag: Compass[];
  ekf: Ekf | null;
  power: BoardPower | null;
  load: Load | null;
  modes: ModeChange[];
  timeline: TimelineItem[];
  params: Map<string, ParamInfo>;
  armed: Span[];
  /** When the aircraft was off the ground, from the autopilot's land detector where logged. */
  flying: Span[];
  home: { lat: number; lng: number; alt: number } | null;
  mission: MissionItem[];
  /** Motor count from FRAME_CLASS, when known. */
  motors: number | null;
  /** The autopilot's system id, for a .tlog; null for a .bin. */
  sysid: number | null;
  raw: RawLog;
}

/* ───────────── helpers ───────────── */

/** Rows of a table grouped by its instance field (or one group 0 when it has none). */
function byInstance(t: Table): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const c = t.instance >= 0 ? t.cols[t.instance] : null;
  for (let r = 0; r < t.count; r++) {
    if (!Number.isFinite(t.t[r])) continue;
    const k = c && isNumeric(c) ? c[r] : 0;
    let a = out.get(k);
    if (!a) out.set(k, (a = []));
    a.push(r);
  }
  return out;
}

function pick(src: ArrayLike<number> | undefined, rows: number[], mult = 1): Float64Array {
  const out = new Float64Array(rows.length);
  if (!src) return out.fill(NaN);
  for (let i = 0; i < rows.length; i++) out[i] = src[rows[i]] * mult;
  return out;
}

const allRows = (t: Table) => {
  const rows: number[] = [];
  for (let r = 0; r < t.count; r++) if (Number.isFinite(t.t[r])) rows.push(r);
  return rows;
};

/** Index of the last sample at or before x (0 when x is before the first). */
export function indexAt(t: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0) return -1;
  if (x <= t[0]) return 0;
  if (x >= t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The value of a series at time x, linear between samples, NaN outside or when empty. */
export function valueAt(t: ArrayLike<number>, v: ArrayLike<number>, x: number): number {
  const n = t.length;
  if (!n || x < t[0] || x > t[n - 1]) return NaN;
  const i = indexAt(t, x);
  if (i >= n - 1 || t[i + 1] === t[i]) return v[i];
  const f = (x - t[i]) / (t[i + 1] - t[i]);
  return v[i] + (v[i + 1] - v[i]) * f;
}

/** Sample-and-hold of a series onto other times: the latest value at or before each, NaN before the first. */
function holdOnto(t: ArrayLike<number>, v: ArrayLike<number>, at: ArrayLike<number>, maxAge = Infinity): Float64Array {
  const out = new Float64Array(at.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < at.length; i++) {
    while (j + 1 < t.length && t[j + 1] <= at[i]) j++;
    if (t.length && t[j] <= at[i] && at[i] - t[j] <= maxAge) out[i] = v[j];
  }
  return out;
}

/** Wrap an angle in degrees to 0..360. */
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

function vehicleOf(fw: string | null): Flight["vehicle"] {
  if (!fw) return "unknown";
  if (/copter|heli/i.test(fw)) return "copter";
  if (/plane/i.test(fw)) return "plane";
  if (/rover/i.test(fw)) return "rover";
  if (/sub/i.test(fw)) return "sub";
  return "other";
}

/** MAV_TYPE from a heartbeat. */
function vehicleOfType(t: number | null): Flight["vehicle"] {
  if (t === null) return "unknown";
  if ([2, 3, 4, 13, 14, 15, 29, 35].includes(t)) return "copter";
  if ([1, 16, 19, 20, 21, 22, 23, 24, 25].includes(t)) return "plane";
  if (t === 10 || t === 11) return "rover";
  if (t === 12) return "sub";
  return "other";
}

const FW_RE = /\b(Ardu\w+|Rover|Blimp|AntennaTracker)\s+V(\d+)\.(\d+)\.(\d+)[^\n]*/;

function spansFrom(edges: { t: number; on: boolean }[], startOn: boolean, start: number, end: number): Span[] {
  const out: Span[] = [];
  let on = startOn;
  let from = start;
  for (const e of edges) {
    if (e.on && !on) {
      on = true;
      from = e.t;
    } else if (!e.on && on) {
      on = false;
      out.push({ from, to: e.t, open: false });
    }
  }
  if (on) out.push({ from, to: end, open: true });
  return out;
}

/** True when any value differs from the first. */
function changes(c: ArrayLike<number>): boolean {
  for (let i = 1; i < c.length; i++) if (c[i] !== c[0]) return true;
  return false;
}

/* ───────────── DataFlash ───────────── */

function fromBin(raw: RawLog): Flight {
  const T = (n: string) => raw.tables.get(n);
  const end = raw.duration;
  const timeline: TimelineItem[] = [];

  // Firmware: VER, else the banner in MSG.
  let firmware: string | null = null;
  let version: Flight["version"] = null;
  const ver = T("VER");
  const msgT = T("MSG");
  const msgText = text(msgT, "Message");
  if (ver) {
    const fws = text(ver, "FWS");
    if (fws?.[0]) firmware = fws[0];
    const maj = num(ver, "Maj"), min = num(ver, "Min"), pat = num(ver, "Pat");
    if (maj && min && pat) version = [maj[0], min[0], pat[0]];
  }
  if (msgText) {
    for (const m of msgText) {
      const hit = m && FW_RE.exec(m);
      if (hit) {
        firmware ??= hit[0].trim();
        version ??= [+hit[2], +hit[3], +hit[4]];
        break;
      }
    }
  }

  // Attitude.
  let att: Attitude | null = null;
  const A = T("ATT");
  if (A) {
    const rows = allRows(A);
    att = {
      t: pick(A.t, rows),
      roll: pick(num(A, "Roll"), rows),
      pitch: pick(num(A, "Pitch"), rows),
      yaw: pick(num(A, "Yaw"), rows),
      desRoll: pick(num(A, "DesRoll"), rows),
      desPitch: pick(num(A, "DesPitch"), rows),
      desYaw: num(A, "DesYaw") ? pick(num(A, "DesYaw"), rows) : null,
    };
  }

  // GPS: one table with an instance field (3.6+), or GPS and GPS2.
  const gps: GpsTrack[] = [];
  const gpsTable = (G: Table, fixedInstance: number | null) => {
    for (const [k, rows] of fixedInstance === null ? byInstance(G) : new Map([[fixedInstance, allRows(G)]])) {
      gps.push({
        instance: k,
        t: pick(G.t, rows),
        status: pick(num(G, "Status"), rows),
        sats: pick(num(G, "NSats"), rows),
        hdop: pick(num(G, "HDop") ?? num(G, "HDp"), rows),
        lat: pick(num(G, "Lat"), rows),
        lng: pick(num(G, "Lng"), rows),
        alt: pick(num(G, "Alt"), rows),
        speed: pick(num(G, "Spd"), rows),
      });
    }
  };
  if (T("GPS")) gpsTable(T("GPS")!, T("GPS")!.instance >= 0 ? null : 0);
  if (T("GPS2")) gpsTable(T("GPS2")!, 1);

  // Position: POS (3.5+), else AHR2, else the first GPS.
  let pos: Position | null = null;
  const P = T("POS");
  if (P && num(P, "Lat")) {
    const rows = allRows(P);
    pos = {
      t: pick(P.t, rows),
      lat: pick(num(P, "Lat"), rows),
      lng: pick(num(P, "Lng"), rows),
      alt: pick(num(P, "Alt"), rows),
      rel: pick(num(P, "RelHomeAlt"), rows),
    };
  } else if (gps[0]) {
    const g = gps[0];
    pos = { t: g.t, lat: g.lat, lng: g.lng, alt: g.alt, rel: new Float64Array(g.t.length).fill(NaN) };
  }

  // Batteries.
  const bat: Battery[] = [];
  const B = T("BAT") ?? T("CURR");
  if (B) {
    const ci = B.fields.indexOf("CurrTot");
    // mAh as stored when FMTU marks it Ah ×0.001; plain Ah only if it says Ah with no multiplier.
    const usedMult = ci >= 0 && B.units[ci] === "Ah" && B.mults[ci] === 1 ? 1000 : 1;
    for (const [k, rows] of byInstance(B)) {
      bat.push({
        instance: k,
        t: pick(B.t, rows),
        volt: pick(num(B, "Volt"), rows),
        curr: pick(num(B, "Curr"), rows),
        used: pick(num(B, "CurrTot"), rows, usedMult),
        remPct: pick(num(B, "RemPct"), rows),
      });
    }
  }

  // Vibration: one row per IMU (4.0+), or one row with Clip0..2 (older).
  const vibe: Vibration[] = [];
  const V = T("VIBE");
  if (V) {
    if (V.fields.includes("Clip0")) {
      const rows = allRows(V);
      for (let k = 0; k < 3; k++) {
        const clip = num(V, `Clip${k}`);
        if (!clip) continue;
        const nan = new Float64Array(rows.length).fill(NaN);
        vibe.push({
          imu: k,
          t: pick(V.t, rows),
          x: k === 0 ? pick(num(V, "VibeX"), rows) : nan,
          y: k === 0 ? pick(num(V, "VibeY"), rows) : nan,
          z: k === 0 ? pick(num(V, "VibeZ"), rows) : nan,
          clip: pick(clip, rows),
        });
      }
    } else {
      for (const [k, rows] of byInstance(V)) {
        vibe.push({ imu: k, t: pick(V.t, rows), x: pick(num(V, "VibeX"), rows), y: pick(num(V, "VibeY"), rows), z: pick(num(V, "VibeZ"), rows), clip: pick(num(V, "Clip"), rows) });
      }
    }
  }

  // Altitude and throttle control.
  let ctl: Control | null = null;
  const C = T("CTUN");
  if (C && num(C, "ThO")) {
    const rows = allRows(C);
    ctl = {
      t: pick(C.t, rows),
      thrOut: pick(num(C, "ThO"), rows),
      thrHover: pick(num(C, "ThH"), rows),
      altTarget: pick(num(C, "DAlt"), rows),
      alt: pick(num(C, "Alt"), rows),
      climbTarget: pick(scaled(C, "DCRt"), rows),
      climb: pick(scaled(C, "CRt"), rows),
    };
  }

  // Servo outputs.
  let out: Outputs | null = null;
  const R = T("RCOU");
  if (R) {
    const rows = allRows(R);
    const ch: Float64Array[] = [];
    for (let k = 1; k <= 32; k++) {
      const c = num(R, `C${k}`) ?? num(R, `Chan${k}`);
      if (!c) break;
      ch.push(pick(c, rows));
    }
    out = { t: pick(R.t, rows), ch };
  }

  // Compasses: one table with an instance field (4.0+), or MAG, MAG2, MAG3.
  const mag: Compass[] = [];
  const magTable = (M: Table, fixedInstance: number | null) => {
    const i = M.fields.indexOf("MagX");
    // Stored in milligauss; 4.x labels it Gauss with a ×0.001 multiplier.
    const m = M.units[i] === "Gauss" && M.mults[i] === 1 ? 1000 : 1;
    for (const [k, rows] of fixedInstance === null ? byInstance(M) : new Map([[fixedInstance, allRows(M)]])) {
      mag.push({ instance: k, t: pick(M.t, rows), x: pick(num(M, "MagX"), rows, m), y: pick(num(M, "MagY"), rows, m), z: pick(num(M, "MagZ"), rows, m) });
    }
  };
  if (T("MAG")) magTable(T("MAG")!, T("MAG")!.instance >= 0 ? null : 0);
  if (T("MAG2")) magTable(T("MAG2")!, 1);
  if (T("MAG3")) magTable(T("MAG3")!, 2);

  // EKF test ratios of the primary lane: EKF3 (XKF4) or EKF2 (NKF4).
  let ekf: Ekf | null = null;
  const K = T("XKF4") ?? T("NKF4");
  if (K && num(K, "SV")) {
    const lane = num(K, "C");
    const pri = num(K, "PI");
    const rows: number[] = [];
    for (let r = 0; r < K.count; r++) {
      if (!Number.isFinite(K.t[r])) continue;
      // PI names the primary lane from 4.0; before that, lane 0 is the one to read.
      if (!lane || (pri ? lane[r] === pri[r] : lane[r] === 0)) rows.push(r);
    }
    ekf = {
      t: pick(K.t, rows),
      vel: pick(num(K, "SV"), rows),
      posH: pick(num(K, "SP"), rows),
      posV: pick(num(K, "SH"), rows),
      mag: pick(num(K, "SM") ?? num(K, "SMX"), rows),
      lane: pri ? pick(pri, rows) : new Float64Array(rows.length).fill(lane ? 0 : -1),
    };
  }

  // Board power.
  let power: BoardPower | null = null;
  const W = T("POWR");
  if (W) {
    const rows = allRows(W);
    power = { t: pick(W.t, rows), vcc: pick(num(W, "Vcc"), rows), vservo: pick(num(W, "VServo"), rows), flags: pick(num(W, "Flags") ?? num(W, "Flag"), rows) };
  }

  // CPU load.
  let load: Load | null = null;
  const PM = T("PM");
  if (PM) {
    const rows = allRows(PM);
    const li = PM.fields.indexOf("Load");
    // Load is per mille as stored; FMTU marks it % ×0.1.
    const lm = li >= 0 && PM.mults[li] !== 1 ? PM.mults[li] : 0.1;
    load = { t: pick(PM.t, rows), load: pick(num(PM, "Load"), rows, lm), slow: pick(num(PM, "NLon"), rows), loops: pick(num(PM, "NLoop") ?? num(PM, "NL"), rows) };
  }

  // Modes.
  const modes: ModeChange[] = [];
  const M = T("MODE");
  if (M) {
    const mn = num(M, "ModeNum") ?? num(M, "Mode");
    const rs = num(M, "Rsn");
    for (const r of allRows(M)) {
      const mode = mn ? mn[r] : NaN;
      const reason = rs ? rs[r] : null;
      // The first row repeats when logging starts; keep one per change.
      const prev = modes[modes.length - 1];
      if (prev && prev.mode === mode && prev.reason === reason) continue;
      modes.push({ t: M.t[r], mode, name: modeName(mode), reason });
      timeline.push({ t: M.t[r], kind: "mode", text: `Mode ${modeName(mode)}${reason !== null ? ` (${MODE_REASON[reason] ?? `reason ${reason}`})` : ""}`, tone: "note", code: mode });
    }
  }

  // Events.
  const armEdges: { t: number; on: boolean }[] = [];
  const landEdges: { t: number; on: boolean }[] = [];
  const E = T("EV");
  if (E) {
    const id = num(E, "Id");
    for (const r of allRows(E)) {
      const v = id ? id[r] : NaN;
      const t = E.t[r];
      // 15 (auto-armed) is the throttle being raised after arming, not arming.
      if (v === EV_ARMED) armEdges.push({ t, on: true });
      if (v === EV_DISARMED) armEdges.push({ t, on: false });
      if (v === EV_NOT_LANDED) landEdges.push({ t, on: true });
      if (v === EV_LANDED) landEdges.push({ t, on: false });
      const bad = v === 19 || v === 54 || v === 51;
      const warn = v === 60 || v === 62 || v === 67 || v === 61;
      timeline.push({ t, kind: v === EV_ARMED || v === EV_DISARMED ? "arm" : "event", text: EVENT[v] ?? `Event ${v}`, tone: bad ? "bad" : warn ? "warn" : "note", code: v });
    }
  }
  const AR = T("ARM");
  if (AR && !armEdges.length) {
    const st = num(AR, "ArmState");
    for (const r of allRows(AR)) armEdges.push({ t: AR.t[r], on: !!st?.[r] });
  }

  // Errors.
  const ER = T("ERR");
  if (ER) {
    const sub = num(ER, "Subsys");
    const code = num(ER, "ECode");
    for (const r of allRows(ER)) {
      const s = sub ? sub[r] : NaN;
      const c = code ? code[r] : NaN;
      const m = errMeaning(s, c);
      timeline.push({ t: ER.t[r], kind: "error", text: m.text, tone: m.tone, code: s * 1000 + c });
    }
  }

  // Messages.
  if (msgT && msgText) {
    for (const r of allRows(msgT)) {
      const m = msgText[r];
      if (!m) continue;
      timeline.push({ t: msgT.t[r], kind: "message", text: m, tone: messageTone(m), code: -1 });
    }
  }

  // Parameters.
  const params = new Map<string, ParamInfo>();
  const PA = T("PARM");
  if (PA) {
    const names = text(PA, "Name");
    const vals = num(PA, "Value");
    const defs = num(PA, "Default");
    if (names && vals) {
      for (let r = 0; r < PA.count; r++) {
        const n = names[r];
        if (!n) continue;
        const v = vals[r];
        const p = params.get(n);
        if (!p) {
          const d = defs ? defs[r] : NaN;
          params.set(n, { name: n, value: v, last: v, default: Number.isFinite(d) ? d : null, changes: [] });
        } else if (v !== p.last) {
          p.changes.push({ t: PA.t[r], value: v });
          p.last = v;
        }
      }
    }
  }

  // Home: the AHRS home in ORGN (type 1), the last one set.
  let home: Flight["home"] = null;
  const O = T("ORGN");
  if (O) {
    const ty = num(O, "Type");
    const la = num(O, "Lat"), ln = num(O, "Lng"), al = num(O, "Alt");
    for (let r = 0; r < O.count; r++) if (ty?.[r] === 1 && la && ln && al && (la[r] || ln[r])) home = { lat: la[r], lng: ln[r], alt: al[r] };
  }

  // Mission as the autopilot logged it.
  const mission: MissionItem[] = [];
  const CM = T("CMD");
  if (CM) {
    const g = (f: string) => num(CM, f);
    const seq = g("CNum"), id = g("CId");
    for (let r = 0; r < CM.count; r++) {
      if (!seq || !id) break;
      const item: MissionItem = { seq: seq[r], command: id[r], p1: g("Prm1")?.[r] ?? 0, p2: g("Prm2")?.[r] ?? 0, p3: g("Prm3")?.[r] ?? 0, p4: g("Prm4")?.[r] ?? 0, lat: g("Lat")?.[r] ?? 0, lng: g("Lng")?.[r] ?? 0, alt: g("Alt")?.[r] ?? 0, frame: g("Frame")?.[r] ?? 0 };
      const at = mission.findIndex((m) => m.seq === item.seq);
      if (at >= 0) mission[at] = item;
      else mission.push(item);
    }
    mission.sort((a, b) => a.seq - b.seq);
  }

  // Armed: the first arming edge says what it was before. A log that only records while armed starts armed.
  let startArmed = armEdges.length ? !armEdges[0].on : false;
  if (!armEdges.length) {
    const ld = params.get("LOG_DISARMED");
    startArmed = !!ld && ld.value === 0 && raw.duration > 0;
  }
  const armed = spansFrom(armEdges, startArmed, 0, end);

  // Flying: the land detector's edges; before the first, the opposite of what it says.
  let flying: Span[];
  if (landEdges.length) flying = spansFrom(landEdges, !landEdges[0].on, 0, end);
  else flying = flyingFromMotion(armed, ctl, pos);
  // A flight cannot outlast being armed: clip flying to the armed spans.
  flying = clip(flying, armed);

  timeline.sort((a, b) => a.t - b.t);
  const fc = params.get("FRAME_CLASS");
  return {
    kind: "bin",
    name: raw.name,
    vehicle: vehicleOf(firmware),
    firmware,
    version,
    startUtc: raw.startUtc,
    duration: raw.duration,
    att,
    pos,
    gps,
    bat,
    vibe,
    ctl,
    out,
    mag,
    ekf,
    power,
    load,
    modes,
    timeline,
    params,
    armed,
    flying,
    home,
    mission,
    motors: fc ? (FRAME_MOTORS[fc.last] ?? null) : null,
    sysid: null,
    raw,
  };
}

/** Where the land detector is not logged: armed, and either above home or on more than idle throttle. */
function flyingFromMotion(armed: Span[], ctl: Control | null, pos: Position | null): Span[] {
  const t = ctl?.t ?? pos?.t;
  if (!t || !t.length) return armed.map((s) => ({ ...s }));
  const edges: { t: number; on: boolean }[] = [];
  let on = false;
  for (let i = 0; i < t.length; i++) {
    const rel = pos ? valueAt(pos.t, pos.rel, t[i]) : NaN;
    const thr = ctl ? ctl.thrOut[i] : NaN;
    const up = (Number.isFinite(rel) && rel > 1) || (Number.isFinite(thr) && thr > 0.2);
    if (up !== on) {
      edges.push({ t: t[i], on: up });
      on = up;
    }
  }
  return spansFrom(edges, false, t[0], t[t.length - 1]);
}

/** The parts of `a` that are inside `b`. */
function clip(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (to > from) out.push({ from, to, open: x.open && y.open && to === x.to });
    }
  }
  return out;
}

/** How serious an autopilot text message sounds, for colour only (.bin MSG has no severity). */
function messageTone(m: string): Tone {
  if (/crash|fail|error|emergency|critical|lost|glitch|thrust loss|unhealthy|brownout|watchdog|internal|disarm.*crash/i.test(m)) return "bad";
  if (/warn|low|bad|variance|reset|timeout|not|check|vibration|clipping|interference/i.test(m)) return "warn";
  return "note";
}

/* ───────────── MAVLink telemetry ───────────── */

const NO_U16 = 65535;

function fromTlog(raw: RawLog): Flight {
  const end = raw.duration;
  const timeline: TimelineItem[] = [];

  // The autopilot: the system whose heartbeats say it is not a ground station and has an autopilot.
  const HB = raw.tables.get("HEARTBEAT");
  let sysid: number | null = null;
  let mavType: number | null = null;
  if (HB) {
    const sys = num(HB, "sysid")!, comp = num(HB, "compid")!, ty = num(HB, "type")!, ap = num(HB, "autopilot")!;
    const count = new Map<number, number>();
    for (let r = 0; r < HB.count; r++) if (ty[r] !== 6 && ap[r] !== 8 && comp[r] === 1) count.set(sys[r], (count.get(sys[r]) ?? 0) + 1);
    let best = 0;
    for (const [s, n] of count) {
      if (n > best) {
        best = n;
        sysid = s;
      }
    }
    for (let r = 0; r < HB.count; r++) if (sys[r] === sysid && comp[r] === 1 && ty[r] !== 6) mavType = ty[r];
  }
  /** Rows of a message from the autopilot (component 1), optionally filtered. */
  const rowsOf = (t: Table | undefined, keep?: (r: number) => boolean): number[] => {
    if (!t) return [];
    const s = num(t, "sysid"), c = num(t, "compid");
    const out: number[] = [];
    for (let r = 0; r < t.count; r++) if ((sysid === null || s![r] === sysid) && c![r] === 1 && (!keep || keep(r))) out.push(r);
    return out;
  };
  const T = (n: string) => raw.tables.get(n);

  // Attitude, with the controller's target from NAV_CONTROLLER_OUTPUT.
  let att: Attitude | null = null;
  const A = T("ATTITUDE");
  const ar = rowsOf(A);
  if (A && ar.length) {
    const d = 180 / Math.PI;
    const t = pick(A.t, ar);
    const yaw = pick(num(A, "yaw"), ar, d).map(wrap360);
    att = { t, roll: pick(num(A, "roll"), ar, d), pitch: pick(num(A, "pitch"), ar, d), yaw, desRoll: new Float64Array(ar.length).fill(NaN), desPitch: new Float64Array(ar.length).fill(NaN), desYaw: null };
    const N = T("NAV_CONTROLLER_OUTPUT");
    const nr = rowsOf(N);
    if (N && nr.length) {
      const nt = pick(N.t, nr);
      // A target older than a second is no longer the target.
      att.desRoll = holdOnto(nt, pick(num(N, "nav_roll"), nr), t, 1);
      att.desPitch = holdOnto(nt, pick(num(N, "nav_pitch"), nr), t, 1);
    }
  }

  // Position.
  let pos: Position | null = null;
  const G = T("GLOBAL_POSITION_INT");
  const gr = rowsOf(G, (r) => num(G!, "lat")![r] !== 0 || num(G!, "lon")![r] !== 0);
  if (G && gr.length) pos = { t: pick(G.t, gr), lat: pick(num(G, "lat"), gr, 1e-7), lng: pick(num(G, "lon"), gr, 1e-7), alt: pick(num(G, "alt"), gr, 1e-3), rel: pick(num(G, "relative_alt"), gr, 1e-3) };

  // GPS receivers.
  const gps: GpsTrack[] = [];
  for (const [name, inst] of [["GPS_RAW_INT", 0], ["GPS2_RAW", 1]] as const) {
    const R = T(name);
    const rr = rowsOf(R);
    if (!R || !rr.length) continue;
    const eph = pick(num(R, "eph"), rr);
    const sats = pick(num(R, "satellites_visible"), rr);
    gps.push({
      instance: inst,
      t: pick(R.t, rr),
      status: pick(num(R, "fix_type"), rr),
      sats: sats.map((v) => (v === 255 ? NaN : v)),
      hdop: eph.map((v) => (v === NO_U16 ? NaN : v / 100)),
      lat: pick(num(R, "lat"), rr, 1e-7),
      lng: pick(num(R, "lon"), rr, 1e-7),
      alt: pick(num(R, "alt"), rr, 1e-3),
      speed: pick(num(R, "vel"), rr, 0.01).map((v) => (v > 655 ? NaN : v)),
    });
  }

  // Battery: SYS_STATUS for the first battery's volts, amps and percent; BATTERY_STATUS for mAh used and for others.
  const bat: Battery[] = [];
  const S = T("SYS_STATUS");
  const sr = rowsOf(S);
  const BS = T("BATTERY_STATUS");
  if (S && sr.length) {
    const t = pick(S.t, sr);
    const b: Battery = {
      instance: 0,
      t,
      // 0 V is a monitor not yet reading (or none fitted), not an empty battery.
      volt: pick(num(S, "voltage_battery"), sr).map((v) => (v === NO_U16 || v === 0 ? NaN : v / 1000)),
      curr: pick(num(S, "current_battery"), sr).map((v) => (v < 0 ? NaN : v / 100)),
      used: new Float64Array(sr.length).fill(NaN),
      remPct: pick(num(S, "battery_remaining"), sr).map((v) => (v < 0 ? NaN : v)),
    };
    const br = rowsOf(BS, (r) => num(BS!, "id")![r] === 0);
    if (BS && br.length) b.used = holdOnto(pick(BS.t, br), pick(num(BS, "current_consumed"), br).map((v) => (v < 0 ? NaN : v)), t);
    if (b.volt.some((v) => Number.isFinite(v) && v > 0)) bat.push(b);
  }
  if (BS) {
    const ids = new Set(rowsOf(BS).map((r) => num(BS, "id")![r]));
    for (const id of ids) {
      if (id === 0 && bat.length) continue;
      const br = rowsOf(BS, (r) => num(BS, "id")![r] === id);
      const volt = new Float64Array(br.length);
      for (let i = 0; i < br.length; i++) {
        let s = 0;
        for (let k = 0; k < 10; k++) {
          const v = num(BS, `voltages[${k}]`)![br[i]];
          if (v !== NO_U16) s += v;
        }
        volt[i] = s ? s / 1000 : NaN;
      }
      bat.push({ instance: id, t: pick(BS.t, br), volt, curr: pick(num(BS, "current_battery"), br).map((v) => (v < 0 ? NaN : v / 100)), used: pick(num(BS, "current_consumed"), br).map((v) => (v < 0 ? NaN : v)), remPct: pick(num(BS, "battery_remaining"), br).map((v) => (v < 0 ? NaN : v)) });
    }
  }

  // Vibration of the primary IMU, clipping of each.
  const vibe: Vibration[] = [];
  const VB = T("VIBRATION");
  const vr = rowsOf(VB);
  if (VB && vr.length) {
    const t = pick(VB.t, vr);
    for (let k = 0; k < 3; k++) {
      const clip = pick(num(VB, `clipping_${k}`), vr);
      if (k > 0 && !clip.some((v) => v > 0)) continue;
      const nan = new Float64Array(vr.length).fill(NaN);
      vibe.push({ imu: k, t, x: k ? nan : pick(num(VB, "vibration_x"), vr), y: k ? nan : pick(num(VB, "vibration_y"), vr), z: k ? nan : pick(num(VB, "vibration_z"), vr), clip });
    }
  }

  // Throttle and climb from VFR_HUD.
  let ctl: Control | null = null;
  const H = T("VFR_HUD");
  const hr = rowsOf(H);
  if (H && hr.length) {
    const t = pick(H.t, hr);
    const nan = () => new Float64Array(hr.length).fill(NaN);
    ctl = { t, thrOut: pick(num(H, "throttle"), hr, 0.01), thrHover: nan(), altTarget: nan(), alt: pos ? holdOnto(pos.t, pos.rel, t) : nan(), climbTarget: nan(), climb: pick(num(H, "climb"), hr) };
  }

  // Servo outputs (port 0: outputs 1-16).
  let out: Outputs | null = null;
  const SO = T("SERVO_OUTPUT_RAW");
  const or = rowsOf(SO, (r) => num(SO!, "port")![r] === 0);
  if (SO && or.length) {
    const ch: Float64Array[] = [];
    for (let k = 1; k <= 16; k++) {
      const c = num(SO, `servo${k}_raw`);
      if (c) ch.push(pick(c, or));
    }
    // Trailing channels the autopilot never drove stay out.
    while (ch.length && ch[ch.length - 1].every((v) => v === 0)) ch.pop();
    out = { t: pick(SO.t, or), ch };
  }

  // Compasses: RAW_IMU carries the first, SCALED_IMU2 and 3 the others (milligauss).
  const mag: Compass[] = [];
  for (const [name, inst] of [["RAW_IMU", 0], ["SCALED_IMU2", 1], ["SCALED_IMU3", 2]] as const) {
    const I = T(name);
    const ir = rowsOf(I);
    if (!I || !ir.length) continue;
    const x = pick(num(I, "xmag"), ir), y = pick(num(I, "ymag"), ir), z = pick(num(I, "zmag"), ir);
    if (!changes(x) && !changes(y) && x[0] === 0) continue;
    mag.push({ instance: inst, t: pick(I.t, ir), x, y, z });
  }

  // EKF.
  let ekf: Ekf | null = null;
  const K = T("EKF_STATUS_REPORT");
  const kr = rowsOf(K);
  if (K && kr.length) ekf = { t: pick(K.t, kr), vel: pick(num(K, "velocity_variance"), kr), posH: pick(num(K, "pos_horiz_variance"), kr), posV: pick(num(K, "pos_vert_variance"), kr), mag: pick(num(K, "compass_variance"), kr), lane: new Float64Array(kr.length).fill(-1) };

  // Board power.
  let power: BoardPower | null = null;
  const PW = T("POWER_STATUS");
  const pr = rowsOf(PW);
  if (PW && pr.length) power = { t: pick(PW.t, pr), vcc: pick(num(PW, "Vcc"), pr, 1e-3), vservo: pick(num(PW, "Vservo"), pr, 1e-3), flags: pick(num(PW, "flags"), pr) };

  // CPU load (SYS_STATUS load is per mille).
  let load: Load | null = null;
  if (S && sr.length) {
    const nan = new Float64Array(sr.length).fill(NaN);
    load = { t: pick(S.t, sr), load: pick(num(S, "load"), sr, 0.1), slow: nan, loops: nan };
  }

  // Modes and arming from the autopilot's heartbeats.
  const modes: ModeChange[] = [];
  const armEdges: { t: number; on: boolean }[] = [];
  let firstArmed: boolean | null = null;
  if (HB) {
    const hr2 = rowsOf(HB, (r) => num(HB, "type")![r] !== 6 && num(HB, "autopilot")![r] !== 8);
    const cm = num(HB, "custom_mode")!, bm = num(HB, "base_mode")!;
    let lastArm: boolean | null = null;
    for (const r of hr2) {
      const t = HB.t[r];
      const mode = cm[r];
      if (!modes.length || modes[modes.length - 1].mode !== mode) {
        modes.push({ t, mode, name: modeName(mode), reason: null });
        timeline.push({ t, kind: "mode", text: `Mode ${modeName(mode)}`, tone: "note", code: mode });
      }
      const on = (bm[r] & 128) !== 0;
      if (lastArm === null) firstArmed = on;
      else if (on !== lastArm) {
        armEdges.push({ t, on });
        timeline.push({ t, kind: "arm", text: on ? "Armed" : "Disarmed", tone: "note", code: on ? EV_ARMED : EV_DISARMED });
      }
      lastArm = on;
    }
  }

  // Messages: STATUSTEXT, with long texts sent in chunks joined back up.
  const ST = T("STATUSTEXT");
  const stR = rowsOf(ST);
  if (ST && stR.length) {
    const tx = text(ST, "text")!, sev = num(ST, "severity")!, id = num(ST, "id"), seq = num(ST, "chunk_seq");
    let open: TimelineItem | null = null;
    let openId = 0;
    for (const r of stR) {
      const chunk = id ? id[r] : 0;
      if (chunk && open && openId === chunk && seq && seq[r] > 0) {
        open.text += tx[r];
        continue;
      }
      const s = sev[r];
      open = { t: ST.t[r], kind: "message", text: tx[r], tone: s <= 3 ? "bad" : s === 4 ? "warn" : messageTone(tx[r]) === "bad" ? "warn" : "note", code: s };
      openId = chunk;
      timeline.push(open);
    }
  }

  // Firmware from the banner.
  let firmware: string | null = null;
  let version: Flight["version"] = null;
  for (const it of timeline) {
    if (it.kind !== "message") continue;
    const hit = FW_RE.exec(it.text);
    if (hit) {
      firmware = hit[0].trim();
      version = [+hit[2], +hit[3], +hit[4]];
      break;
    }
  }
  if (!version) {
    const AV = T("AUTOPILOT_VERSION");
    const avr = rowsOf(AV);
    if (AV && avr.length) {
      const v = num(AV, "flight_sw_version")![avr[0]];
      version = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff];
    }
  }

  // Parameters as the ground station received them.
  const params = new Map<string, ParamInfo>();
  const PV = T("PARAM_VALUE");
  const pvr = rowsOf(PV);
  if (PV) {
    const id = text(PV, "param_id")!, v = num(PV, "param_value")!;
    for (const r of pvr) {
      const n = id[r];
      if (!n) continue;
      const p = params.get(n);
      const val = v[r];
      if (!p) params.set(n, { name: n, value: val, last: val, default: null, changes: [] });
      else if (val !== p.last && Math.abs(val - p.last) > 1e-6 * Math.max(1, Math.abs(p.last))) {
        p.changes.push({ t: PV.t[r], value: val });
        p.last = val;
      }
    }
  }

  // Home.
  let home: Flight["home"] = null;
  const HP = T("HOME_POSITION");
  const hpr = rowsOf(HP);
  if (HP && hpr.length) {
    const r = hpr[hpr.length - 1];
    home = { lat: num(HP, "latitude")![r] * 1e-7, lng: num(HP, "longitude")![r] * 1e-7, alt: num(HP, "altitude")![r] * 1e-3 };
  }

  // A mission if one was downloaded or uploaded over this link.
  const mission: MissionItem[] = [];
  const MI = T("MISSION_ITEM_INT");
  if (MI) {
    const g = (f: string) => num(MI, f)!;
    for (let r = 0; r < MI.count; r++) {
      if (g("mission_type")[r] !== 0) continue;
      const item: MissionItem = { seq: g("seq")[r], command: g("command")[r], p1: g("param1")[r], p2: g("param2")[r], p3: g("param3")[r], p4: g("param4")[r], lat: g("x")[r] * 1e-7, lng: g("y")[r] * 1e-7, alt: g("z")[r], frame: g("frame")[r] };
      const at = mission.findIndex((m) => m.seq === item.seq);
      if (at >= 0) mission[at] = item;
      else mission.push(item);
    }
    mission.sort((a, b) => a.seq - b.seq);
  }

  const armed = spansFrom(armEdges, !!firstArmed, 0, end);
  // Landed state from EXTENDED_SYS_STATE where the autopilot sent it (1 on ground, 2 in air, 3 taking off, 4 landing).
  let flying: Span[];
  const X = T("EXTENDED_SYS_STATE");
  const xr = rowsOf(X);
  if (X && xr.length) {
    const ls = num(X, "landed_state")!;
    const edges: { t: number; on: boolean }[] = [];
    let on: boolean | null = null;
    for (const r of xr) {
      const up = ls[r] >= 2;
      if (ls[r] === 0) continue;
      if (on === null || up !== on) edges.push({ t: X.t[r], on: up });
      on = up;
    }
    flying = clip(spansFrom(edges, false, 0, end), armed);
  } else flying = clip(flyingFromMotion(armed, ctl, pos), armed);

  timeline.sort((a, b) => a.t - b.t);
  const fc = params.get("FRAME_CLASS");
  return {
    kind: "tlog",
    name: raw.name,
    vehicle: firmware ? vehicleOf(firmware) : vehicleOfType(mavType),
    firmware,
    version,
    startUtc: raw.startUtc,
    duration: raw.duration,
    att,
    pos,
    gps,
    bat,
    vibe,
    ctl,
    out,
    mag,
    ekf,
    power,
    load,
    modes,
    timeline,
    params,
    armed,
    flying,
    home,
    mission,
    motors: fc ? (FRAME_MOTORS[fc.last] ?? null) : null,
    sysid,
    raw,
  };
}

export function buildFlight(raw: RawLog): Flight {
  return raw.kind === "bin" ? fromBin(raw) : fromTlog(raw);
}

/** Parameter value at the end of the log, or undefined. */
export const param = (f: Flight, name: string): number | undefined => f.params.get(name)?.last;
