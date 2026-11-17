import { describe, expect, it } from "vitest";
import { fromWaypointFile, toWaypointFile } from "../../geo/planFile";
import { checkPlan, flightSeconds } from "../../geo/planCheck";
import { routeProfile } from "../../geo/profile";
import { compareMissions } from "../../services/link/commandLink";
import { PRESETS } from "../../sim/airframe";
import { CMD, type MissionItem } from "../../sim/autopilot";
import { defaultParams } from "../../sim/params";
import { predict, type Scenario } from "../../sim/predict";
import { missionToPlan, planSteps, planToMission, type PlanPoint } from "../../state/simStore";
import { checkDeliveries, deliveryCommands, deliverySeconds, GRIP, newDelivery, PAYLOAD_CMD, releaseKey, releaseOptions, soundDelivery, switchMethod, type Delivery, type Release } from "../payload";

/*
  Payload delivery, against what ArduCopter 4.6.3 and 4.7.2 do (see
  payload.ts): the sequence written, reading it back, the checks before
  sending, and the virtual aircraft flying it.
*/
const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const AF = PRESETS[0]; // 1.5 kg, 450 quad
const LIFTER = PRESETS[3]; // 3.6 kg, 650 lifter
const GRIPPER: Release = { kind: "gripper" };
const SERVO10: Release = { kind: "servo", servo: 10, open: 1900, closed: 1100 };
const port = (n: number) => (n <= 8 ? `MAIN OUT ${n}` : `AUX OUT ${n - 8}`);
const pt = (n: number, e: number, alt: number, delivery?: Delivery, holdS = 0): PlanPoint => ({ id: `${n}/${e}`, n, e, alt, holdS, ...(delivery ? { delivery } : {}) });
const drop = (patch: Partial<Delivery> = {}): Delivery => ({ ...newDelivery("drop", GRIPPER, 0.4), ...patch });
const lower = (patch: Partial<Delivery> = {}): Delivery => ({ ...newDelivery("lower", GRIPPER, 0.6), ...patch });
/** A gripper set up the Servo Outputs page's way, on AUX OUT 1. */
const GRIP_SET = { GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1900, GRIP_RELEASE: 1100, GRIP_NEUTRAL: 1500, SERVO9_FUNCTION: 28 };
const aircraft = (extra: Record<string, number> = {}) => ({ ...defaultParams(AF), ...GRIP_SET, ...extra });

describe("the commands a delivery is written as", () => {
  const at = { x: 230225000, y: 725714000 };

  it("a drop stops overhead, comes straight down, settles, lets go, waits, and climbs back, all on one spot", () => {
    const c = deliveryCommands(drop({ heightM: 10, settleS: 4, afterS: 5 }), at, 40, 3, 0);
    expect(c.map((x) => x.command)).toEqual([PAYLOAD_CMD.WAYPOINT, PAYLOAD_CMD.WAYPOINT, PAYLOAD_CMD.GRIPPER, PAYLOAD_CMD.LOITER_TIME, PAYLOAD_CMD.WAYPOINT]);
    // Every navigation point is the same place.
    for (const x of [c[0], c[1], c[3], c[4]]) expect([x.x, x.y]).toEqual([at.x, at.y]);
    // Cruise, the release height measured from the ground there, and back.
    expect(c.map((x) => x.z)).toEqual([40, 13, 0, 13, 40]);
    // Each stop has a wait, so the aircraft stops on it instead of rounding the corner (ModeAuto::do_nav_wp).
    expect(c[0].p1).toBeGreaterThanOrEqual(1);
    expect(c[1].p1).toBe(4);
    expect(c[3].p1).toBe(5);
    expect(c[4].p1).toBeGreaterThanOrEqual(1);
    // GRIPPER_ACTION_RELEASE is 0; gripper number 1.
    expect([c[2].p1, c[2].p2]).toEqual([1, GRIP.RELEASE]);
    expect([c[2].x, c[2].y, c[2].z]).toEqual([0, 0, 0]);
  });

  it("a servo drop sends the output its opening pulse", () => {
    const c = deliveryCommands(drop({ release: SERVO10 }), at, 30, 0, 0);
    expect(c[2]).toMatchObject({ command: PAYLOAD_CMD.SET_SERVO, p1: 10, p2: 1900 });
  });

  it("keeps the waypoint's own wait on arrival", () => {
    expect(deliveryCommands(drop(), at, 30, 0, 12)[0].p1).toBe(12);
  });

  it("lowering is one payload-place command between arriving and leaving, with its give-up depth", () => {
    const c = deliveryCommands(lower({ heightM: 15, giveUpM: 22 }), at, 40, 2.5, 0);
    expect(c.map((x) => x.command)).toEqual([PAYLOAD_CMD.WAYPOINT, PAYLOAD_CMD.PAYLOAD_PLACE, PAYLOAD_CMD.WAYPOINT]);
    expect(c[1]).toMatchObject({ x: at.x, y: at.y, z: 17.5, p1: 22, frame: 3 });
  });
});

describe("a plan with deliveries as a mission", () => {
  const plan = [pt(150, 50, 40), pt(220, -90, 40, drop({ release: SERVO10 })), pt(40, -160, 35, lower())];

  it("closes every release before the take-off, once each, and nothing else comes before it", () => {
    const m = planToMission(HOME, 20, plan, "rtl");
    const takeoff = m.findIndex((x) => x.command === CMD.TAKEOFF);
    const before = m.slice(1, takeoff);
    expect(before).toHaveLength(2);
    expect(before.find((x) => x.command === PAYLOAD_CMD.SET_SERVO)).toMatchObject({ p1: 10, p2: 1100 });
    expect(before.find((x) => x.command === PAYLOAD_CMD.GRIPPER)).toMatchObject({ p1: 1, p2: GRIP.GRAB });
    // ArduCopter starts Auto only if the first navigation command is a take-off: these are do commands (is_takeoff_next).
    expect(before.every((x) => x.command === PAYLOAD_CMD.SET_SERVO || x.command === PAYLOAD_CMD.GRIPPER)).toBe(true);
    expect(m.map((x) => x.seq)).toEqual(m.map((_, i) => i));
  });

  it("has a word for every item it writes", () => {
    for (const ending of ["rtl", "land", "hold"] as const) {
      for (const pts of [plan, [pt(10, 10, 20)], [pt(10, 10, 20, drop())], []]) {
        expect(planSteps(pts, ending)).toHaveLength(planToMission(HOME, 20, pts, ending).length);
      }
    }
    expect(planSteps(plan, "rtl")[planToMission(HOME, 20, plan, "rtl").findIndex((x) => x.command === PAYLOAD_CMD.SET_SERVO && x.p2 === 1900)]).toBe("waypoint 2, the release");
  });

  it("is read back as the same plan, deliveries and all", () => {
    const ground = (n: number, e: number) => (n + e) / 100;
    const m = planToMission(HOME, 20, plan, "rtl", ground);
    const back = missionToPlan(m, HOME, ground);
    expect(back.ending).toBe("rtl");
    expect(back.takeoffAlt).toBe(20);
    expect(back.points.map((p) => [p.n, p.e, p.alt, p.holdS])).toEqual(plan.map((p) => [p.n, p.e, p.alt, p.holdS]));
    for (let i = 0; i < plan.length; i++) {
      const a = plan[i].delivery;
      const b = back.points[i].delivery;
      if (!a) {
        expect(b).toBeUndefined();
        continue;
      }
      expect(b).toMatchObject({ method: a.method, release: a.release, heightM: a.heightM, ...(a.method === "drop" ? { settleS: a.settleS, afterS: a.afterS } : { giveUpM: a.giveUpM }) });
    }
    // Only the weight, which a mission does not carry, is said to be missing.
    expect(back.notes).toHaveLength(1);
    expect(back.notes[0]).toContain("weight");
  });

  it("keeps the weight already planned for a delivery at the same place, which the mission does not carry", () => {
    const m = planToMission(HOME, 20, plan, "rtl");
    const back = missionToPlan(m, HOME, () => 0, (n, e) => (Math.hypot(n - 220, e + 90) < 2 ? { kg: 1.7, hangM: 2 } : null));
    expect(back.points[1].delivery).toMatchObject({ kg: 1.7, hangM: 2 });
    expect(back.points[2].delivery).toMatchObject({ kg: 0.5 });
    expect(back.notes.join(" ")).toContain("its delivery is shown at 0.5 kg");
    const all = missionToPlan(m, HOME, () => 0, () => ({ kg: 1, hangM: 1 }));
    expect(all.notes).toEqual([]);
  });

  it("survives a waypoint file, release and all", () => {
    const m = planToMission(HOME, 20, plan, "land");
    const read = fromWaypointFile(toWaypointFile(m));
    expect(compareMissions(m, read)).toBeNull();
    expect(missionToPlan(read, HOME).points.filter((p) => p.delivery)).toHaveLength(2);
  });

  it("reads a release written straight after a waypoint, as other ground stations write it, and says it will be rebuilt", () => {
    const wp = (seq: number, n: number, z: number, p1 = 0): MissionItem => ({ seq, frame: 3, command: 16, p1, p2: 0, p3: 0, p4: 0, x: Math.round((HOME.lat + n / 111319.5) * 1e7), y: Math.round(HOME.lon * 1e7), z });
    const items: MissionItem[] = [
      { seq: 0, frame: 0, command: 16, p1: 0, p2: 0, p3: 0, p4: 0, x: Math.round(HOME.lat * 1e7), y: Math.round(HOME.lon * 1e7), z: 53 },
      { seq: 1, frame: 3, command: 22, p1: 0, p2: 0, p3: 0, p4: 0, x: 0, y: 0, z: 20 },
      wp(2, 100, 15, 5),
      { seq: 3, frame: 2, command: 183, p1: 9, p2: 2000, p3: 0, p4: 0, x: 0, y: 0, z: 0 },
      wp(4, 200, 30),
      { seq: 5, frame: 3, command: 20, p1: 0, p2: 0, p3: 0, p4: 0, x: 0, y: 0, z: 0 },
    ];
    const back = missionToPlan(items, HOME);
    expect(back.points).toHaveLength(2);
    expect(back.points[0].delivery).toMatchObject({ method: "drop", heightM: 15, settleS: 5, release: { kind: "servo", servo: 9, open: 2000 } });
    expect(back.notes.join(" ")).toContain("written another way");
  });

  it("reads a gripper grab anywhere but before the take-off as a command it cannot show", () => {
    const m = planToMission(HOME, 20, [pt(100, 0, 30)], "rtl");
    m.splice(3, 0, { seq: 0, frame: 2, command: 211, p1: 1, p2: 1, p3: 0, p4: 0, x: 0, y: 0, z: 0 });
    m.forEach((x, i) => (x.seq = i));
    expect(missionToPlan(m, HOME).notes.join(" ")).toContain("gripper");
  });
});

describe("checking what is sent against what the aircraft holds", () => {
  const m = planToMission(HOME, 20, [pt(150, 50, 40, drop())], "rtl");
  const release = m.findIndex((x) => x.command === PAYLOAD_CMD.GRIPPER && x.p2 === GRIP.RELEASE);

  it("catches a release that reads back as a grab", () => {
    const got = m.map((x, i) => (i === release ? { ...x, p2: GRIP.GRAB } : x));
    expect(compareMissions(m, got)).toContain("release");
  });

  it("catches a servo pulse or output that reads back differently", () => {
    const s = planToMission(HOME, 20, [pt(150, 50, 40, drop({ release: SERVO10 }))], "rtl");
    const i = s.findIndex((x) => x.command === PAYLOAD_CMD.SET_SERVO && x.p2 === 1900);
    expect(compareMissions(s, s.map((x, k) => (k === i ? { ...x, p2: 1500 } : x)))).toContain("1500");
    expect(compareMissions(s, s.map((x, k) => (k === i ? { ...x, p1: 11 } : x)))).toContain("output 11");
  });

  it("catches a lowering's give-up depth reading back differently", () => {
    const l = planToMission(HOME, 20, [pt(150, 50, 40, lower())], "rtl");
    const i = l.findIndex((x) => x.command === PAYLOAD_CMD.PAYLOAD_PLACE);
    expect(compareMissions(l, l.map((x, k) => (k === i ? { ...x, p1: 5 } : x)))).toContain("give-up");
  });

  it("passes a do command whose frame the firmware does not keep", () => {
    // ArduPilot reports frame 0 for a command with no place (mission_cmd_to_mavlink_int).
    expect(compareMissions(m, m.map((x) => (x.command === PAYLOAD_CMD.GRIPPER ? { ...x, frame: 0 } : x)))).toBeNull();
  });
});

describe("the releases an aircraft offers", () => {
  it("lists the gripper and the outputs a mission may move, and never a motor's", () => {
    const p = { ...aircraft(), SERVO10_FUNCTION: 0, SERVO11_FUNCTION: 58, SERVO12_FUNCTION: 22 };
    const o = releaseOptions(p, port);
    expect(o[0].release.kind).toBe("gripper");
    expect(o[0].label).toContain("AUX OUT 1");
    expect(o[0].problem).toBeNull();
    const servos = o.filter((x) => x.release.kind === "servo").map((x) => (x.release.kind === "servo" ? x.release.servo : 0));
    expect(servos).toContain(10);
    expect(servos).toContain(11);
    expect(servos).not.toContain(1); // motor
    expect(servos).not.toContain(9); // the gripper's own
    expect(servos).not.toContain(12); // a sprayer
    expect(o.find((x) => x.release.kind === "servo" && x.release.servo === 11)!.label).toContain("channel 8");
  });

  it("says why the gripper would not move", () => {
    expect(releaseOptions({ ...defaultParams(AF) }, port)[0].problem).toContain("Gripper Released");
    expect(releaseOptions(aircraft(), port, ["GRIP_ENABLE"])[0].problem).toContain("Restart");
    expect(releaseOptions(aircraft({ SERVO9_FUNCTION: 0 }), port)[0].problem).toContain("No output");
  });
});

describe("the checks before a delivery flies", () => {
  const base = { aircraftSource: "test", restartPending: [] as string[], port, airframe: LIFTER, real: false };
  const one = (d: Delivery, extra: Partial<Parameters<typeof checkDeliveries>[0]> = {}, ground: number | null = 0) => checkDeliveries({ ...base, deliveries: [{ wp: 2, delivery: d, cruise: 40, ground }], aircraft: aircraft(), ...extra });
  const bad = (f: ReturnType<typeof checkDeliveries>) => f.filter((x) => x.sev === "bad").map((x) => x.text);
  const warn = (f: ReturnType<typeof checkDeliveries>) => f.filter((x) => x.sev === "warn").map((x) => x.text);

  it("passes a sound drop and a sound lowering with nothing to fix", () => {
    expect(bad(one(drop()))).toEqual([]);
    expect(warn(one(drop()))).toEqual([]);
    expect(bad(one(lower({ kg: 1 })))).toEqual([]);
  });

  it("says nothing is checked with no aircraft's settings", () => {
    expect(warn(one(drop(), { aircraft: null })).join(" ")).toContain("No aircraft's settings");
  });

  it("stops a gripper that is off, or waiting for a restart", () => {
    expect(bad(one(drop(), { aircraft: { ...defaultParams(AF) } })).join(" ")).toContain("GRIP_ENABLE is 0");
    expect(bad(one(drop(), { restartPending: ["SERVO9_FUNCTION"] })).join(" ")).toContain("Restart");
  });

  it("stops a servo release on an output the firmware will not move", () => {
    expect(bad(one(drop({ release: { ...SERVO10, servo: 1 } }))).join(" ")).toContain("already in use");
    expect(bad(one(drop({ release: { ...SERVO10, open: 1500, closed: 1500 } }))).join(" ")).toContain("same pulse");
    expect(warn(one(drop({ release: SERVO10 }), { aircraft: aircraft({ SERVO10_FUNCTION: 57 }) })).join(" ")).toContain("transmitter channel");
  });

  it("stops one release used for two payloads", () => {
    const f = checkDeliveries({ ...base, aircraft: aircraft(), deliveries: [2, 4].map((wp) => ({ wp, delivery: drop(), cruise: 40, ground: 0 })) });
    expect(bad(f).join(" ")).toContain("waypoints 2 and 4");
  });

  it("warns when a failsafe would drop the payload wherever it is", () => {
    expect(warn(one(drop(), { aircraft: aircraft({ FS_OPTIONS: 16 | 32 }) })).join(" ")).toContain("Release Gripper");
  });

  it("stops a drop with no room under the payload, and warns below the elevation data's accuracy", () => {
    expect(bad(one(drop({ heightM: 1.2 }))).length).toBe(1);
    expect(warn(one(drop({ heightM: 10 }), { real: true })).join(" ")).toContain("10 m");
    expect(warn(one(drop({ heightM: 20 }), { real: true }))).toEqual([]);
  });

  it("stops a delivery that goes below the fence's floor, which ArduCopter holds in a delivery as anywhere", () => {
    // ModeAuto::is_landing is false while placing a payload, so the floor is not lifted for it (fence.cpp).
    expect(bad(one(drop({ heightM: 8 }), { fenceFloor: 10 })).join(" ")).toContain("FENCE_ALT_MIN");
    expect(bad(one(lower({ kg: 1 }), { fenceFloor: 5 })).join(" ")).toContain("floor");
    expect(bad(one(drop({ heightM: 12 }), { fenceFloor: 10 }))).toEqual([]);
    expect(bad(one(drop({ heightM: 8 }), { fenceFloor: null }))).toEqual([]);
  });

  it("stops a delivery where the ground is not known", () => {
    expect(bad(one(drop(), {}, null)).join(" ")).toContain("not known");
  });

  it("knows a payload too light for ArduCopter to feel touching down", () => {
    // 0.3 kg under a 3.6 kg aircraft is 8% of the weight; the thrust must fall by more than 10% (PLDP_THRESH 0.9).
    expect(bad(one(lower({ kg: 0.3 }))).join(" ")).toContain("cannot be felt");
    // 0.45 kg is 11%: felt, but only just.
    expect(warn(one(lower({ kg: 0.45 }))).join(" ")).toContain("close to");
    expect(bad(one(lower({ kg: 0.45 })))).toEqual([]);
  });

  it("stops lowering with a servo, or with a rangefinder it does not have, or starting too low, or giving up too soon", () => {
    expect(bad(one(lower({ kg: 1, release: SERVO10 }))).join(" ")).toContain("only a gripper");
    expect(bad(one(lower({ kg: 1 }), { aircraft: aircraft({ PLDP_RNG_MAX: 3 }) })).join(" ")).toContain("rangefinder");
    expect(bad(one(lower({ kg: 1, heightM: 2 }))).join(" ")).toContain("two seconds");
    expect(bad(one(lower({ kg: 1, heightM: 20, giveUpM: 10 }))).join(" ")).toContain("climb back with the payload");
  });

  it("stops a payload the aircraft cannot lift safely", () => {
    const f = checkDeliveries({ ...base, airframe: AF, aircraft: aircraft(), deliveries: [{ wp: 1, delivery: drop({ kg: 1.2 }), cruise: 30, ground: 0 }] });
    expect(bad(f).join(" ")).toContain("thrust to weight");
  });
});

describe("time and battery", () => {
  it("adds the way down, the waits and the way back up", () => {
    const p = defaultParams(AF);
    // 30 m down at 1.5 m/s, 3 + 3 s, 30 m up at 2.5 m/s, and the stops.
    expect(deliverySeconds(drop({ heightM: 10 }), 40, 0, p)).toBeCloseTo(1 + 20 + 3 + 3 + 12 + 1 + 3, 0);
    const pts = [pt(200, 0, 40)];
    const profile = routeProfile(pts, 20, "rtl", 15, () => 0);
    const plain = flightSeconds({ points: pts, takeoffAlt: 20, ending: "rtl", params: p, profile });
    const laden = flightSeconds({ points: [pt(200, 0, 40, lower({ kg: 0.8 }))], takeoffAlt: 20, ending: "rtl", params: p, profile });
    // 25 m lowered at 0.5 m/s is most of a minute.
    expect(laden - plain).toBeGreaterThan(60);
  });

  it("counts the payload's weight against the hover time", () => {
    const pts = [pt(2000, 0, 40, drop({ kg: 1 }))];
    const profile = routeProfile(pts, 20, "rtl", 15, () => 0);
    const base = { takeoffAlt: 20, ending: "rtl" as const, params: defaultParams(AF), airframe: AF, profile, groundKnown: true, real: false, groundReach: null };
    const said = checkPlan({ ...base, points: pts }).map((x) => x.text).join(" ");
    expect(said).toContain("carrying 1.0 kg");
  });
});

describe("saved deliveries", () => {
  it("are put right if damaged, and dropped if not deliveries at all", () => {
    expect(soundDelivery({ method: "drop", release: { kind: "servo", servo: 99, open: "x" }, heightM: -5, kg: 1000 })).toMatchObject({ release: { kind: "servo", servo: 32, open: 1900 }, heightM: 1, kg: 50 });
    expect(soundDelivery({ method: "fling" })).toBeUndefined();
    expect(soundDelivery(null)).toBeUndefined();
  });

  it("switching to lowering takes the gripper and a starting height that can feel the ground", () => {
    const s = switchMethod(drop({ release: SERVO10, heightM: 5 }), "lower");
    expect(s.release).toEqual(GRIPPER);
    expect(s.heightM).toBeGreaterThanOrEqual(15);
    expect(s.giveUpM).toBeGreaterThan(s.heightM);
  });
});

/* ------------------------------------------------------------------ */
/* Flown by the virtual aircraft                                       */
/* ------------------------------------------------------------------ */

describe("the virtual aircraft flying deliveries", () => {
  const fly = (points: PlanPoint[], params: Record<string, number>, extra: Partial<Scenario> = {}, af = AF) => {
    const m = planToMission(HOME, 20, points, "rtl");
    const ds = points.filter((p) => p.delivery).map((p) => p.delivery!);
    return predict(af, { ...defaultParams(af), ...params }, HOME, m, {
      windSpeed: 0,
      windFromDeg: 0,
      gust: 0,
      soc: 1,
      faults: [],
      payloads: ds.map((d) => ({ kg: d.kg, hangM: d.hangM, release: releaseKey(d.release), open: d.release.kind === "servo" ? d.release.open : undefined })),
      deliveryNames: points.flatMap((p, i) => (p.delivery ? [`Waypoint ${i + 1}`] : [])),
      ...extra,
    });
  };

  it("drops on the point, at the height asked, holding still, and flies home lighter", () => {
    const r = fly([pt(120, 40, 30, drop({ heightM: 8 })), pt(60, -80, 30)], GRIP_SET);
    expect(r.verdict).toBe("completed");
    expect(r.deliveries).toHaveLength(1);
    const d = r.deliveries[0];
    expect(d.outcome).toBe("released");
    expect(d.kg).toBeCloseTo(0.4);
    expect(Math.hypot(d.n - 120, d.e - 40)).toBeLessThan(1);
    expect(Math.abs(d.agl - 8)).toBeLessThan(1);
    expect(d.speed).toBeLessThan(0.3);
    // It let go after holding still, and only then moved on.
    const released = r.events.find((e) => e.kind === "gripper-release")!;
    expect(released.text).toBe("Gripper Released");
    expect(r.findings.find((f) => f.text.startsWith("Waypoint 1"))!.sev).toBe("ok");
  });

  it("closes the gripper on the ground before taking off", () => {
    const r = fly([pt(120, 40, 30, drop())], GRIP_SET);
    const grab = r.events.find((e) => e.kind === "gripper-grab")!;
    const takeoff = r.events.find((e) => e.kind === "takeoff")!;
    expect(grab.t).toBeLessThanOrEqual(takeoff.t);
  });

  it("lowers a heavy enough payload until it feels it touch, lets go there, and climbs back", () => {
    const r = fly([pt(120, 40, 40, lower({ kg: 0.6, hangM: 1, heightM: 15 }))], GRIP_SET);
    expect(r.verdict).toBe("completed");
    const d = r.deliveries[0];
    expect(d.outcome).toBe("released");
    expect(d.kind).toBe("lower");
    // The payload hangs a metre below: it touched when the aircraft was a metre up, and the half second of checking takes it a little lower.
    expect(d.agl).toBeGreaterThan(0.3);
    expect(d.agl).toBeLessThan(1.2);
    expect(r.events.some((e) => e.kind === "place-touchdown" && e.text.startsWith("PayloadPlace: payload release thrust threshold"))).toBe(true);
  });

  it("does not feel a payload too light to matter: it comes down until it lands itself, then lets go", () => {
    const r = fly([pt(120, 40, 40, lower({ kg: 0.1, hangM: 1, heightM: 15, giveUpM: 25 }))], GRIP_SET);
    expect(r.deliveries[0].outcome).toBe("landed");
    expect(r.findings.find((f) => f.text.startsWith("Waypoint 1"))!.sev).toBe("warn");
  });

  it("gives up and keeps the payload when the ground is further down than it was allowed to go", () => {
    const r = fly([pt(120, 40, 40, lower({ kg: 0.6, hangM: 1, heightM: 15, giveUpM: 6 }))], GRIP_SET);
    expect(r.deliveries[0].outcome).toBe("gave-up");
    expect(r.events.some((e) => e.text === "PayloadPlace: Reached maximum descent")).toBe(true);
    expect(r.findings.some((f) => f.sev === "bad" && f.text.includes("still holding"))).toBe(true);
  });

  it("abandons lowering at touchdown when PLDP_RNG_MAX asks for a rangefinder it does not have", () => {
    const r = fly([pt(120, 40, 40, lower({ kg: 0.6, hangM: 1 }))], { ...GRIP_SET, PLDP_RNG_MAX: 2 });
    expect(r.deliveries[0].outcome).toBe("aborted");
  });

  it("lets nothing go when the aircraft's gripper is not set up, though it reports “Gripper Released”", () => {
    const r = fly([pt(120, 40, 30, drop())], {});
    expect(r.deliveries[0].outcome).toBe("nothing");
    expect(r.events.some((e) => e.text === "Gripper Released")).toBe(true);
    expect(r.findings.some((f) => f.sev === "bad" && f.text.includes("not set up"))).toBe(true);
  });

  it("with no aircraft's settings, takes the release as working", () => {
    expect(fly([pt(120, 40, 30, drop())], {}, { assumeRelease: true }).deliveries[0].outcome).toBe("released");
  });

  it("drops from a free servo output, and is refused on a motor's", () => {
    expect(fly([pt(120, 40, 30, drop({ release: SERVO10 }))], {}).deliveries[0].outcome).toBe("released");
    const r = fly([pt(120, 40, 30, drop({ release: { ...SERVO10, servo: 2 } }))], {});
    expect(r.deliveries[0].outcome).toBe("nothing");
    expect(r.events.some((e) => e.text === "ServoRelayEvent: Channel 2 is already in use")).toBe(true);
  });

  it("works harder carrying a payload than without", () => {
    const route = (d?: Delivery) => [pt(300, 0, 30, d)];
    const empty = fly(route(), GRIP_SET, {}, LIFTER);
    const laden = fly(route(drop({ kg: 1.5 })), GRIP_SET, {}, LIFTER);
    expect(laden.stats.usedMah).toBeGreaterThan(empty.stats.usedMah);
  });

  it("says when a delivery is never reached", () => {
    const r = fly([pt(120, 40, 30, drop())], GRIP_SET, { faults: [{ kind: "gps", at: { time: 15 } }] });
    expect(r.findings.some((f) => f.text.includes("never reached"))).toBe(true);
  });
});

describe("the do commands on the link", () => {
  it("only navigation commands are reported reached, as ArduPilot reports them", async () => {
    const { VirtualVehicle } = await import("../../sim/vehicle");
    const v = new VirtualVehicle({ airframe: AF, home: HOME, params: { ...defaultParams(AF), ...GRIP_SET } });
    const sent: number[] = [];
    const orig = (v as unknown as { send: (n: string, f: Record<string, unknown>) => void }).send.bind(v);
    (v as unknown as { send: (n: string, f: Record<string, unknown>) => void }).send = (n, f) => {
      if (n === "MISSION_ITEM_REACHED") sent.push(f.seq as number);
      orig(n, f);
    };
    v.setScriptedGcs(true);
    v.ap.mission = planToMission(HOME, 10, [pt(40, 0, 15, drop({ heightM: 5 }))], "rtl");
    v.ap.setMode(4, v.inputs());
    v.ap.arm(v.inputs());
    v.ap.setMode(3, v.inputs());
    v.ap.startMission();
    for (let t = 0; t < 120 && v.ap.armed; t += 0.5) v.advance(0.5, 0.5, false);
    const doSeqs = v.ap.mission.filter((x) => x.command === PAYLOAD_CMD.GRIPPER).map((x) => x.seq);
    expect(sent.length).toBeGreaterThan(3);
    for (const s of doSeqs) expect(sent).not.toContain(s);
  });
});
