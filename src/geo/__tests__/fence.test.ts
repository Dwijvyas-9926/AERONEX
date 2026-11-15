import { describe, expect, it } from "vitest";
import {
  aroundRoute,
  breachAt,
  compareFence,
  DEFAULT_LIMITS,
  FENCE_CMD,
  FENCE_TYPE,
  inPolygon,
  legBreach,
  legClearance,
  limitsDiffer,
  localZones,
  OPTION_UNION,
  sameZones,
  selfCrossings,
  snap,
  storageBytes,
  wireProblem,
  wireToZones,
  zoneLabel,
  zonesToWire,
  type FenceLimits,
  type FenceZone,
  type P,
} from "../fence";
import { checkFence, type FenceCheckInput } from "../fenceCheck";
import { toGlobal, toLocal } from "../geo";

const HOME = { lat: 23.0225, lon: 72.5714 };
let n = 0;
const poly = (role: "in" | "out", pts: [number, number][]): FenceZone => ({ id: `p${n++}`, shape: "polygon", role, points: pts.map(([north, east]) => snap(toGlobal(HOME, north, east))) });
const circle = (role: "in" | "out", c: [number, number], r: number): FenceZone => ({ id: `c${n++}`, shape: "circle", role, centre: snap(toGlobal(HOME, c[0], c[1])), radiusM: r });
const square = (role: "in" | "out", cn: number, ce: number, half: number) => poly(role, [[cn - half, ce - half], [cn - half, ce + half], [cn + half, ce + half], [cn + half, ce - half]]);
const on = (over: Partial<FenceLimits> = {}): FenceLimits => ({ ...DEFAULT_LIMITS, FENCE_ENABLE: 1, ...over });

describe("inside and outside, as ArduPilot counts it", () => {
  const sq: P[] = [{ n: -10, e: -10 }, { n: -10, e: 10 }, { n: 10, e: 10 }, { n: 10, e: -10 }];
  it("finds points in a square and out of it", () => {
    expect(inPolygon({ n: 0, e: 0 }, sq)).toBe(true);
    expect(inPolygon({ n: 11, e: 0 }, sq)).toBe(false);
    expect(inPolygon({ n: 0, e: -10.5 }, sq)).toBe(false);
  });
  it("handles a concave shape", () => {
    // A U, open to the north.
    const u: P[] = [{ n: -10, e: -10 }, { n: -10, e: 10 }, { n: 10, e: 10 }, { n: 10, e: 5 }, { n: -5, e: 5 }, { n: -5, e: -5 }, { n: 10, e: -5 }, { n: 10, e: -10 }];
    expect(inPolygon({ n: 0, e: 0 }, u)).toBe(false);
    expect(inPolygon({ n: 0, e: 8 }, u)).toBe(true);
    expect(inPolygon({ n: -8, e: 0 }, u)).toBe(true);
  });
  it("blames a keep-out first, and any keep-in left, or all of them in union", () => {
    const zs = localZones([square("in", 0, 0, 100), square("in", 0, 150, 100), circle("out", [0, 0], 10)], HOME);
    expect(breachAt(zs, { n: 0, e: 0 }, false)?.role).toBe("out");
    // In the first keep-in only: a breach of the second, unless either is enough.
    expect(breachAt(zs, { n: 0, e: 30 }, false)?.id).toBe(zs[1].id);
    expect(breachAt(zs, { n: 0, e: 30 }, true)).toBeNull();
    // In both: fine either way.
    expect(breachAt(zs, { n: 0, e: 80 }, false)).toBeNull();
    // In neither.
    expect(breachAt(zs, { n: 0, e: 300 }, true)).not.toBeNull();
  });
});

describe("a line against the zones", () => {
  it("finds where a straight leg first enters a keep-out", () => {
    const zs = localZones([square("out", 0, 50, 10)], HOME);
    const br = legBreach(zs, { n: 0, e: 0 }, { n: 0, e: 100 }, false)!;
    expect(br.zone.role).toBe("out");
    expect(br.at.e).toBeCloseTo(40, 0);
  });
  it("does not miss a thin keep-out between the ends", () => {
    // 20 cm wide, 2 km away along the leg.
    const zs = localZones([poly("out", [[-50, 2000], [-50, 2000.2], [50, 2000.2], [50, 2000]])], HOME);
    expect(legBreach(zs, { n: 0, e: 0 }, { n: 0, e: 4000 }, false)).not.toBeNull();
    expect(legBreach(zs, { n: 100, e: 0 }, { n: 100, e: 4000 }, false)).toBeNull();
  });
  it("catches a leg that leaves a concave keep-in with both ends inside", () => {
    const u = poly("in", [[-10, -10], [-10, 10], [10, 10], [10, 5], [-5, 5], [-5, -5], [10, -5], [10, -10]]);
    const zs = localZones([u], HOME);
    const br = legBreach(zs, { n: 5, e: -8 }, { n: 5, e: 8 }, false);
    expect(br?.zone.role).toBe("in");
    expect(br!.at.e).toBeCloseTo(-5, 0);
  });
  it("passes a leg that stays inside", () => {
    const zs = localZones([square("in", 0, 0, 100), circle("out", [80, 80], 5)], HOME);
    expect(legBreach(zs, { n: 0, e: 0 }, { n: 50, e: -50 }, false)).toBeNull();
  });
  it("finds a keep-out circle the leg cuts through, with both ends outside it", () => {
    const zs = localZones([circle("out", [0, 50], 5)], HOME);
    expect(legBreach(zs, { n: 3, e: 0 }, { n: 3, e: 100 }, false)).not.toBeNull();
    expect(legBreach(zs, { n: 6, e: 0 }, { n: 6, e: 100 }, false)).toBeNull();
  });
  it("measures how close a clear leg comes to an edge", () => {
    const zs = localZones([square("out", 0, 50, 10)], HOME);
    const c = legClearance(zs, { n: 13, e: 0 }, { n: 13, e: 100 });
    expect(c.m).toBeCloseTo(3, 0);
  });
});

describe("shapes that are not one shape", () => {
  it("finds a bow tie", () => {
    const bow: P[] = [{ n: 0, e: 0 }, { n: 10, e: 10 }, { n: 10, e: 0 }, { n: 0, e: 10 }];
    expect(selfCrossings(bow).length).toBeGreaterThan(0);
  });
  it("finds an edge that folds back", () => {
    expect(selfCrossings([{ n: 0, e: 0 }, { n: 10, e: 0 }, { n: 5, e: 0 }, { n: 5, e: 5 }]).length).toBeGreaterThan(0);
  });
  it("passes a plain concave shape", () => {
    expect(selfCrossings([{ n: -10, e: -10 }, { n: -10, e: 10 }, { n: 10, e: 10 }, { n: 10, e: 5 }, { n: -5, e: 5 }, { n: -5, e: -5 }, { n: 10, e: -5 }, { n: 10, e: -10 }])).toEqual([]);
  });
});

describe("the wire", () => {
  const zones = [square("in", 0, 0, 200), circle("out", [50, 50], 12.5), poly("out", [[-50, -50], [-60, -40], [-40, -40]])];
  it("goes as ArduPilot's fence items and comes back the same", () => {
    const w = zonesToWire(zones);
    expect(w.map((i) => i.command)).toEqual([5001, 5001, 5001, 5001, 5004, 5002, 5002, 5002]);
    expect(w[0].p1).toBe(4);
    expect(w[4].p1).toBe(12.5);
    expect(w.every((i, k) => i.seq === k)).toBe(true);
    expect(wireProblem(w)).toBeNull();
    const back = wireToZones(w);
    expect(sameZones(back.zones, zones)).toBe(true);
    expect(compareFence(w, zonesToWire(back.zones))).toBeNull();
  });
  it("keeps every corner to the 1e-7 degree the wire carries", () => {
    for (const z of zones) if (z.shape === "polygon") for (const p of z.points) expect(Math.round(p.lat * 1e7) / 1e7).toBe(p.lat);
  });
  it("refuses what ArduPilot refuses, in its words", () => {
    const w = zonesToWire([square("in", 0, 0, 10)]);
    expect(wireProblem(w.slice(0, 3))).toBe("Incorrect item count");
    expect(wireProblem([{ ...w[0], p1: 2 }, { ...w[1], p1: 2 }])).toMatch(/Invalid vertex count/);
    expect(wireProblem([...w.slice(0, 2), { ...w[2], command: FENCE_CMD.POLYGON_OUT }, w[3]])).toMatch(/incorrect vertex type/);
    expect(wireProblem([...w.slice(0, 2), { ...w[2], command: FENCE_CMD.CIRCLE_IN }, w[3]])).toMatch(/incorrect type/);
    expect(wireProblem([{ ...w[0], command: FENCE_CMD.CIRCLE_IN, p1: 0 }])).toMatch(/Non-positive/);
    expect(wireProblem([{ ...w[0], command: FENCE_CMD.RETURN_POINT }, { ...w[0], command: FENCE_CMD.RETURN_POINT }])).toMatch(/Multiple/);
  });
  it("reads a return point and sets it aside", () => {
    const w = [{ seq: 0, frame: 0, command: FENCE_CMD.RETURN_POINT, p1: 0, p2: 0, p3: 0, p4: 0, x: 230225000, y: 725714000, z: 0 }, ...zonesToWire([circle("in", [0, 0], 100)]).map((i) => ({ ...i, seq: 1 }))];
    const got = wireToZones(w);
    expect(got.zones).toHaveLength(1);
    expect(got.notes[0]).toMatch(/return point/);
  });
  it("tells a radius stored as a float from one that changed", () => {
    const a = zonesToWire([circle("in", [0, 0], 100.1)]);
    expect(compareFence(a, [{ ...a[0], p1: Math.fround(100.1) }])).toBeNull();
    expect(compareFence(a, [{ ...a[0], p1: 100.2 }])).toMatch(/radius/);
    expect(compareFence(a, [{ ...a[0], x: a[0].x + 1 }])).toMatch(/position/);
  });
  it("counts storage as ArduPilot does", () => {
    // Header 4, end marker 1; a 4-corner area 2 + 32; a circle 13.
    expect(storageBytes([square("in", 0, 0, 10)])).toBe(4 + 1 + 34);
    expect(storageBytes([square("in", 0, 0, 10), circle("out", [0, 0], 5)])).toBe(4 + 1 + 34 + 13);
  });
});

describe("helpers", () => {
  it("draws a keep-in round the route, clear of every point by the pad", () => {
    const route = [{ n: 100, e: 0 }, { n: 100, e: 200 }, { n: -50, e: 120 }];
    const ring = aroundRoute(HOME, route, 30);
    const zs = localZones([{ id: "r", shape: "polygon", role: "in", points: ring }], HOME);
    for (const p of [{ n: 0, e: 0 }, ...route]) {
      expect(breachAt(zs, p, false)).toBeNull();
      const z = zs[0];
      if (z.shape !== "polygon") throw new Error();
      // Every point is at least the pad from the edge.
      let d = Infinity;
      for (let i = 0; i < z.pts.length; i++) {
        const a = z.pts[i];
        const b = z.pts[(i + 1) % z.pts.length];
        const dn = b.n - a.n;
        const de = b.e - a.e;
        const t = Math.max(0, Math.min(1, ((p.n - a.n) * dn + (p.e - a.e) * de) / (dn * dn + de * de)));
        d = Math.min(d, Math.hypot(p.n - a.n - t * dn, p.e - a.e - t * de));
      }
      expect(d).toBeGreaterThanOrEqual(29.9);
    }
    expect(selfCrossings(z0(zs))).toEqual([]);
  });
  it("names zones within their role", () => {
    const zs = [square("in", 0, 0, 10), circle("out", [0, 0], 5), square("out", 0, 0, 5)];
    expect(zoneLabel(zs, zs[0].id)).toBe("Keep-in area 1");
    expect(zoneLabel(zs, zs[1].id)).toBe("Keep-out circle 1");
    expect(zoneLabel(zs, zs[2].id)).toBe("Keep-out area 2");
  });
  it("compares settings as the float32 the aircraft stores", () => {
    expect(limitsDiffer(DEFAULT_LIMITS, { ...DEFAULT_LIMITS, FENCE_MARGIN: Math.fround(2) })).toEqual([]);
    expect(limitsDiffer(DEFAULT_LIMITS, { ...DEFAULT_LIMITS, FENCE_ALT_MAX: 120 })).toEqual(["FENCE_ALT_MAX"]);
  });
});
const z0 = (zs: ReturnType<typeof localZones>) => {
  const z = zs[0];
  if (z.shape !== "polygon") throw new Error("not a polygon");
  return z.pts;
};

/* ------------------------------------------------------------- checks */

const check = (inp: Partial<FenceCheckInput>) => checkFence({ zones: [], limits: on(), home: HOME, ...inp });
const texts = (f: ReturnType<typeof checkFence>, sev?: string) => f.filter((x) => !sev || x.sev === sev).map((x) => x.text).join("\n");
const plan = (points: [number, number, number][], over: Partial<NonNullable<FenceCheckInput["plan"]>> = {}) => ({ points: points.map(([north, east, alt]) => ({ n: north, e: east, alt })), takeoffAlt: 10, ending: "rtl" as const, ...over });

describe("checking a fence the way ArduPilot will", () => {
  it("says when the fence is off, and treats its problems as warnings until it is on", () => {
    const f = check({ limits: DEFAULT_LIMITS, zones: [square("in", 500, 500, 50)] });
    expect(texts(f, "warn")).toMatch(/fence is off/);
    expect(texts(f, "warn")).toMatch(/Home is outside Keep-in area 1/);
    expect(texts(f, "bad")).toBe("");
  });
  it("matches the pre-arm refusals", () => {
    expect(texts(check({ limits: on({ FENCE_TYPE: 0 }) }), "bad")).toMatch(/none selected/);
    expect(texts(check({ limits: on({ FENCE_TYPE: FENCE_TYPE.POLYGON }) }), "bad")).toMatch(/none selected/);
    expect(texts(check({ limits: on({ FENCE_ALT_MAX: 20, FENCE_ALT_MIN: 30, FENCE_TYPE: 9 }) }), "bad")).toMatch(/FENCE_ALT_MAX < FENCE_ALT_MIN/);
    expect(texts(check({ limits: on({ FENCE_ALT_MAX: 13, FENCE_ALT_MIN: 10, FENCE_MARGIN: 2 }) }), "bad")).toMatch(/FENCE_MARGIN too big/);
    expect(texts(check({ limits: on({ FENCE_RADIUS: 1, FENCE_MARGIN: 2 }) }), "bad")).toMatch(/Circle FENCE_MARGIN is greater than FENCE_RADIUS/);
    expect(texts(check({ zones: [circle("in", [0, 0], 1.5)], limits: on({ FENCE_MARGIN: 2 }) }), "bad")).toMatch(/inclusion circle radius/);
    expect(texts(check({ zones: [circle("out", [0, 0], 20)] }), "bad")).toMatch(/Home is inside Keep-out circle 1/);
  });
  it("only uses FENCE_MARGIN_XY when it is set", () => {
    expect(texts(check({ limits: on({ FENCE_RADIUS: 30 }), other: { FENCE_MARGIN_XY: 40 } }), "bad")).toMatch(/FENCE_RADIUS/);
    expect(texts(check({ limits: on({ FENCE_RADIUS: 30 }), other: { FENCE_MARGIN_XY: 0 } }), "bad")).toBe("");
  });
  it("finds a crossed shape, a shape on a line and corners on top of each other", () => {
    expect(texts(check({ zones: [poly("in", [[-100, -100], [100, 100], [100, -100], [-100, 100]])] }), "bad")).toMatch(/crosses itself/);
    expect(texts(check({ zones: [poly("out", [[200, 0], [210, 0], [220, 0]])] }), "bad")).toMatch(/no area/);
    expect(texts(check({ zones: [poly("out", [[200, 0], [200, 0], [220, 10]])] }), "bad")).toMatch(/same place/);
  });
  it("suggests union when home is in one keep-in but not another", () => {
    const zs = [square("in", 0, 0, 100), square("in", 0, 500, 100)];
    expect(texts(check({ zones: zs }), "bad")).toMatch(/Inside any keep-in zone is enough/);
    expect(texts(check({ zones: zs, limits: on({ FENCE_OPTIONS: OPTION_UNION }) }), "bad")).toBe("");
  });
  it("ignores drawn zones when the type leaves them out, and says so", () => {
    const f = check({ zones: [circle("out", [0, 0], 20)], limits: on({ FENCE_TYPE: FENCE_TYPE.ALT_MAX }) });
    expect(texts(f, "bad")).toBe("");
    expect(texts(f, "warn")).toMatch(/not used/);
  });
  it("warns about storage past a Pixhawk's fence room, unless an SD card adds it", () => {
    const big = Array.from({ length: 4 }, (_, k) => poly("out", Array.from({ length: 20 }, (_, i) => [1000 + k * 300 + 50 * Math.cos(i / 3.2), 50 * Math.sin(i / 3.2)] as [number, number])));
    expect(texts(check({ zones: big }), "warn")).toMatch(/Fence exceeds storage size/);
    expect(texts(check({ zones: big, other: { BRD_SD_FENCE: 4 } }), "warn")).not.toMatch(/storage/);
  });
});

describe("checking the route against the fence", () => {
  it("finds the first leg into a keep-out and what the aircraft does there", () => {
    const f = check({ zones: [square("out", 100, 0, 20)], plan: plan([[200, 0, 30]]) });
    const bad = texts(f, "bad");
    expect(bad).toMatch(/enters Keep-out area 1 80 m after home, on the way to waypoint 1/);
    expect(bad).toMatch(/returns home/);
    // With the cruise known, how far past the edge it goes while it stops (ArduCopter went 21 m at 10 m/s and 2.5 m/s²).
    const f2 = check({ zones: [square("out", 100, 0, 20)], plan: plan([[200, 0, 30]]), other: { WPNAV_SPEED: 1000, WPNAV_ACCEL: 250 } });
    expect(texts(f2, "bad")).toMatch(/needs about 20 m to stop, so expect it that far inside the zone/);
  });
  it("finds a leg that leaves the keep-in, and the return leg too", () => {
    const f = check({ zones: [square("in", 0, 0, 100)], plan: plan([[50, 50, 30], [150, 50, 30]]) });
    expect(texts(f, "bad")).toMatch(/leaves Keep-in area 1 50 m after waypoint 1/);
    expect(texts(f, "bad")).toMatch(/2 legs breach/);
  });
  it("warns when the route runs inside the margin", () => {
    const f = check({ zones: [square("out", 100, 0, 20)], plan: plan([[0, 21.5, 30], [200, 21.5, 30]], { ending: "land" }), limits: on({ FENCE_MARGIN: 2 }) });
    expect(texts(f, "warn")).toMatch(/1\.5 m from the edge of Keep-out area 1/);
  });
  it("warns that a return home goes straight through a keep-out, unless Dijkstra plans round it", () => {
    // The route goes round the zone; home is behind it from the far waypoint.
    const zs = [square("out", 100, 0, 30)];
    const route = plan([[0, 50, 30], [200, 50, 30], [200, 0, 30], [200, -50, 30], [0, -50, 30]], { ending: "land" });
    const f = check({ zones: zs, plan: route });
    expect(texts(f, "bad")).toBe("");
    expect(texts(f, "warn")).toMatch(/From waypoints 2, 3, 4, the straight way home crosses a zone/);
    expect(texts(check({ zones: zs, plan: route, other: { OA_TYPE: 2 } }), "note")).toMatch(/Dijkstra/);
  });
  it("checks the circle round home, the ceiling and the floor", () => {
    expect(texts(check({ plan: plan([[400, 0, 30]]) }), "bad")).toMatch(/outside the 300 m distance limit/);
    expect(texts(check({ plan: plan([[50, 0, 100]]) }), "bad")).toMatch(/at or above the 100 m ceiling/);
    expect(texts(check({ plan: plan([[50, 0, 99]]) }), "warn")).toMatch(/within the 2\.0 m margin below the 100 m ceiling/);
    expect(texts(check({ plan: plan([[50, 0, 50]]), other: { RTL_ALT: 12000 } }), "note")).toMatch(/flies it at 98 m/);
    const floor = on({ FENCE_TYPE: 15, FENCE_ALT_MIN: 20 });
    expect(texts(check({ limits: floor, plan: plan([[50, 0, 40], [60, 0, 15]]) }), "bad")).toMatch(/Waypoint 2 is at 15 m, below the 20 m floor/);
    // Landing at the end crosses the floor without breaching: ArduPilot switches it off to land.
    expect(texts(check({ limits: floor, plan: plan([[50, 0, 40]], { ending: "land" }) }), "bad")).toBe("");
    expect(texts(check({ limits: floor, plan: plan([[50, 0, 15]]) }), "note")).toMatch(/never switches on/);
  });
  it("is quiet about a sound fence and a route inside it", () => {
    const f = check({ zones: [square("in", 0, 0, 300), circle("out", [200, 200], 30)], limits: on({ FENCE_RADIUS: 500 }), plan: plan([[100, 0, 30], [100, 100, 40], [0, 100, 30]]) });
    expect(f.filter((x) => x.sev !== "note")).toEqual([]);
  });
  it("converts consistently with the planner's own home frame", () => {
    const z = square("in", 0, 0, 50);
    if (z.shape !== "polygon") throw new Error();
    const l = toLocal(HOME, z.points[0].lat, z.points[0].lon);
    expect(l.n).toBeCloseTo(-50, 1);
    expect(l.e).toBeCloseTo(-50, 1);
  });
});
