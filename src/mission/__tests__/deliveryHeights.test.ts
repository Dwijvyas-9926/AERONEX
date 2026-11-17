import { describe, expect, it } from "vitest";
import { PRESETS } from "../../sim/airframe";
import { CMD, MODE, type MissionItem } from "../../sim/autopilot";
import { defaultParams } from "../../sim/params";
import { predict } from "../../sim/predict";
import { makeTerrain } from "../../sim/terrain";
import { VirtualVehicle } from "../../sim/vehicle";
import { planToMission, type PlanPoint } from "../../state/simStore";
import { armAwayFindings } from "../armHome";
import { deliverySeconds, newDelivery, releaseKey, type Delivery } from "../payload";

/*
  The heights a delivery is flown at, in the virtual aircraft, against what
  ArduCopter does: a release waits for the aircraft to stop, lowering starts
  only once the descent is steady, and home is wherever it arms.
*/
const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const M = 111319.5;
const LIFTER = PRESETS[3];
const GRIP = { GRIP_ENABLE: 1, GRIP_TYPE: 1, SERVO9_FUNCTION: 28 };
const HILLS = makeTerrain("hills");
const AT = { n: 60, e: 30 };

const fly = (d: Delivery, cruiseAgl: number) => {
  const g = HILLS.surface(AT.n, AT.e);
  const pts: PlanPoint[] = [{ id: "a", n: AT.n, e: AT.e, alt: Math.round(g + cruiseAgl), holdS: 0, delivery: d }];
  const m = planToMission(HOME, 20, pts, "rtl", HILLS.surface);
  const r = predict(LIFTER, { ...defaultParams(LIFTER), ...GRIP }, HOME, m, { windSpeed: 0, windFromDeg: 0, gust: 0, soc: 1, faults: [], payloads: [{ kg: d.kg, hangM: d.hangM, release: releaseKey(d.release) }], deliveryNames: ["wp"] }, 7, HILLS);
  expect(r.deliveries.length).toBe(1);
  return { r, x: r.deliveries[0] };
};

describe("delivery heights in the virtual aircraft", () => {
  it("lets go at the height asked for, stopped, with a one-second settle", () => {
    const { x } = fly({ ...newDelivery("drop", { kind: "gripper" }, 0.5), heightM: 10, settleS: 1, afterS: 1 }, 25);
    expect(x.outcome).toBe("released");
    expect(Math.abs(x.agl - 10)).toBeLessThan(0.15);
    expect(x.speed).toBeLessThan(0.2);
  }, 120000);

  it("is stopped when it lets go at the waypoint's own height", () => {
    const { x } = fly({ ...newDelivery("drop", { kind: "gripper" }, 0.5), heightM: 15 }, 15);
    expect(x.outcome).toBe("released");
    expect(Math.abs(x.agl - 15)).toBeLessThan(0.6);
    expect(x.speed).toBeLessThan(0.2);
  }, 120000);

  it("lowers from above the waypoint and lets go at touchdown, not on landing", () => {
    const d = { ...newDelivery("lower", { kind: "gripper" }, 1), heightM: 20, giveUpM: 30, hangM: 1 };
    const { r, x } = fly(d, 12);
    expect(x.outcome).toBe("released");
    expect(Math.abs(x.agl - d.hangM)).toBeLessThan(0.4);
    expect(r.verdict).not.toBe("crashed");
  }, 120000);
});

/* ------------------------------------------------------- the vehicle itself */
const make = (ground?: (n: number, e: number) => number) => {
  const v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME, params: {}, soc: 1 });
  v.setScriptedGcs(true);
  if (ground) v.phys.ground = ground;
  return v;
};
const run = (v: VirtualVehicle, seconds: number, each?: () => boolean | void) => {
  for (let t = 0; t < seconds; t += 0.1) {
    v.advance(0.1, 0.1, false);
    if (each?.()) return true;
  }
  return false;
};
const wp = (seq: number, n: number, e: number, alt: number, command: number = CMD.WAYPOINT, p1 = 0): MissionItem => ({
  seq, frame: 3, command, p1, p2: 0, p3: 0, p4: 0,
  x: command === CMD.RTL ? 0 : Math.round((HOME.lat + n / M) * 1e7),
  y: command === CMD.RTL ? 0 : Math.round((HOME.lon + e / (M * Math.cos((HOME.lat * Math.PI) / 180))) * 1e7),
  z: alt,
});
const start = (v: VirtualVehicle, items: MissionItem[]) => {
  v.ap.mission = items;
  v.ap.setMode(MODE.GUIDED, v.inputs());
  expect(v.ap.arm(v.inputs())).toEqual([]);
  expect(v.ap.setMode(MODE.AUTO, v.inputs())).toBe(true);
  expect(v.ap.startMission()).toBe(true);
};

describe("waypoints with a hold", () => {
  it("count the hold from when it has stopped there, and say Reached when the hold ends", () => {
    const v = make();
    start(v, [wp(0, 0, 0, 0), wp(1, 0, 0, 10, CMD.TAKEOFF), wp(2, 40, 0, 10, CMD.WAYPOINT, 5), wp(3, 0, 0, 0, CMD.RTL)]);
    let stoppedAt: number | null = null;
    run(v, 120, () => {
      const s = v.phys.s;
      if (stoppedAt === null && Math.hypot(s.pos[0] - 40, s.pos[1], v.ap.alt - 10) < 0.5 && Math.hypot(...s.vel) < 0.3) stoppedAt = s.t;
      return v.ap.events.some((e) => e.text === "Reached command #2");
    });
    const reached = v.ap.events.find((e) => e.text === "Reached command #2");
    expect(stoppedAt).not.toBeNull();
    expect(reached).toBeDefined();
    expect(reached!.t - stoppedAt!).toBeGreaterThan(4.5);
    expect(reached!.t - stoppedAt!).toBeLessThan(8.5);
  }, 60000);
});

describe("home", () => {
  // A step of ground 6 m up, north of 50 m.
  const step = (n: number) => (n > 50 ? 6 : 0);

  it("moves to where it arms, and heights and the return count from there", () => {
    const v = make((n) => step(n));
    v.phys.s.pos = [80, 0, -6];
    start(v, [wp(0, 0, 0, 0), wp(1, 0, 0, 10, CMD.TAKEOFF), wp(2, 80, 40, 10), wp(3, 0, 0, 0, CMD.RTL)]);
    expect(v.ap.homeAt.n).toBeCloseTo(80, 3);
    expect(v.ap.homeAt.z).toBeCloseTo(6, 3);
    expect(Math.abs(v.ap.alt)).toBeLessThan(0.05);
    let top = 0;
    run(v, 240, () => {
      if (v.ap.missionSeq < 3) top = Math.max(top, v.ap.height);
      return !v.ap.armed;
    });
    // 10 m above where it armed is 16 m above where it started.
    expect(top).toBeGreaterThan(15.3);
    expect(top).toBeLessThan(17);
    // Home, for the return, is where it armed; its height there counts from there too (RTL_ALT 15 m).
    expect(Math.hypot(v.phys.s.pos[0] - 80, v.phys.s.pos[1])).toBeLessThan(2);
    const h = v.ap.homeNow();
    expect(h.altMsl).toBeCloseTo(HOME.altMsl + 6, 3);
    expect((h.lat - HOME.lat) * M).toBeCloseTo(80, 1);
  }, 60000);

  it("goes back to where it started when the aircraft is put back", () => {
    const v = make((n) => step(n));
    v.phys.s.pos = [80, 0, -6];
    v.ap.setMode(MODE.GUIDED, v.inputs());
    expect(v.ap.arm(v.inputs())).toEqual([]);
    v.reset(1);
    expect(v.ap.homeAt).toEqual({ n: 0, e: 0, z: 0 });
    expect(v.ap.alt).toBeCloseTo(0, 3);
  });
});

describe("arming away from home", () => {
  const d = (patch: Partial<Delivery> = {}) => ({ wp: 2, delivery: { ...newDelivery("drop", { kind: "gripper" }, 0.5), heightM: 10, ...patch }, cruise: 30, ground: 0 });

  it("says nothing at home, or when armed", () => {
    expect(armAwayFindings({ armed: false, at: { n: 2, e: 3 }, groundThere: 0, reported: null, deliveries: [d()], putBack: "" })).toEqual([]);
    expect(armAwayFindings({ armed: true, at: { n: 200, e: 0 }, groundThere: 9, reported: null, deliveries: [d()], putBack: "" })).toEqual([]);
  });

  it("gives the height a drop would let go at from higher ground", () => {
    const f = armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: 6, reported: null, deliveries: [d()], putBack: "Put it back." });
    expect(f).toHaveLength(1);
    expect(f[0].sev).toBe("bad");
    expect(f[0].text).toContain("16 m above the ground, not 10 m");
  });

  it("finds a drop that would be in the ground from higher ground lower down", () => {
    const f = armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: -12, reported: null, deliveries: [d()], putBack: "" });
    expect(f[0].sev).toBe("bad");
    expect(f[0].text).toContain("in the ground");
  });

  it("finds lowering that would give up before the load touches", () => {
    const f = armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: 20, reported: null, deliveries: [d({ ...newDelivery("lower", { kind: "gripper" }, 1), heightM: 10, giveUpM: 20, hangM: 1 })], putBack: "" });
    expect(f[0].sev).toBe("bad");
    expect(f[0].text).toContain("give up");
  });

  it("uses the aircraft's own height when the ground is not known, and says so when neither is", () => {
    expect(armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: null, reported: 4, deliveries: [d()], putBack: "" })[0].text).toContain("14 m above the ground");
    const none = armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: null, reported: null, deliveries: [d()], putBack: "" });
    expect(none[0].sev).toBe("bad");
    expect(none[0].text).toContain("not known");
  });

  it("only notes it on level ground without deliveries", () => {
    expect(armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: 0.2, reported: null, deliveries: [], putBack: "" })[0].sev).toBe("note");
    expect(armAwayFindings({ armed: false, at: { n: 200, e: 0 }, groundThere: -8, reported: null, deliveries: [], putBack: "" })[0].sev).toBe("warn");
  });
});

describe("delivery time", () => {
  it("counts the climb when the release is above the waypoint", () => {
    const p = defaultParams(PRESETS[0]);
    const level = deliverySeconds({ ...newDelivery("drop", { kind: "gripper" }, 0.5), heightM: 12 }, 12, 0, p);
    const above = deliverySeconds({ ...newDelivery("drop", { kind: "gripper" }, 0.5), heightM: 22 }, 12, 0, p);
    // 10 m up at 2.5 m/s and back down at 1.5 m/s.
    expect(above - level).toBeCloseTo(10 / 2.5 + 10 / 1.5, 1);
  });
});
