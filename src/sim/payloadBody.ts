import { G, RHO } from "./airframe";
import type { Vec3 } from "./physics";

/*
  The payloads themselves: where each one is, so that a drop can be seen to
  fall and land, and a lowering to touch down.

  A payload is a box on a line below the aircraft. It hangs and swings on the
  line (gravity, the air going past it, and the line pulling it along), rests
  on the ground when the aircraft is lower than the line, falls freely when it
  is let go, and stays where it lands. Each one notes where it was let go and
  where and how hard it landed.

  The aircraft's own flight does not feel the swing: its physics carries the
  payload's weight straight down until it rests on the ground or is let go,
  which is what ArduCopter's payload-place senses. The boxes follow from the
  aircraft's flight; they do not push it about.
*/
export type BodyState = "carried" | "falling" | "down";

export interface PayloadBody {
  /** In loading order, from 0. */
  id: number;
  kg: number;
  /** From the aircraft to the bottom of the payload, m. */
  hangM: number;
  /** What lets it go: "gripper" or "servo:n". */
  release: string;
  state: BodyState;
  /** Centre of the box: north, east, down, m from where the aircraft started. */
  pos: Vec3;
  vel: Vec3;
  /** Side of the box, m. */
  size: number;
  /** When and where it was let go: the mission item, the aircraft's height above the ground and speed then. */
  released: { t: number; seq: number; n: number; e: number; agl: number; speed: number } | null;
  /** Where it came to rest, and how fast it was going when it hit, m/s. 0: set down. */
  landed: { t: number; n: number; e: number; impact: number } | null;
}

/** A parcel's side, from its weight: about the density of a packed box. */
export const boxSide = (kg: number) => Math.min(0.6, Math.max(0.1, Math.cbrt(Math.max(0.01, kg) / 250)));

/** Drag of a tumbling box, Cd × area. */
const cdA = (size: number) => 1.05 * size * size;

/** A new box resting on the ground under the aircraft, as loaded before take-off. */
export function newBody(id: number, p: { kg: number; hangM: number; release: string }, at: Vec3, ground: number): PayloadBody {
  const size = boxSide(p.kg);
  return { id, kg: p.kg, hangM: p.hangM, release: p.release, state: "carried", pos: [at[0], at[1], -ground - size / 2], vel: [0, 0, 0], size, released: null, landed: null };
}

/** Is it sitting on the ground now? */
export const onGround = (b: PayloadBody, ground: number) => b.pos[2] >= -ground - b.size / 2 - 0.01;

/**
 * Advance every box by dt. `craft` is the aircraft's position and velocity,
 * `air` the wind (NED, m/s) and `ground` the height of the ground at a point.
 */
export function stepBodies(bodies: PayloadBody[], craft: { pos: Vec3; vel: Vec3 }, air: Vec3, ground: (n: number, e: number) => number, dt: number, t: number) {
  for (const b of bodies) {
    if (b.state === "down") continue;
    const p = b.pos;
    const v = b.vel;
    // Gravity and drag.
    const rel: Vec3 = [air[0] - v[0], air[1] - v[1], air[2] - v[2]];
    const rs = Math.hypot(rel[0], rel[1], rel[2]);
    const k = (0.5 * RHO * cdA(b.size) * rs) / b.kg;
    v[0] += k * rel[0] * dt;
    v[1] += k * rel[1] * dt;
    v[2] += (G + k * rel[2]) * dt;
    if (b.state === "carried") {
      // A little damping of the swing, as a real line and box lose energy.
      const c = Math.min(1, 0.4 * dt);
      for (let i = 0; i < 3; i++) v[i] -= (v[i] - craft.vel[i]) * c;
    }
    const before = Math.hypot(v[0], v[1], v[2]);
    p[0] += v[0] * dt;
    p[1] += v[1] * dt;
    p[2] += v[2] * dt;
    if (b.state === "carried") {
      // The line: no longer than it is, and it only pulls.
      const anchor: Vec3 = [craft.pos[0], craft.pos[1], craft.pos[2] + 0.05];
      const L = Math.max(0.05, b.hangM - b.size / 2);
      const d: Vec3 = [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len > L) {
        const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
        p[0] = anchor[0] + u[0] * L;
        p[1] = anchor[1] + u[1] * L;
        p[2] = anchor[2] + u[2] * L;
        const out = (v[0] - craft.vel[0]) * u[0] + (v[1] - craft.vel[1]) * u[1] + (v[2] - craft.vel[2]) * u[2];
        if (out > 0) for (let i = 0; i < 3; i++) v[i] -= out * u[i];
      }
    }
    // The ground: a box does not bounce far, and it does not slide far.
    const gNow = ground(p[0], p[1]);
    const floor = -gNow - b.size / 2;
    if (p[2] >= floor) {
      p[2] = floor;
      if (b.state === "falling") {
        b.state = "down";
        b.landed = { t, n: p[0], e: p[1], impact: before };
        v[0] = v[1] = v[2] = 0;
        continue;
      }
      if (v[2] > 0) v[2] = 0;
      const f = Math.exp(-12 * dt);
      v[0] *= f;
      v[1] *= f;
    }
  }
}

/** Let a box go: it falls, or, already on the ground, it is set down there. */
export function letGoBody(b: PayloadBody, ground: number, at: { t: number; seq: number; n: number; e: number; agl: number; speed: number }) {
  b.released = at;
  if (onGround(b, ground)) {
    b.state = "down";
    b.vel = [0, 0, 0];
    b.landed = { t: at.t, n: b.pos[0], e: b.pos[1], impact: 0 };
  } else b.state = "falling";
}
