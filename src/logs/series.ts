/*
  What each chart preset plots. Each preset is a stack of panels sharing one
  time axis; each panel has one y-axis, in one unit (never two scales on one
  chart), and may carry the threshold the checks use, drawn as a line.
*/
import type { ChartPreset } from "./analyze";
import { motorChannels } from "./analyze";
import type { Flight } from "./model";
import { isNumeric, type Table } from "./types";

export interface Series {
  label: string;
  t: Float64Array;
  v: ArrayLike<number>;
  /** A target or reference drawn as a dashed line. */
  dashed?: boolean;
}

export interface Limit {
  value: number;
  label: string;
  tone: "warn" | "bad";
}

export interface Panel {
  id: string;
  title: string;
  unit: string;
  series: Series[];
  limits?: Limit[];
  /** Keep 0 on the axis (magnitudes: vibration, current). */
  zero?: boolean;
  /** Fixed range, when the quantity has one. */
  range?: [number, number];
  /** An angle that wraps (0 and 360 are the same): no line is drawn across the wrap. */
  wrap?: number;
}

export const PRESETS: { id: ChartPreset; label: string }[] = [
  { id: "attitude", label: "Attitude" },
  { id: "altitude", label: "Altitude" },
  { id: "motors", label: "Motors" },
  { id: "vibration", label: "Vibration" },
  { id: "clipping", label: "Clipping" },
  { id: "battery", label: "Battery" },
  { id: "compass", label: "Compass" },
  { id: "gps", label: "GPS" },
  { id: "ekf", label: "EKF" },
  { id: "power", label: "Board power" },
  { id: "load", label: "Processor" },
];

const mag = (x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>) => {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.hypot(x[i], y[i], z[i]);
  return out;
};

export function panelsFor(f: Flight, preset: ChartPreset): Panel[] {
  const out: Panel[] = [];
  switch (preset) {
    case "attitude": {
      const a = f.att;
      if (!a) break;
      out.push({ id: "roll", title: "Roll", unit: "°", series: [{ label: "Roll", t: a.t, v: a.roll }, { label: "Desired", t: a.t, v: a.desRoll, dashed: true }] });
      out.push({ id: "pitch", title: "Pitch", unit: "°", series: [{ label: "Pitch", t: a.t, v: a.pitch }, { label: "Desired", t: a.t, v: a.desPitch, dashed: true }] });
      const yaw: Series[] = [{ label: "Yaw", t: a.t, v: a.yaw }];
      if (a.desYaw) yaw.push({ label: "Desired", t: a.t, v: a.desYaw, dashed: true });
      out.push({ id: "yaw", title: "Heading", unit: "°", series: yaw, range: [0, 360], wrap: 360 });
      break;
    }
    case "altitude": {
      const c = f.ctl;
      if (c && c.alt.some(Number.isFinite)) {
        const s: Series[] = [{ label: "Altitude", t: c.t, v: c.alt }];
        if (c.altTarget.some(Number.isFinite)) s.push({ label: "Target", t: c.t, v: c.altTarget, dashed: true });
        out.push({ id: "alt", title: "Altitude above home", unit: "m", series: s });
      } else if (f.pos) out.push({ id: "alt", title: "Altitude above home", unit: "m", series: [{ label: "Altitude", t: f.pos.t, v: f.pos.rel }] });
      if (c && c.climb.some(Number.isFinite)) {
        const s: Series[] = [{ label: "Climb rate", t: c.t, v: c.climb }];
        if (c.climbTarget.some(Number.isFinite)) s.push({ label: "Target", t: c.t, v: c.climbTarget, dashed: true });
        out.push({ id: "climb", title: "Climb rate", unit: "m/s", series: s });
      }
      if (c) {
        const s: Series[] = [{ label: "Throttle out", t: c.t, v: c.thrOut }];
        if (c.thrHover.some(Number.isFinite)) s.push({ label: "Hover estimate", t: c.t, v: c.thrHover, dashed: true });
        out.push({ id: "thr", title: "Throttle", unit: "0–1", series: s, range: [0, 1] });
      }
      break;
    }
    case "motors": {
      const o = f.out;
      if (!o) break;
      const ch = motorChannels(f);
      const pmax = f.params.get("MOT_PWM_MAX")?.last || 2000;
      out.push({ id: "motors", title: "Motor outputs", unit: "µs", series: ch.map((c, k) => ({ label: `Motor ${k + 1}`, t: o.t, v: o.ch[c] })), limits: [{ value: pmax, label: "Full output", tone: "bad" }] });
      break;
    }
    case "vibration": {
      for (const v of f.vibe) {
        if (!v.x.some(Number.isFinite)) continue;
        out.push({
          id: `vibe${v.imu}`,
          title: f.vibe.filter((x) => x.x.some(Number.isFinite)).length > 1 ? `Vibration, IMU ${v.imu + 1}` : "Vibration",
          unit: "m/s²",
          zero: true,
          series: [{ label: "X", t: v.t, v: v.x }, { label: "Y", t: v.t, v: v.y }, { label: "Z", t: v.t, v: v.z }],
          limits: [{ value: 30, label: "30: problems likely", tone: "warn" }, { value: 60, label: "60: too high", tone: "bad" }],
        });
      }
      break;
    }
    case "clipping": {
      if (f.vibe.length) out.push({ id: "clip", title: "Accelerometer clipping (count since boot)", unit: "count", zero: true, series: f.vibe.map((v) => ({ label: `IMU ${v.imu + 1}`, t: v.t, v: v.clip })) });
      break;
    }
    case "battery": {
      for (const b of f.bat) {
        const n = f.bat.length > 1 ? ` ${b.instance + 1}` : "";
        out.push({ id: `volt${b.instance}`, title: `Battery${n} voltage`, unit: "V", series: [{ label: "Voltage", t: b.t, v: b.volt }] });
        if (b.curr.some((x) => Number.isFinite(x) && x > 0)) out.push({ id: `curr${b.instance}`, title: `Battery${n} current`, unit: "A", zero: true, series: [{ label: "Current", t: b.t, v: b.curr }] });
        if (b.used.some((x) => Number.isFinite(x) && x > 0)) {
          const cap = f.params.get(b.instance === 0 ? "BATT_CAPACITY" : `BATT${b.instance + 1}_CAPACITY`)?.last;
          out.push({ id: `used${b.instance}`, title: `Battery${n} used`, unit: "mAh", zero: true, series: [{ label: "Used", t: b.t, v: b.used }], limits: cap ? [{ value: cap * 0.8, label: "80% of capacity", tone: "warn" }] : undefined });
        }
      }
      break;
    }
    case "compass": {
      if (f.mag.length) out.push({ id: "magfield", title: "Compass field strength", unit: "mGauss", zero: true, series: f.mag.map((m) => ({ label: f.mag.length > 1 ? `Compass ${m.instance + 1}` : "Field", t: m.t, v: mag(m.x, m.y, m.z) })), limits: [{ value: 550, label: "550: above normal", tone: "warn" }] });
      if (f.ctl) out.push({ id: "magthr", title: "Throttle", unit: "0–1", range: [0, 1], series: [{ label: "Throttle out", t: f.ctl.t, v: f.ctl.thrOut }] });
      break;
    }
    case "gps": {
      if (!f.gps.length) break;
      out.push({ id: "sats", title: "Satellites", unit: "count", zero: true, series: f.gps.map((g) => ({ label: f.gps.length > 1 ? `GPS ${g.instance + 1}` : "Satellites", t: g.t, v: g.sats })), limits: [{ value: 6, label: "6: minimum", tone: "bad" }] });
      out.push({ id: "hdop", title: "HDOP", unit: "", zero: true, series: f.gps.map((g) => ({ label: f.gps.length > 1 ? `GPS ${g.instance + 1}` : "HDOP", t: g.t, v: g.hdop })), limits: [{ value: 2, label: "2.0: poor", tone: "warn" }] });
      out.push({ id: "fix", title: "Fix type (3 = 3D)", unit: "", range: [0, 6], series: f.gps.map((g) => ({ label: f.gps.length > 1 ? `GPS ${g.instance + 1}` : "Fix", t: g.t, v: g.status })) });
      break;
    }
    case "ekf": {
      const e = f.ekf;
      if (!e) break;
      const th = f.params.get("FS_EKF_THRESH")?.last || 0.8;
      out.push({ id: "ekf", title: "EKF test ratios", unit: "ratio", zero: true, series: [{ label: "Velocity", t: e.t, v: e.vel }, { label: "Position", t: e.t, v: e.posH }, { label: "Height", t: e.t, v: e.posV }, { label: "Compass", t: e.t, v: e.mag }], limits: [{ value: th, label: `${th}: failsafe level`, tone: "warn" }, { value: 1, label: "1: rejected", tone: "bad" }] });
      break;
    }
    case "power": {
      const p = f.power;
      if (!p) break;
      out.push({ id: "vcc", title: "Board voltage", unit: "V", series: [{ label: "Vcc", t: p.t, v: p.vcc }], limits: [{ value: 4.3, label: "4.3: too low", tone: "bad" }] });
      if (p.vservo.some((v) => v > 0)) out.push({ id: "vservo", title: "Servo rail voltage", unit: "V", series: [{ label: "Servo rail", t: p.t, v: p.vservo }] });
      break;
    }
    case "load": {
      const l = f.load;
      if (!l) break;
      out.push({ id: "load", title: "Processor load", unit: "%", range: [0, 100], series: [{ label: "Load", t: l.t, v: l.load }] });
      break;
    }
  }
  return out.filter((p) => p.series.some((s) => s.t.length));
}

/** A panel for any numeric field of any message, split by instance when it has one. */
export function fieldPanel(t: Table, field: string): Panel | null {
  const i = t.fields.indexOf(field);
  if (i < 0 || !isNumeric(t.cols[i])) return null;
  const c = t.cols[i] as Float64Array | Float32Array;
  const m = t.mults[i] ?? 1;
  const groups = new Map<number, number[]>();
  const inst = t.instance >= 0 && t.instance !== i ? (t.cols[t.instance] as Float32Array) : null;
  for (let r = 0; r < t.count; r++) {
    if (!Number.isFinite(t.t[r])) continue;
    const k = inst ? inst[r] : 0;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const series: Series[] = [...groups].sort((a, b) => a[0] - b[0]).map(([k, rows]) => ({
    label: inst ? `${field} [${t.fields[t.instance]} ${k}]` : field,
    t: Float64Array.from(rows, (r) => t.t[r]),
    v: Float64Array.from(rows, (r) => c[r] * m),
  }));
  return { id: `${t.name}.${field}`, title: `${t.name}.${field}`, unit: t.units[i] || "", series };
}
