import { describe, expect, it } from "vitest";
import { snap, zonesToWire, type FenceZone } from "../../geo/fence";
import { toGlobal } from "../../geo/geo";
import { PRESETS } from "../airframe";
import { CMD, MODE, type MissionItem } from "../autopilot";
import { defaultParams } from "../params";
import { predict } from "../predict";
import { VirtualVehicle } from "../vehicle";

/*
  The virtual aircraft enforcing a fence the way ArduCopter does: zones,
  floor, ceiling, the return capped below it, breaches that clear and act
  again, and the pre-arm refusals. The real firmware is checked against the
  same situations in sitl/fence.test.ts.
*/

const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const at = (n: number, e: number) => snap(toGlobal(HOME, n, e));
const box = (role: "in" | "out", cn: number, ce: number, half: number): FenceZone => ({
  id: `${role}${cn}${ce}`, shape: "polygon", role, points: [at(cn - half, ce - half), at(cn - half, ce + half), at(cn + half, ce + half), at(cn + half, ce - half)],
});
const wp = (seq: number, n: number, e: number, alt: number, command: number = CMD.WAYPOINT): MissionItem => {
  const g = toGlobal(HOME, n, e);
  const here = command === CMD.RTL;
  return { seq, frame: 3, command, p1: 0, p2: 0, p3: 0, p4: 0, x: here ? 0 : Math.round(g.lat * 1e7), y: here ? 0 : Math.round(g.lon * 1e7), z: alt };
};
const out = (to: [number, number], alt = 20): MissionItem[] => [wp(0, 0, 0, 0), wp(1, 0, 0, alt, CMD.TAKEOFF), wp(2, to[0], to[1], alt), wp(3, 0, 0, 0, CMD.RTL)];
const calm = { windSpeed: 0, windFromDeg: 0, gust: 0, soc: 1, faults: [] };
const params = (over: Record<string, number> = {}) => ({ ...defaultParams(PRESETS[0]), FENCE_ENABLE: 1, ...over });

describe("the virtual aircraft's fence", () => {
  it("turns back at a keep-out zone across the route, and the breach clears on the way home", () => {
    const fence = zonesToWire([box("out", 120, 0, 20)]);
    const p = predict(PRESETS[0], params(), HOME, out([250, 0]), { ...calm, fence });
    const texts = p.events.map((e) => e.text);
    expect(texts).toContain("Polygon fence breached");
    expect(texts).toContain("Fence breach cleared");
    expect(p.verdict).toBe("came-home");
    // It got into the zone's edge, and not much further.
    const furthest = Math.max(...p.track.map((t) => t.n));
    expect(furthest).toBeGreaterThan(99);
    expect(furthest).toBeLessThan(125);
  });

  it("flies a route that stays inside a keep-in zone to the end", () => {
    const fence = zonesToWire([box("in", 50, 0, 100)]);
    const p = predict(PRESETS[0], params(), HOME, out([120, 0]), { ...calm, fence });
    expect(p.verdict).toBe("completed");
    expect(p.events.some((e) => e.kind === "fs-fence")).toBe(false);
  });

  it("lands where it is on FENCE_ACTION 2, and only reports on 0", () => {
    const fence = zonesToWire([box("out", 120, 0, 20)]);
    const land = predict(PRESETS[0], params({ FENCE_ACTION: 2 }), HOME, out([250, 0]), { ...calm, fence });
    expect(land.verdict).toBe("landed-away");
    const report = predict(PRESETS[0], params({ FENCE_ACTION: 0 }), HOME, out([250, 0]), { ...calm, fence });
    expect(report.verdict).toBe("completed");
    expect(report.findings.some((f) => /only reported it/.test(f.text))).toBe(true);
  });

  it("refuses to arm with home in a keep-out, as ArduPilot does", () => {
    const v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME, params: params() });
    v.ap.setFence(zonesToWire([box("out", 0, 0, 30)]));
    expect(v.ap.prearm(v.inputs())).toContain("Vehicle breaching Polygon fence");
    v.ap.setFence(zonesToWire([box("in", 500, 0, 30)]));
    expect(v.ap.prearm(v.inputs())).toContain("Vehicle breaching Polygon fence");
    v.ap.setFence([]);
    v.ap.params.FENCE_TYPE = 4;
    expect(v.ap.prearm(v.inputs())).toContain("Fences enabled, but none selected");
  });

  it("keeps the return home under the ceiling less its margin", () => {
    const p = predict(PRESETS[0], params({ FENCE_TYPE: 1, FENCE_ALT_MAX: 40, FENCE_MARGIN: 2, RTL_ALT: 8000 }), HOME, out([150, 0], 20), calm);
    expect(p.verdict).toBe("completed");
    const top = Math.max(...p.track.map((t) => t.alt));
    expect(top).toBeLessThan(40);
    expect(top).toBeGreaterThan(36);
  });

  it("switches the floor on above it, breaches below it, and lets the landing through", () => {
    const floor = params({ FENCE_TYPE: 8, FENCE_ALT_MIN: 15, FENCE_MARGIN: 2 });
    const dip: MissionItem[] = [wp(0, 0, 0, 0), wp(1, 0, 0, 25, CMD.TAKEOFF), wp(2, 60, 0, 25), wp(3, 120, 0, 10), wp(4, 0, 0, 0, CMD.RTL)];
    const p = predict(PRESETS[0], floor, HOME, dip, calm);
    const texts = p.events.map((e) => e.text);
    expect(texts).toContain("Min Alt fence enabled (auto enable)");
    expect(texts).toContain("Min Alt fence breached");
    const ok = predict(PRESETS[0], floor, HOME, out([100, 0], 25), calm);
    expect(ok.verdict).toBe("completed");
    expect(ok.events.some((e) => e.kind === "fs-fence")).toBe(false);
  });

  it("gives up and lands when it is more than 100 m outside", () => {
    // A breach is normally caught at the edge; a position jump (a GPS glitch) is how it ends up far outside.
    const v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME, params: params({ FENCE_TYPE: 2, FENCE_RADIUS: 30 }) });
    v.setScriptedGcs(true);
    v.ap.setMode(MODE.GUIDED, v.inputs());
    expect(v.ap.arm(v.inputs())).toEqual([]);
    v.ap.guidedTakeoff(10);
    for (let t = 0; t < 20; t += 0.1) v.advance(0.1, 0.1, false);
    // Moved 200 m out at once, as a GPS glitch would.
    v.phys.s.pos[0] = 200;
    for (let t = 0; t < 1; t += 0.1) v.advance(0.1, 0.1, false);
    expect(v.events.some((e) => /more than 100 m outside, landing/.test(e.text))).toBe(true);
    expect(v.ap.mode).toBe(MODE.LAND);
  });
});
