/*
  The aircraft's state at any moment of a log, for the replay: where it was
  relative to home, how it was leaning, how hard the motors were working.
  Between samples it is interpolated (headings the short way round), so the
  replay moves smoothly at any speed without inventing anything between two
  real samples.
*/
import { toLocal } from "../geo/geo";
import { indexAt, valueAt, type Flight } from "./model";

export interface ReplayState {
  t: number;
  /** Metres from home: north, east, down. */
  n: number;
  e: number;
  d: number;
  /** Degrees. */
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
  armed: boolean;
  flying: boolean;
  mode: string;
  speed: number;
  climb: number;
  altRel: number;
  volt: number;
  remPct: number;
  sats: number;
  hasPosition: boolean;
}

/** Interpolate an angle in degrees the short way round. */
function angleAt(t: Float64Array, v: Float64Array, x: number): number {
  const n = t.length;
  if (!n) return NaN;
  const i = indexAt(t, x);
  if (i >= n - 1 || x <= t[0]) return v[Math.max(0, i)];
  const a = v[i];
  let d = v[i + 1] - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  const f = (x - t[i]) / (t[i + 1] - t[i] || 1);
  return (((a + d * f) % 360) + 360) % 360;
}

/** Hold the last value (for counts and states, which must not be blended). */
function holdAt(t: Float64Array, v: ArrayLike<number>, x: number): number {
  if (!t.length || x < t[0]) return NaN;
  return v[indexAt(t, x)];
}

/** Where home is for the replay: the logged home, else the first position fix. */
export function replayHome(f: Flight): { lat: number; lon: number; alt: number } | null {
  if (f.home && (f.home.lat || f.home.lng)) return { lat: f.home.lat, lon: f.home.lng, alt: f.home.alt };
  const p = f.pos;
  if (!p) return null;
  for (let i = 0; i < p.t.length; i++) if (p.lat[i] || p.lng[i]) return { lat: p.lat[i], lon: p.lng[i], alt: p.alt[i] - (Number.isFinite(p.rel[i]) ? p.rel[i] : 0) };
  return null;
}

export function replayAt(f: Flight, t: number, home = replayHome(f)): ReplayState {
  const s: ReplayState = { t, n: 0, e: 0, d: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0, armed: false, flying: false, mode: "", speed: NaN, climb: NaN, altRel: NaN, volt: NaN, remPct: NaN, sats: NaN, hasPosition: false };
  const p = f.pos;
  if (p && home && p.t.length) {
    const lat = valueAt(p.t, p.lat, t);
    const lng = valueAt(p.t, p.lng, t);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
      const ne = toLocal(home, lat, lng);
      const rel = valueAt(p.t, p.rel, t);
      const alt = Number.isFinite(rel) ? rel : valueAt(p.t, p.alt, t) - home.alt;
      s.n = ne.n;
      s.e = ne.e;
      s.d = -alt;
      s.altRel = alt;
      s.hasPosition = true;
    } else if (t < p.t[0]) {
      s.hasPosition = false;
    }
  }
  const a = f.att;
  if (a && a.t.length) {
    s.roll = valueAt(a.t, a.roll, t);
    s.pitch = valueAt(a.t, a.pitch, t);
    s.yaw = angleAt(a.t, a.yaw, t);
    if (!Number.isFinite(s.roll)) s.roll = holdAt(a.t, a.roll, t) || 0;
    if (!Number.isFinite(s.pitch)) s.pitch = holdAt(a.t, a.pitch, t) || 0;
    if (!Number.isFinite(s.yaw)) s.yaw = holdAt(a.t, a.yaw, t) || 0;
  }
  if (f.ctl) {
    s.throttle = valueAt(f.ctl.t, f.ctl.thrOut, t) || 0;
    s.climb = valueAt(f.ctl.t, f.ctl.climb, t);
  }
  s.armed = f.armed.some((x) => t >= x.from && t <= x.to);
  s.flying = f.flying.some((x) => t >= x.from && t <= x.to);
  let mode = "";
  for (const m of f.modes) if (m.t <= t) mode = m.name;
  s.mode = mode;
  const g = f.gps[0];
  if (g) {
    s.speed = valueAt(g.t, g.speed, t);
    s.sats = holdAt(g.t, g.sats, t);
  }
  const b = f.bat[0];
  if (b) {
    s.volt = valueAt(b.t, b.volt, t);
    s.remPct = holdAt(b.t, b.remPct, t);
  }
  return s;
}

/** The flight path in metres from home, thinned to at most `max` points, for the map and the 3D trail. */
export function replayPath(f: Flight, max = 4000, home = replayHome(f)): { t: number; n: number; e: number; d: number }[] {
  const p = f.pos;
  if (!p || !home) return [];
  const out: { t: number; n: number; e: number; d: number }[] = [];
  const step = Math.max(1, Math.floor(p.t.length / max));
  for (let i = 0; i < p.t.length; i += step) {
    if (!p.lat[i] && !p.lng[i]) continue;
    const ne = toLocal(home, p.lat[i], p.lng[i]);
    const rel = Number.isFinite(p.rel[i]) ? p.rel[i] : p.alt[i] - home.alt;
    out.push({ t: p.t[i], n: ne.n, e: ne.e, d: -rel });
  }
  return out;
}
