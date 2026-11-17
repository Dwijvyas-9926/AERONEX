import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleep, tcpSerialPort, until } from "./harness";

/*
  Payload delivery against real ArduCopter.

  The planner's deliveries are sent to ArduPilot's own simulator build (the
  flight code of a Pixhawk) through the app's real serial path and flown,
  with ArduPilot's simulated gripper holding a 1 kg load on a 2 m line
  (SIM_GRPS_*: the load is attached when the jaws close on the ground, falls
  when they open, and rests on the ground once the aircraft is lower than its
  line). What is checked is what the firmware reports doing, not the app's
  model of it:

  - the release is set up the Servo Outputs page's way, and the planner finds
    nothing wrong with it; before that, with the gripper off, the firmware
    still says "Gripper Released" and nothing moves, which is why the planner
    checks the settings rather than that message;
  - the mission is accepted and reads back identical, and reads back into
    the same plan, deliveries and all;
  - a drop: the gripper is closed on the ground before take-off, opens over
    the point, at the height asked, with the aircraft holding still, which
    then stays put while the payload falls clear before it moves on;
  - lowering: ArduCopter's payload place feels the load touch down, opens
    the gripper there, and climbs back;
  - lowering that may not go deep enough gives up and keeps the load;
  - a drop from a plain servo output sends it the pulse asked for, there;
  - the app's prediction of each flight agrees with the firmware's.

      SITL_BIN=…/arducopter SITL_DEFAULTS=…/copter.parm npx vitest run sitl/delivery

  Skipped without SITL_BIN.
*/
const BIN = process.env.SITL_BIN;
const DEFAULTS = process.env.SITL_DEFAULTS;
const SPEEDUP = Number(process.env.SITL_SPEEDUP ?? 4);
const REPORT = process.env.SITL_REPORT;
const INSTANCE = Number(process.env.SITL_INSTANCE ?? 5);
const PORT = 5760 + 10 * INSTANCE;
const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
/** The simulated gripper's own positions (SIM_Gripper_Servo works only with these). */
const GRAB = 2000;
const RELEASE = 1000;
const GRIP_OUT = 9;
const SERVO_OUT = 10;

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }));
Object.defineProperty(globalThis.navigator, "serial", { value: { addEventListener: () => undefined, getPorts: async () => [] }, configurable: true });

const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};

describe.skipIf(!BIN)("payload delivery against real ArduCopter (SITL)", () => {
  let proc: ChildProcess;
  let out = "";
  const dir = mkdtempSync(path.join(tmpdir(), "aeronex-delivery-"));
  let app: {
    linkManager: (typeof import("../src/services/link/linkManager"))["linkManager"];
    commandLink: (typeof import("../src/services/link/commandLink"))["commandLink"];
    useLink: (typeof import("../src/state/linkStore"))["useLink"];
    useParams: (typeof import("../src/state/paramStore"))["useParams"];
    sim: typeof import("../src/state/simStore");
    payload: typeof import("../src/mission/payload");
    actions: typeof import("../src/servo/actions");
    geo: typeof import("../src/geo/geo");
    names: typeof import("../src/mavlink/paramNames");
    predict: typeof import("../src/sim/predict");
    params: typeof import("../src/sim/params");
    fw: typeof import("../src/sim/firmwareParams");
    armHome: typeof import("../src/mission/armHome");
  };
  const tele = () => app.useLink.getState().telemetry;
  const armed = () => !!app.useLink.getState().vehicle?.armed;
  const p = () => app.useParams.getState().values;
  const texts: { t: number; text: string }[] = [];

  async function start(wipe: boolean) {
    const args = ["--model", "quad", "--speedup", String(SPEEDUP), "--home", `${HOME.lat},${HOME.lon},${HOME.altMsl},0`, `-I${INSTANCE}`];
    if (wipe) args.push("--wipe");
    if (DEFAULTS) args.push("--defaults", DEFAULTS);
    out = "";
    proc = spawn(BIN!, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout!.on("data", (b) => (out += String(b)));
    proc.stderr!.on("data", (b) => (out += String(b)));
    await until("the simulator to listen", () => new RegExp(`bind port ${PORT}|Waiting for connection`).test(out), 30000);
    const { serial } = tcpSerialPort("127.0.0.1", PORT);
    await app.linkManager.connect(serial);
    await until("a heartbeat from ArduCopter", () => app.useLink.getState().status === "connected", 30000);
    await app.commandLink.requestAllParams();
    await until("the parameter download", () => {
      const s = app.useParams.getState();
      return s.count !== null && s.received >= s.count;
    }, 120000);
    await until("servo outputs to be reported", () => tele().servo !== undefined, 20000);
    await until("a 3D GPS fix", () => (tele().gps?.value.fixType ?? 0) >= 3, 120000);
  }

  async function restart() {
    await app.linkManager.disconnect("Restarting the simulator.");
    proc.kill("SIGKILL");
    await sleep(1000);
    await start(false);
  }

  /** Plan a mission from points, send it, and check it reads back identical. */
  async function send(points: import("../src/state/simStore").PlanPoint[]) {
    const mission = app.sim.planToMission(HOME, 10, points, "rtl");
    await app.commandLink.uploadMission(mission);
    expect(await app.commandLink.verifyMission(mission)).toBeNull();
    return mission;
  }

  interface Release {
    t: number;
    n: number;
    e: number;
    alt: number;
    speed: number;
  }

  /**
   * Fly the mission on the aircraft, watching where it goes and the moment an
   * output reaches a pulse after take-off.
   */
  async function fly(watch: { out: number; pwm: number }) {
    const track: { t: number; n: number; e: number; alt: number }[] = [];
    let release: Release | null = null;
    let atTakeoff: number | undefined;
    const from = texts.length;
    const stop = app.useLink.subscribe((s) => {
      const q = s.telemetry.position?.value;
      if (!q) return;
      const l = app.geo.toLocal(HOME, q.lat, q.lon);
      const t = Date.now();
      track.push({ t, n: l.n, e: l.e, alt: q.relAlt });
      const pwm = s.telemetry.servo?.value.pwm[watch.out - 1];
      if (atTakeoff === undefined && q.relAlt > 1) atTakeoff = pwm;
      if (!release && q.relAlt > 1 && pwm === watch.pwm) release = { t, n: l.n, e: l.e, alt: q.relAlt, speed: s.telemetry.hud?.value.groundspeed ?? NaN };
    });
    await app.commandLink.setMode(4);
    let result = -1;
    for (let i = 0; i < 90 && result !== 0; i++) {
      result = await app.commandLink.arm(true).catch(() => -1);
      if (result !== 0) await sleep(1000);
    }
    expect(result, `ArduCopter would not arm: ${texts.slice(-5).map((x) => x.text).join(" | ")}`).toBe(0);
    const t0 = Date.now();
    expect(await app.commandLink.setMode(3)).toBe(0);
    expect(await app.commandLink.startMission()).toBe(0);
    await until("the mission to fly and land", () => !armed(), 600000, 200);
    stop();
    const said = texts.slice(from).map((x) => ({ s: ((x.t - t0) / 1000) * SPEEDUP, text: x.text }));
    return { track, release: release as Release | null, atTakeoff, said, simSeconds: ((Date.now() - t0) / 1000) * SPEEDUP, last: track[track.length - 1] };
  }

  /** Where the aircraft was over a stretch of simulated seconds after `t`. */
  const after = (track: { t: number; n: number; e: number; alt: number }[], t: number, simS: number) => track.filter((k) => k.t >= t && k.t <= t + (simS * 1000) / SPEEDUP);

  /** The app's own prediction of the same mission, on this aircraft's settings, for a 3 kg quad. */
  function predicted(mission: import("../src/sim/autopilot").MissionItem[], payloads: import("../src/sim/vehicle").Payload[]) {
    // SITL's quad: 3 kg, about 2:1 thrust to weight.
    const af = { name: "SITL quad", massKg: 3, diagonalM: 0.35, motorMaxThrustN: 20, propDiaM: 0.25, cells: 3, capacityMah: 5000 };
    return app.predict.predict(af, { ...app.params.defaultParams(af), ...app.fw.modelledParams(p()) }, HOME, mission, { windSpeed: 0, windFromDeg: 0, gust: 0, soc: 1, faults: [], payloads, deliveryNames: ["the delivery"] });
  }

  beforeAll(async () => {
    app = {
      linkManager: (await import("../src/services/link/linkManager")).linkManager,
      commandLink: (await import("../src/services/link/commandLink")).commandLink,
      useLink: (await import("../src/state/linkStore")).useLink,
      useParams: (await import("../src/state/paramStore")).useParams,
      sim: await import("../src/state/simStore"),
      payload: await import("../src/mission/payload"),
      actions: await import("../src/servo/actions"),
      geo: await import("../src/geo/geo"),
      names: await import("../src/mavlink/paramNames"),
      predict: await import("../src/sim/predict"),
      params: await import("../src/sim/params"),
      fw: await import("../src/sim/firmwareParams"),
      armHome: await import("../src/mission/armHome"),
    };
    const seenIds = new Set<number>();
    app.useLink.subscribe((s) => {
      for (const e of s.events) {
        if (seenIds.has(e.id)) continue;
        seenIds.add(e.id);
        texts.push({ t: e.at, text: e.text.replace(/^(Info|Warning|Notice|Error|Critical):\s*/i, "") });
      }
    });
    await start(true);
    // Let Auto take off on a command, as the simulator page does.
    await app.commandLink.setParam("AUTO_OPTIONS", 3);
    say(`Linked to ${app.useLink.getState().telemetry.autopilot?.value.version ?? "ArduCopter"}.`);
  }, 300000);

  afterAll(async () => {
    try {
      await app?.linkManager.disconnect("Test finished.");
    } catch {
      /* closing */
    }
    proc?.kill("SIGKILL");
    if (REPORT) writeFileSync(REPORT, report.join("\n") + "\n");
  });

  const port = (n: number) => (n <= 8 ? `MAIN OUT ${n}` : `AUX OUT ${n - 8}`);
  const gripperDrop = () => ({ ...app.payload.newDelivery("drop", { kind: "gripper" }, 1), heightM: 8, settleS: 3, afterS: 4, hangM: 2 });

  it("with the gripper off: the planner stops it, and the firmware says “Gripper Released” as nothing moves", async () => {
    const values = app.names.withOlderNames(p());
    const why = app.payload.gripperProblem(values, port);
    say(`Planner, gripper off: ${why}`);
    expect(why).toContain("GRIP_ENABLE is 0");
    const points = [{ id: "a", n: 40, e: 0, alt: 15, holdS: 0, delivery: gripperDrop() }];
    await send(points);
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    const said = f.said.map((x) => x.text);
    say(`Flown with the gripper off: the firmware said ${said.filter((t) => /Gripper/.test(t)).map((t) => `“${t}”`).join(", ")}; output ${GRIP_OUT} ${f.release ? "moved" : "never moved"}.`);
    expect(said).toContain("Gripper Released");
    expect(f.release).toBeNull();
  }, 600000);

  it("sets the gripper up the Servo Outputs page's way, and the planner then finds nothing wrong", async () => {
    await app.actions.setupGripper(GRIP_OUT, { grab: GRAB, release: RELEASE, neutral: 1500 });
    for (const [k, v] of Object.entries({ SIM_GRPS_ENABLE: 1, SIM_GRPS_PIN: GRIP_OUT, SIM_GRPS_GRAB: GRAB, SIM_GRPS_RELEASE: RELEASE })) await app.commandLink.setParam(k, v);
    await restart();
    const values = app.names.withOlderNames(p());
    expect(values).toMatchObject({ GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: GRAB, GRIP_RELEASE: RELEASE, [`SERVO${GRIP_OUT}_FUNCTION`]: 28 });
    const opts = app.payload.releaseOptions(values, port);
    say(`Releases offered: ${opts.map((o) => `${o.label}${o.problem ? ` (${o.problem})` : ""}`).join("; ")}`);
    expect(opts[0]).toMatchObject({ release: { kind: "gripper" }, problem: null });
    expect(opts.some((o) => o.release.kind === "servo" && o.release.servo === SERVO_OUT)).toBe(true);
    const af = { name: "SITL quad", massKg: 3, diagonalM: 0.35, motorMaxThrustN: 20, propDiaM: 0.25, cells: 3, capacityMah: 5000 };
    const findings = app.payload.checkDeliveries({ deliveries: [{ wp: 2, delivery: gripperDrop(), cruise: 20, ground: 0 }], aircraft: values, aircraftSource: "SITL", restartPending: [], port, airframe: af, real: false });
    say(`Plan check of a 1 kg gripper drop on this aircraft: ${findings.length ? findings.map((f) => `${f.sev}: ${f.text}`).join(" | ") : "nothing to say"}`);
    expect(findings.filter((f) => f.sev !== "note")).toEqual([]);
  }, 300000);

  it("drops over the point at the height asked, holding still, and stays put while it falls clear", async () => {
    const points = [
      { id: "a", n: 50, e: 20, alt: 20, holdS: 0 },
      { id: "b", n: 90, e: -30, alt: 20, holdS: 0, delivery: gripperDrop() },
    ];
    const mission = await send(points);
    // Read back from the aircraft, it is the same plan.
    const back = app.sim.missionToPlan(await app.commandLink.downloadMission(), HOME);
    expect(back.points[1].delivery).toMatchObject({ method: "drop", release: { kind: "gripper" }, heightM: 8, settleS: 3, afterS: 4 });
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    expect(f.atTakeoff, "the gripper was closed before take-off").toBe(GRAB);
    expect(f.release, "the gripper opened").not.toBeNull();
    const r = f.release!;
    const miss = Math.hypot(r.n - 90, r.e + 30);
    say(`Drop: closed at take-off (${f.atTakeoff} µs); opened ${miss.toFixed(2)} m from the point at ${r.alt.toFixed(2)} m (asked 8 m), ground speed ${r.speed.toFixed(2)} m/s. The firmware said: ${f.said.filter((x) => /Gripper|Reached/.test(x.text)).map((x) => `${x.s.toFixed(0)} s “${x.text}”`).join(", ")}.`);
    expect(miss).toBeLessThan(1.5);
    expect(Math.abs(r.alt - 8)).toBeLessThan(1);
    expect(r.speed).toBeLessThan(0.5);
    // It stays put while the payload falls clear (afterS 4 s): checked over 3 s.
    const stay = after(f.track, r.t, 3);
    const drift = Math.max(...stay.map((k) => Math.hypot(k.n - r.n, k.e - r.e)));
    say(`  in the 3 s after the release it moved ${drift.toFixed(2)} m.`);
    expect(drift).toBeLessThan(1);
    // The gripper reports reaching its release position once the servo has moved (AP_Gripper_Servo::update).
    expect(f.said.some((x) => x.text === "Gripper load released")).toBe(true);
    expect(Math.hypot(f.last.n, f.last.e)).toBeLessThan(3);
    const g = predicted(mission, [{ kg: 1, hangM: 2, release: "gripper" }]);
    const gd = g.deliveries[0];
    say(`  the app predicted "${g.verdict}": let go ${Math.hypot(gd.n - 90, gd.e + 30).toFixed(2)} m from the point at ${gd.agl.toFixed(2)} m; ${Math.round(g.stats.durationS)} s against the firmware's ${Math.round(f.simSeconds)} s.`);
    expect(gd.outcome).toBe("released");
    expect(Math.abs(gd.agl - r.alt)).toBeLessThan(1);
  }, 600000);

  it("lowers the load until it feels it touch the ground, lets go there, and climbs back", async () => {
    const d = { ...app.payload.newDelivery("lower", { kind: "gripper" }, 1), heightM: 10, giveUpM: 20, hangM: 2 };
    const mission = await send([{ id: "a", n: 70, e: 40, alt: 20, holdS: 0, delivery: d }]);
    const back = app.sim.missionToPlan(await app.commandLink.downloadMission(), HOME);
    expect(back.points[0].delivery).toMatchObject({ method: "lower", heightM: 10, giveUpM: 20 });
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    const said = f.said.filter((x) => /PayloadPlace|Gripper/.test(x.text));
    expect(f.release, "the gripper opened").not.toBeNull();
    const r = f.release!;
    say(`Lower: opened ${Math.hypot(r.n - 70, r.e - 40).toFixed(2)} m from the point at ${r.alt.toFixed(2)} m up (the load hangs 2 m below). The firmware said: ${said.map((x) => `${x.s.toFixed(0)} s “${x.text}”`).join(", ")}.`);
    expect(said.some((x) => x.text.startsWith("PayloadPlace: payload release thrust threshold") || x.text === "PayloadPlace: landed")).toBe(true);
    expect(said.some((x) => x.text === "PayloadPlace: Releasing the gripper")).toBe(true);
    expect(Math.hypot(r.n - 70, r.e - 40)).toBeLessThan(1.5);
    // The load rests on the ground once the aircraft is lower than its 2 m line: it lets go about there.
    expect(r.alt).toBeGreaterThan(0.5);
    expect(r.alt).toBeLessThan(2.5);
    // And climbs back to where the lowering began before moving on.
    const back10 = f.track.some((k) => k.t > r.t && k.alt > 9);
    expect(back10).toBe(true);
    expect(f.said.some((x) => x.text === "Gripper load released")).toBe(true);
    const g = predicted(mission, [{ kg: 1, hangM: 2, release: "gripper" }]);
    say(`  the app predicted "${g.verdict}", ${g.deliveries[0]?.outcome} at ${g.deliveries[0]?.agl.toFixed(2)} m.`);
    expect(g.deliveries[0].outcome).toBe("released");
    expect(Math.abs(g.deliveries[0].agl - r.alt)).toBeLessThan(1.2);
  }, 600000);

  it("gives up and keeps the load when it may not descend far enough to reach the ground", async () => {
    const d = { ...app.payload.newDelivery("lower", { kind: "gripper" }, 1), heightM: 10, giveUpM: 4, hangM: 2 };
    // The planner says so before it flies.
    const af = { name: "SITL quad", massKg: 3, diagonalM: 0.35, motorMaxThrustN: 20, propDiaM: 0.25, cells: 3, capacityMah: 5000 };
    const findings = app.payload.checkDeliveries({ deliveries: [{ wp: 1, delivery: d, cruise: 20, ground: 0 }], aircraft: app.names.withOlderNames(p()), aircraftSource: "SITL", restartPending: [], port, airframe: af, real: false });
    expect(findings.some((x) => x.sev === "bad" && x.text.includes("climb back with the payload"))).toBe(true);
    const mission = await send([{ id: "a", n: 60, e: -40, alt: 20, holdS: 0, delivery: d }]);
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    const said = f.said.filter((x) => /PayloadPlace/.test(x.text)).map((x) => x.text);
    say(`Lower with too short a reach: the firmware said ${said.map((t) => `“${t}”`).join(", ")}; the gripper ${f.release ? "OPENED" : "stayed closed"}.`);
    expect(said).toContain("PayloadPlace: Reached maximum descent");
    expect(f.release).toBeNull();
    expect(f.said.some((x) => x.text === "Gripper load released")).toBe(false);
    expect(predicted(mission, [{ kg: 1, hangM: 2, release: "gripper" }]).deliveries[0].outcome).toBe("gave-up");
  }, 600000);

  it("drops from a plain servo output, sending it the pulse asked for over the point", async () => {
    const d = { ...app.payload.newDelivery("drop", { kind: "servo", servo: SERVO_OUT, open: 1850, closed: 1150 }, 0.5), heightM: 6, settleS: 2, afterS: 2 };
    const mission = await send([{ id: "a", n: -60, e: 50, alt: 18, holdS: 0, delivery: d }]);
    const f = await fly({ out: SERVO_OUT, pwm: 1850 });
    expect(f.atTakeoff, "closed before take-off").toBe(1150);
    expect(f.release).not.toBeNull();
    const r = f.release!;
    say(`Servo drop: output ${SERVO_OUT} at ${f.atTakeoff} µs at take-off, ${1850} µs ${Math.hypot(r.n + 60, r.e - 50).toFixed(2)} m from the point at ${r.alt.toFixed(2)} m (asked 6 m), ground speed ${r.speed.toFixed(2)} m/s.`);
    expect(Math.hypot(r.n + 60, r.e - 50)).toBeLessThan(1.5);
    expect(Math.abs(r.alt - 6)).toBeLessThan(1);
    expect(r.speed).toBeLessThan(0.5);
    expect(predicted(mission, [{ kg: 0.5, hangM: 0.3, release: `servo:${SERVO_OUT}`, open: 1850 }]).deliveries[0].outcome).toBe("released");
  }, 600000);
  it("lets go at the height asked with a one-second settle, as the app predicts", async () => {
    const d = { ...gripperDrop(), heightM: 10, settleS: 1, afterS: 1 };
    const mission = await send([{ id: "a", n: 40, e: 60, alt: 20, holdS: 0, delivery: d }]);
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    expect(f.release, "the gripper opened").not.toBeNull();
    const r = f.release!;
    const g = predicted(mission, [{ kg: 1, hangM: 2, release: "gripper" }]).deliveries[0];
    say(`Drop, 1 s settle: opened at ${r.alt.toFixed(2)} m (asked 10 m), ${Math.hypot(r.n - 40, r.e - 60).toFixed(2)} m from the point, ground speed ${r.speed.toFixed(2)} m/s; the app predicted ${g.agl.toFixed(2)} m at ${g.speed.toFixed(2)} m/s.`);
    expect(Math.abs(r.alt - 10)).toBeLessThan(1);
    expect(r.speed).toBeLessThan(0.5);
    expect(Math.abs(g.agl - r.alt)).toBeLessThan(1);
  }, 600000);

  it("lowers from above the waypoint's height and lets go at touchdown, as the app predicts", async () => {
    const d = { ...app.payload.newDelivery("lower", { kind: "gripper" }, 1), heightM: 18, giveUpM: 30, hangM: 2 };
    const mission = await send([{ id: "a", n: -50, e: -40, alt: 12, holdS: 0, delivery: d }]);
    const f = await fly({ out: GRIP_OUT, pwm: RELEASE });
    const said = f.said.filter((x) => /PayloadPlace/.test(x.text)).map((x) => x.text);
    expect(f.release, "the gripper opened").not.toBeNull();
    const r = f.release!;
    const g = predicted(mission, [{ kg: 1, hangM: 2, release: "gripper" }]).deliveries[0];
    say(`Lower from above the waypoint (12 m, starts at 18 m): opened at ${r.alt.toFixed(2)} m; the firmware said ${said.map((t) => `“${t}”`).join(", ")}; the app predicted ${g.outcome} at ${g.agl.toFixed(2)} m.`);
    expect(f.track.some((k) => k.alt > 17)).toBe(true);
    expect(r.alt).toBeGreaterThan(0.5);
    expect(r.alt).toBeLessThan(2.5);
    expect(g.outcome).toBe("released");
    expect(Math.abs(g.agl - r.alt)).toBeLessThan(1.2);
  }, 600000);

  // Last: it moves the aircraft's home away from where the others start.
  it("sets home again where it arms, after landing at the last waypoint", async () => {
    const mission = app.sim.planToMission(HOME, 10, [{ id: "a", n: 60, e: 0, alt: 15, holdS: 0 }], "land");
    await app.commandLink.uploadMission(mission);
    await app.commandLink.requestMessageInterval(242, 1);
    await fly({ out: GRIP_OUT, pwm: -1 });
    const here = tele().position!.value;
    const away = app.geo.distanceM(here, HOME);
    const before = tele().home?.value;
    // The planner, with the aircraft sitting there, says what arming would do.
    const at = app.geo.toLocal(HOME, here.lat, here.lon);
    const f = app.armHome.armAwayFindings({ armed: false, at, groundThere: null, reported: here.relAlt, deliveries: [{ wp: 1, delivery: gripperDrop(), cruise: 20, ground: 0 }], putBack: "" });
    expect(f.length).toBe(1);
    await app.commandLink.setMode(4);
    let result = -1;
    for (let i = 0; i < 60 && result !== 0; i++) {
      result = await app.commandLink.arm(true).catch(() => -1);
      if (result !== 0) await sleep(1000);
    }
    expect(result).toBe(0);
    await until("home to move", () => {
      const h = tele().home?.value;
      return !!h && app.geo.distanceM(h, HOME) > away - 3;
    }, 30000, 200);
    const after = tele().home!.value;
    say(`Re-armed ${away.toFixed(1)} m from home after landing there: home was ${before ? `${app.geo.distanceM(before, HOME).toFixed(1)} m` : "unreported"} from the start and is now ${app.geo.distanceM(after, HOME).toFixed(1)} m (${app.geo.distanceM(after, here).toFixed(1)} m from the aircraft). The planner said: “${f[0].text}”`);
    expect(app.geo.distanceM(after, here)).toBeLessThan(3);
    expect(await app.commandLink.arm(false)).toBe(0);
  }, 600000);
});
