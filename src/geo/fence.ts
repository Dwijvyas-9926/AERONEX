import { toGlobal, toLocal, type LatLon } from "./geo";

/*
  The geofence: where the aircraft may fly, as ArduCopter understands it.

  Two halves make one fence. The limits are parameters: a ceiling
  (FENCE_ALT_MAX), a floor (FENCE_ALT_MIN), a circle round home
  (FENCE_RADIUS), what to do on a breach (FENCE_ACTION) and the rest. The
  zones are drawn shapes, sent to the aircraft as a list of their own with the
  mission protocol (mission_type 1): keep-in areas it must stay inside and
  keep-out areas it must stay out of, each a polygon or a circle.

  Everything here follows ArduPilot's own code, read from
  libraries/AC_Fence (AC_Fence.cpp, AC_PolyFence_loader.cpp) and
  GCS_MAVLink/MissionItemProtocol_Fence.cpp in 4.6 and 4.7, so that a fence
  this app calls good is one the aircraft accepts and enforces the way the
  app says it will. Where the firmware has a rule, the comment says so.

  Zones are stored in latitude and longitude, not in metres from home like
  the waypoints: a fence is a place on the ground and must not move when home
  does. Coordinates are kept to the 1e-7 degree the wire carries, so what is
  drawn is exactly what is sent and read back.
*/

export type ZoneRole = "in" | "out";

export interface FencePolygon {
  id: string;
  shape: "polygon";
  role: ZoneRole;
  points: LatLon[];
}

export interface FenceCircle {
  id: string;
  shape: "circle";
  role: ZoneRole;
  centre: LatLon;
  radiusM: number;
}

export type FenceZone = FencePolygon | FenceCircle;

/** FENCE_TYPE bits. */
export const FENCE_TYPE = { ALT_MAX: 1, CIRCLE: 2, POLYGON: 4, ALT_MIN: 8 } as const;
/** FENCE_OPTIONS bit 1: the allowed area is the union of the keep-in zones, not their intersection. */
export const OPTION_UNION = 2;

/** The fence parameters this page edits, as the raw numbers the aircraft holds. */
export interface FenceLimits {
  FENCE_ENABLE: number;
  FENCE_TYPE: number;
  FENCE_ACTION: number;
  FENCE_ALT_MAX: number;
  FENCE_ALT_MIN: number;
  FENCE_RADIUS: number;
  FENCE_MARGIN: number;
  FENCE_OPTIONS: number;
}

export const LIMIT_NAMES = ["FENCE_ENABLE", "FENCE_TYPE", "FENCE_ACTION", "FENCE_ALT_MAX", "FENCE_ALT_MIN", "FENCE_RADIUS", "FENCE_MARGIN", "FENCE_OPTIONS"] as const;

/** ArduCopter's own defaults (AC_Fence.cpp). */
export const DEFAULT_LIMITS: FenceLimits = {
  FENCE_ENABLE: 0,
  FENCE_TYPE: FENCE_TYPE.ALT_MAX | FENCE_TYPE.CIRCLE | FENCE_TYPE.POLYGON,
  FENCE_ACTION: 1,
  FENCE_ALT_MAX: 100,
  FENCE_ALT_MIN: -10,
  FENCE_RADIUS: 300,
  FENCE_MARGIN: 2,
  FENCE_OPTIONS: 0,
};

/** The ranges ArduPilot documents for each setting. */
export const LIMIT_RANGE = {
  FENCE_ALT_MAX: [10, 1000],
  FENCE_ALT_MIN: [-100, 100],
  FENCE_RADIUS: [30, 10000],
  FENCE_MARGIN: [1, 10],
} as const;

/** What Copter does on a breach (FENCE_ACTION), in words. */
export const ACTIONS: { value: number; label: string; detail: string }[] = [
  { value: 1, label: "Return home, or land", detail: "Flies back to home and lands. If it cannot return (no position), it lands where it is." },
  { value: 2, label: "Land where it is", detail: "Comes straight down at the place of the breach." },
  { value: 3, label: "Retrace its path home", detail: "SmartRTL: flies back along the way it came. If that is not possible, returns home; failing that, lands." },
  { value: 5, label: "Retrace its path, or land", detail: "SmartRTL: flies back along the way it came, and lands where it is if it cannot." },
  { value: 4, label: "Brake and hold", detail: "Stops and holds position at the breach, for you to take over. Lands if it cannot hold." },
  { value: 0, label: "Only warn", detail: "Reports the breach and does nothing. The aircraft carries on through the fence." },
];

/** Beyond this, Copter gives up on its FENCE_ACTION and lands (AC_FENCE_GIVE_UP_DISTANCE). */
export const GIVE_UP_M = 100;

/** MAV_CMD numbers of fence items. */
export const FENCE_CMD = { RETURN_POINT: 5000, POLYGON_IN: 5001, POLYGON_OUT: 5002, CIRCLE_IN: 5003, CIRCLE_OUT: 5004 } as const;

/** One fence item as MISSION_ITEM_INT carries it: x and y are degrees × 1e7. */
export interface FenceWire {
  seq: number;
  frame: number;
  command: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Bytes of fence storage on a Pixhawk-class board (16 KB or more of FRAM:
 * Pixhawk 2.4.8, Pixhawk 4, Cube) with Copter: StorageManager gives the fence
 * 48 + 256 + 256 bytes. An SD card can add more (BRD_SD_FENCE, in kB).
 */
export const PIXHAWK_FENCE_BYTES = 560;

/* ------------------------------------------------------------- basics */

let made = 0;
export const zoneId = () => `z${Date.now().toString(36)}${(made++).toString(36)}`;

/** A place held to the 1e-7 degree the wire carries. */
export const snap = (p: LatLon): LatLon => ({ lat: Math.round(p.lat * 1e7) / 1e7, lon: Math.round(p.lon * 1e7) / 1e7 });

export const isFlag = (v: number, bit: number) => (Math.round(v) & bit) !== 0;
export const withFlag = (v: number, bit: number, on: boolean) => (on ? Math.round(v) | bit : Math.round(v) & ~bit);

export function limitsFrom(values: Record<string, number | undefined>, base: FenceLimits = DEFAULT_LIMITS): FenceLimits {
  const out = { ...base };
  for (const k of LIMIT_NAMES) {
    const v = values[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Limits that differ, by name. Float settings compare as the float32 the aircraft stores. */
export function limitsDiffer(a: FenceLimits, b: FenceLimits): (typeof LIMIT_NAMES)[number][] {
  return LIMIT_NAMES.filter((k) => Math.abs(Math.fround(a[k]) - Math.fround(b[k])) > 1e-4 * Math.max(1, Math.abs(a[k])));
}

/** "Keep-out circle 2": zones are numbered within their role, in the order they are listed. */
export function zoneLabel(zones: FenceZone[], id: string): string {
  const z = zones.find((x) => x.id === id);
  if (!z) return "A zone";
  const n = zones.filter((x) => x.role === z.role).findIndex((x) => x.id === id) + 1;
  return `${z.role === "in" ? "Keep-in" : "Keep-out"} ${z.shape === "circle" ? "circle" : "area"} ${n}`;
}

/* ----------------------------------------------------------- geometry */

export interface P {
  n: number;
  e: number;
}

/** A zone in metres north and east of a reference point. */
export type LocalZone =
  | { id: string; role: ZoneRole; shape: "polygon"; pts: P[] }
  | { id: string; role: ZoneRole; shape: "circle"; c: P; r: number };

export function localZones(zones: FenceZone[], ref: LatLon): LocalZone[] {
  return zones.map((z) =>
    z.shape === "polygon"
      ? { id: z.id, role: z.role, shape: "polygon", pts: z.points.map((p) => toLocal(ref, p.lat, p.lon)) }
      : { id: z.id, role: z.role, shape: "circle", c: toLocal(ref, z.centre.lat, z.centre.lon), r: z.radiusM },
  );
}

/**
 * Inside a polygon, by counting crossings: the same test as ArduPilot's
 * Polygon_outside (AP_Math/polygon.cpp). It is done there on raw latitude
 * and longitude and here on metres; one is a stretch of the other, which
 * changes no answer.
 */
export function inPolygon(p: P, pts: P[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.e > p.e !== b.e > p.e && p.n < ((b.n - a.n) * (p.e - a.e)) / (b.e - a.e) + a.n) inside = !inside;
  }
  return inside;
}

const dist = (a: P, b: P) => Math.hypot(a.n - b.n, a.e - b.e);

export function inZone(z: LocalZone, p: P): boolean {
  return z.shape === "polygon" ? inPolygon(p, z.pts) : dist(p, z.c) <= z.r;
}

/**
 * Whether a point breaches the zones, decided as AC_PolyFence_loader::breached
 * does: inside any keep-out is a breach; outside a keep-in is a breach, or,
 * with FENCE_OPTIONS bit 1, outside every keep-in. Returns the zone to blame.
 */
export function breachAt(zones: LocalZone[], p: P, union: boolean): LocalZone | null {
  for (const z of zones) if (z.role === "out" && inZone(z, p)) return z;
  const keepIn = zones.filter((z) => z.role === "in");
  if (!keepIn.length) return null;
  const outside = keepIn.filter((z) => !inZone(z, p));
  if (union) return outside.length === keepIn.length ? outside[0] : null;
  return outside[0] ?? null;
}

/** Distance from p to the segment ab. */
export function toSegment(p: P, a: P, b: P): number {
  const dn = b.n - a.n;
  const de = b.e - a.e;
  const len2 = dn * dn + de * de;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.n - a.n) * dn + (p.e - a.e) * de) / len2));
  return Math.hypot(p.n - (a.n + t * dn), p.e - (a.e + t * de));
}

/** Distance from a point to a zone's boundary. */
export function toBoundary(z: LocalZone, p: P): number {
  if (z.shape === "circle") return Math.abs(dist(p, z.c) - z.r);
  let best = Infinity;
  for (let i = 0; i < z.pts.length; i++) best = Math.min(best, toSegment(p, z.pts[i], z.pts[(i + 1) % z.pts.length]));
  return best;
}

/** Where segments ab and cd cross, as fractions along each; null when they do not. */
export function crossing(a: P, b: P, c: P, d: P): { t: number; u: number } | null {
  const r = { n: b.n - a.n, e: b.e - a.e };
  const s = { n: d.n - c.n, e: d.e - c.e };
  const den = r.e * s.n - r.n * s.e;
  if (Math.abs(den) < 1e-12) return null;
  const q = { n: c.n - a.n, e: c.e - a.e };
  const t = (q.e * s.n - q.n * s.e) / den;
  const u = (q.e * r.n - q.n * r.e) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u };
}

/** Fractions along ab where it meets a circle. */
function circleCrossings(a: P, b: P, c: P, r: number): number[] {
  const d = { n: b.n - a.n, e: b.e - a.e };
  const f = { n: a.n - c.n, e: a.e - c.e };
  const A = d.n * d.n + d.e * d.e;
  if (A === 0) return [];
  const B = 2 * (f.n * d.n + f.e * d.e);
  const C = f.n * f.n + f.e * f.e - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t > 0 && t < 1);
}

/**
 * The first place along the straight line a→b that breaches the zones, or
 * null when the whole line is clear. Exact: the line is cut wherever it
 * meets a boundary, and each piece is tested at its middle, so a thin zone
 * between two sample points cannot be missed.
 */
export function legBreach(zones: LocalZone[], a: P, b: P, union: boolean): { at: P; t: number; zone: LocalZone } | null {
  if (!zones.length) return null;
  const cuts = [0, 1];
  for (const z of zones) {
    if (z.shape === "circle") cuts.push(...circleCrossings(a, b, z.c, z.r));
    else for (let i = 0; i < z.pts.length; i++) {
      const x = crossing(a, b, z.pts[i], z.pts[(i + 1) % z.pts.length]);
      if (x) cuts.push(Math.max(0, Math.min(1, x.t)));
    }
  }
  cuts.sort((x, y) => x - y);
  const at = (t: number): P => ({ n: a.n + (b.n - a.n) * t, e: a.e + (b.e - a.e) * t });
  const first = breachAt(zones, a, union);
  if (first) return { at: a, t: 0, zone: first };
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] - cuts[i] < 1e-9) continue;
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    const z = breachAt(zones, at(mid), union);
    if (z) return { at: at(cuts[i]), t: cuts[i], zone: z };
  }
  const last = breachAt(zones, b, union);
  return last ? { at: b, t: 1, zone: last } : null;
}

/** Closest the line a→b comes to any zone boundary. */
export function legClearance(zones: LocalZone[], a: P, b: P): { m: number; zone: LocalZone | null } {
  let best = { m: Infinity, zone: null as LocalZone | null };
  for (const z of zones) {
    let m: number;
    if (z.shape === "circle") {
      const near = toSegment(z.c, a, b);
      const far = Math.max(dist(a, z.c), dist(b, z.c));
      // The line's distance from the circle's edge: inside, the farthest it gets from the centre; outside, the nearest.
      m = far <= z.r ? z.r - far : near >= z.r ? near - z.r : 0;
    } else {
      m = Infinity;
      for (let i = 0; i < z.pts.length; i++) {
        const c = z.pts[i];
        const d = z.pts[(i + 1) % z.pts.length];
        if (crossing(a, b, c, d)) {
          m = 0;
          break;
        }
        m = Math.min(m, toSegment(c, a, b), toSegment(d, a, b), toSegment(a, c, d), toSegment(b, c, d));
      }
    }
    if (m < best.m) best = { m, zone: z };
  }
  return best;
}

/** Pairs of edges that cross: a polygon with any is not one shape, and the crossing count goes wrong in it. */
export function selfCrossings(pts: P[]): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Neighbouring edges share a corner; that is not a crossing, unless they fold back over each other.
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (adjacent) {
        // Folding back: the next edge runs back along the last one.
        const [p, q, r] = j === i + 1 ? [a, b, d] : [c, a, b];
        const cross = (q.e - p.e) * (r.n - q.n) - (q.n - p.n) * (r.e - q.e);
        const dot = (q.e - p.e) * (r.e - q.e) + (q.n - p.n) * (r.n - q.n);
        if (Math.abs(cross) < 1e-6 * dist(p, q) * dist(q, r) && dot < 0) out.push([i, j]);
        continue;
      }
      const x = crossing(a, b, c, d);
      if (x) out.push([i, j]);
    }
  }
  return out;
}

export function area(pts: P[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

export function perimeter(pts: P[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

/** The middle of a zone, for labels and for zooming to it. */
export function zoneCentre(z: FenceZone): LatLon {
  if (z.shape === "circle") return z.centre;
  const lat = z.points.reduce((s, p) => s + p.lat, 0) / z.points.length;
  const lon = z.points.reduce((s, p) => s + p.lon, 0) / z.points.length;
  return { lat, lon };
}

/** Convex hull, counter-clockwise (Andrew's monotone chain). */
export function hull(pts: P[]): P[] {
  const s = [...pts].sort((a, b) => a.e - b.e || a.n - b.n);
  if (s.length < 3) return s;
  const cross = (o: P, a: P, b: P) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);
  const lower: P[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * A keep-in area round home and the route, `pad` metres clear of every
 * point: the hull of an octagon round each one. Its corners lie further out
 * than `pad` only by the octagon's points, never closer.
 */
export function aroundRoute(home: LatLon, points: P[], pad: number): LatLon[] {
  const r = pad / Math.cos(Math.PI / 8);
  const ring: P[] = [];
  for (const p of [{ n: 0, e: 0 }, ...points]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      ring.push({ n: p.n + r * Math.cos(a), e: p.e + r * Math.sin(a) });
    }
  }
  return hull(ring).map((p) => snap(toGlobal(home, p.n, p.e)));
}

/** A circle drawn as a ring of points, for maps that draw lines. */
export function circleRing(centre: LatLon, radiusM: number, steps = 72): LatLon[] {
  const out: LatLon[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    out.push(toGlobal(centre, radiusM * Math.cos(a), radiusM * Math.sin(a)));
  }
  return out;
}

/* ------------------------------------------------------- the wire */

/**
 * The zones as fence items. A polygon is one item per corner, each carrying
 * the corner count in param1; a circle is one item with its radius in
 * param1. Positions go as MAV_FRAME_GLOBAL, which ArduPilot accepts and
 * reports back.
 */
export function zonesToWire(zones: FenceZone[]): FenceWire[] {
  const out: FenceWire[] = [];
  const add = (command: number, p1: number, at: LatLon) =>
    out.push({ seq: out.length, frame: 0, command, p1, p2: 0, p3: 0, p4: 0, x: Math.round(at.lat * 1e7), y: Math.round(at.lon * 1e7), z: 0 });
  for (const z of zones) {
    if (z.shape === "polygon") for (const p of z.points) add(z.role === "in" ? FENCE_CMD.POLYGON_IN : FENCE_CMD.POLYGON_OUT, z.points.length, p);
    else add(z.role === "in" ? FENCE_CMD.CIRCLE_IN : FENCE_CMD.CIRCLE_OUT, z.radiusM, z.centre);
  }
  return out;
}

/**
 * Why ArduPilot would refuse these items (AC_PolyFence_loader::validate_fence,
 * MissionItemProtocol_Fence), in its own words where it has some; null when
 * it would take them.
 */
export function wireProblem(items: FenceWire[]): string | null {
  let expecting = 0;
  let want = 0;
  let type = 0;
  let returns = 0;
  for (const it of items) {
    const poly = it.command === FENCE_CMD.POLYGON_IN || it.command === FENCE_CMD.POLYGON_OUT;
    const circle = it.command === FENCE_CMD.CIRCLE_IN || it.command === FENCE_CMD.CIRCLE_OUT;
    if (!poly && !circle && it.command !== FENCE_CMD.RETURN_POINT) return `Unsupported fence command ${it.command}`;
    if (poly) {
      if (it.p1 > 255) return "Invalid vertex count";
      if (it.p1 < 3) return `Invalid vertex count (${Math.trunc(it.p1)})`;
      if (expecting === 0) {
        expecting = want = Math.trunc(it.p1);
        type = it.command;
      } else if (it.command !== type) return "Received incorrect vertex type";
      else if (Math.trunc(it.p1) !== want) return `Unexpected vertex count want=${want} got=${Math.trunc(it.p1)}`;
      expecting--;
    } else {
      if (expecting) return "Received incorrect type";
      if (circle && !(it.p1 > 0)) return "Non-positive circle radius";
      if (it.command === FENCE_CMD.RETURN_POINT && ++returns > 1) return "Multiple return points";
    }
    if (Math.abs(it.x) > 90e7 || Math.abs(it.y) > 180e7) return "Bad lat or lon";
  }
  if (expecting) return "Incorrect item count";
  return null;
}

/** Bytes the items take in the aircraft's fence storage (fence_storage_space_required, plus the end marker). */
export function storageBytes(zones: FenceZone[]): number {
  let b = 4 + 1;
  for (const z of zones) b += z.shape === "polygon" ? 2 + 8 * z.points.length : 13;
  return b;
}

/** The items read from an aircraft, as zones. A return point is Plane's and is set aside. */
export function wireToZones(items: FenceWire[]): { zones: FenceZone[]; notes: string[] } {
  const zones: FenceZone[] = [];
  const notes: string[] = [];
  const problem = wireProblem(items);
  if (problem) throw new Error(`The aircraft's fence could not be read: its items do not make whole zones (${problem}).`);
  const at = (it: FenceWire): LatLon => ({ lat: it.x / 1e7, lon: it.y / 1e7 });
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.command === FENCE_CMD.RETURN_POINT) {
      notes.push("The aircraft holds a fence return point. Copter does not use one, so it is not shown, and sending this fence removes it.");
      i++;
    } else if (it.command === FENCE_CMD.CIRCLE_IN || it.command === FENCE_CMD.CIRCLE_OUT) {
      zones.push({ id: zoneId(), shape: "circle", role: it.command === FENCE_CMD.CIRCLE_IN ? "in" : "out", centre: at(it), radiusM: it.p1 });
      i++;
    } else {
      const n = Math.trunc(it.p1);
      zones.push({ id: zoneId(), shape: "polygon", role: it.command === FENCE_CMD.POLYGON_IN ? "in" : "out", points: items.slice(i, i + n).map(at) });
      i += n;
    }
  }
  return { zones, notes };
}

/** What differs between fence items sent and read back; null when they are the same. */
export function compareFence(sent: FenceWire[], got: FenceWire[]): string | null {
  if (sent.length !== got.length) return `${sent.length} fence items were sent and the aircraft holds ${got.length}.`;
  for (let i = 0; i < sent.length; i++) {
    const a = sent[i];
    const b = got[i];
    if (a.command !== b.command) return `Fence item ${i + 1} was sent as type ${a.command} and reads back as type ${b.command}.`;
    if (a.x !== b.x || a.y !== b.y) return `Fence item ${i + 1} reads back at a different position.`;
    // A radius is stored as a 32-bit float; a corner count as a whole number.
    if (Math.abs(Math.fround(a.p1) - Math.fround(b.p1)) > 1e-3) return `Fence item ${i + 1} reads back with ${a.command === FENCE_CMD.CIRCLE_IN || a.command === FENCE_CMD.CIRCLE_OUT ? "a different radius" : "a different corner count"}.`;
  }
  return null;
}

/** Two fences are the same when they would go to the aircraft as the same items. */
export function sameZones(a: FenceZone[], b: FenceZone[]): boolean {
  return compareFence(zonesToWire(a), zonesToWire(b)) === null;
}
