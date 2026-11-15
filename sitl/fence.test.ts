import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleep, tcpSerialPort, until } from "./harness";

/*
  The geofence against real ArduCopter.

  The fence AERONEX draws is sent to the firmware itself (ArduPilot's SITL
  build, the same flight code as a Pixhawk) through the app's real serial
  path, read back, armed against, and flown into. Each claim the Fence tab
  makes is put to the firmware here:

  - what it sends, ArduCopter accepts and holds exactly;
  - what ArduCopter refuses, the app reports with ArduCopter's own reason, and
    the fence the aircraft held before is still there;
  - where the app says home breaches the fence, ArduCopter refuses to arm, and
    where it says home is clear, ArduCopter arms;
  - where the app says the route enters a keep-out zone, the aircraft turns
    back there, and the app's own prediction of the flight agrees;
  - the return home is held under the ceiling, as the app says.

      SITL_BIN=…/arducopter SITL_DEFAULTS=…/copter.parm npx vitest run sitl/fence

  Skipped without SITL_BIN.
*/
const BIN = process.env.SITL_BIN;
const DEFAULTS = process.env.SITL_DEFAULTS;
const SPEEDUP = Number(process.env.SITL_SPEEDUP ?? 8);
const REPORT = process.env.SITL_REPORT;
// Instance 1 by default, so this can run beside the mission tests on instance 0.
const INSTANCE = Number(process.env.SITL_INSTANCE ?? 1);
const PORT = 5760 + 10 * INSTANCE;

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }));
Object.defineProperty(globalThis.navigator, "serial", { value: { addEventListener: () => undefined, getPorts: async () => [] }, configurable: true });

const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};

describe.skipIf(!BIN)("the geofence against real ArduCopter (SITL)", () => {
  let proc: ChildProcess;
  let app: {
    linkManager: (typeof import("../src/services/link/linkManager"))["linkManager"];
    commandLink: (typeof import("../src/services/link/commandLink"))["commandLink"];
    useLink: (typeof import("../src/state/linkStore"))["useLink"];
    useParams: (typeof import("../src/state/paramStore"))["useParams"];
    sim: typeof import("../src/state/simStore");
    home: typeof import("../src/services/link/homeFollow");
    geo: typeof import("../src/geo/geo");
    fence: typeof import("../src/geo/fence");
    check: typeof import("../src/geo/fenceCheck");
    fenceLink: typeof import("../src/services/link/fenceLink");
  };
  const texts: string[] = [];
  const tele = () => app.useLink.getState().telemetry;
  const armed = () => !!app.useLink.getState().vehicle?.armed;
  const home = () => app.sim.useSim.getState().home;
  const at = (n: number, e: number) => app.fence.snap(app.geo.toGlobal(home(), n, e));
  const box = (role: "in" | "out", cn: number, ce: number, half: number, id: string) => ({
    id, shape: "polygon" as const, role, points: [at(cn - half, ce - half), at(cn - half, ce + half), at(cn + half, ce + half), at(cn + half, ce - half)],
  });
  const ring = (role: "in" | "out", corners: number, cn: number, ce: number, r: number, id: string) => ({
    id, shape: "polygon" as const, role, points: Array.from({ length: corners }, (_, k) => at(cn + r * Math.cos((2 * Math.PI * k) / corners), ce + r * Math.sin((2 * Math.PI * k) / corners))),
  });
  const limits = (over: Record<string, number> = {}) => ({ ...app.fence.DEFAULT_LIMITS, ...over }) as import("../src/geo/fence").FenceLimits;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aeronex-fence-"));
    const args = ["--model", "quad", "--speedup", String(SPEEDUP), "--home", `${HOME.lat},${HOME.lon},${HOME.altMsl},0`, `-I${INSTANCE}`, "--wipe"];
    if (DEFAULTS) args.push("--defaults", DEFAULTS);
    proc = spawn(BIN!, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout!.on("data", (b) => (out += String(b)));
    proc.stderr!.on("data", (b) => (out += String(b)));
    await until("the simulator to listen", () => new RegExp(`bind port ${PORT}|Waiting for connection`).test(out), 30000);
    app = {
      linkManager: (await import("../src/services/link/linkManager")).linkManager,
      commandLink: (await import("../src/services/link/commandLink")).commandLink,
      useLink: (await import("../src/state/linkStore")).useLink,
      useParams: (await import("../src/state/paramStore")).useParams,
      sim: await import("../src/state/simStore"),
      home: await import("../src/services/link/homeFollow"),
      geo: await import("../src/geo/geo"),
      fence: await import("../src/geo/fence"),
      check: await import("../src/geo/fenceCheck"),
      fenceLink: await import("../src/services/link/fenceLink"),
    };
    app.sim.useSim.setState({ home: { lat: 22.3, lon: 73.2, altMsl: 35 }, points: [], takeoffAlt: 10, ending: "rtl" });
    app.home.startHomeFollow();
    app.useLink.subscribe((s) => {
      for (const e of s.events) if (!texts.includes(e.text)) texts.push(e.text);
    });
    const { serial } = tcpSerialPort("127.0.0.1", PORT);
    await app.linkManager.connect(serial);
    await until("a heartbeat from ArduCopter", () => app.useLink.getState().status === "connected", 30000);
    await app.commandLink.requestAllParams();
    await until("the parameter download", () => {
      const p = app.useParams.getState();
      return p.count !== null && p.received >= p.count;
    }, 120000);
    await until("a 3D GPS fix", () => (tele().gps?.value.fixType ?? 0) >= 3, 120000);
    await until("home to follow the aircraft", () => app.home.useHomeSource.getState().source === "aircraft", 60000);
    await sleep(1500);
    say(`Linked. Fence settings on the aircraft: ${app.fence.LIMIT_NAMES.map((k) => `${k}=${app.useParams.getState().values[k]}`).join(" ")}`);
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

  const good = () => [box("in", 0, 0, 400, "keep-in"), { id: "pole", shape: "circle" as const, role: "out" as const, centre: at(150, -80), radiusM: 25.5 }, ring("out", 5, -120, 100, 40, "pond")];
  const goodLimits = () => limits({ FENCE_ENABLE: 1, FENCE_TYPE: 7, FENCE_ALT_MAX: 60, FENCE_ACTION: 1, FENCE_MARGIN: 2, FENCE_RADIUS: 600 });

  it("accepts the fence AERONEX sends, and holds exactly it", async () => {
    const zones = good();
    const steps: string[] = [];
    const sent = await app.fenceLink.sendFence({ zones, limits: goodLimits() }, (s) => steps.push(s));
    say(`Sent ${zones.length} zones (${app.fence.zonesToWire(zones).length} items); steps: ${steps.join(" → ")}`);
    const raw = await app.commandLink.downloadFence();
    for (const it of raw.slice(0, 3)) say(`  holds item ${it.seq}: cmd ${it.command} frame ${it.frame} p1 ${it.p1} x ${it.x} y ${it.y}`);
    const back = await app.fenceLink.readFence();
    expect(app.fence.sameZones(back.zones, zones)).toBe(true);
    expect(app.fence.limitsDiffer(back.limits, goodLimits())).toEqual([]);
    expect(app.fence.sameZones(sent.zones, zones)).toBe(true);
    // The app's check finds nothing ArduPilot would refuse in it.
    const found = app.check.checkFence({ zones, limits: goodLimits(), home: home() });
    say(`  the app's check: ${found.map((f) => `[${f.sev}] ${f.text}`).join(" ") || "nothing"}`);
    expect(found.filter((f) => f.sev === "bad")).toEqual([]);
    expect(Number(app.useParams.getState().values.FENCE_TOTAL)).toBeGreaterThan(0);
  }, 60000);

  it("refuses what it cannot store, says why, and keeps the fence it had", async () => {
    // Seven areas of ten corners: 70 items, which the count allows, but 579 bytes against 560.
    const big = Array.from({ length: 7 }, (_, k) => ring("out", 10, 200, -300 + k * 90, 30, `r${k}`));
    const why = await app.fenceLink.sendFence({ zones: big, limits: goodLimits() }).then(() => "ACCEPTED", (e: Error) => e.message);
    say(`Seven ten-corner areas: ${why}`);
    const flagged = app.check.checkFence({ zones: big, limits: goodLimits(), home: home() }).find((f) => /storage/.test(f.text));
    say(`  the app had warned: ${flagged?.text ?? "NO WARNING"}`);
    expect(why).toMatch(/Fence exceeds storage size/);
    expect(flagged).toBeDefined();
    const tooMany = Array.from({ length: 8 }, (_, k) => ring("out", 10, 200, -300 + k * 90, 30, `t${k}`));
    const why2 = await app.commandLink.uploadFence(app.fence.zonesToWire(tooMany)).then(() => "ACCEPTED", (e: Error) => e.message);
    say(`Eighty items: ${why2}`);
    expect(why2).toMatch(/no room for that many items/);
    const still = await app.fenceLink.readFence();
    say(`  afterwards the aircraft still holds ${still.zones.length} zones, the same as before: ${app.fence.sameZones(still.zones, good())}`);
    expect(app.fence.sameZones(still.zones, good())).toBe(true);
  }, 90000);

  it("takes a crossed shape without complaint, which is why the app refuses it first", async () => {
    const bow = { id: "bow", shape: "polygon" as const, role: "out" as const, points: [at(100, 100), at(160, 160), at(160, 100), at(100, 160)] };
    const took = await app.commandLink.uploadFence(app.fence.zonesToWire([bow])).then(() => "ACCEPTED", (e: Error) => e.message);
    const ours = app.check.checkFence({ zones: [bow], limits: goodLimits(), home: home() }).find((f) => /crosses itself/.test(f.text));
    say(`A bow tie: ArduCopter ${took}; the app: ${ours?.sev ?? "nothing"}: ${ours?.text ?? ""}`);
    expect(took).toBe("ACCEPTED");
    expect(ours?.sev).toBe("bad");
    await app.fenceLink.sendFence({ zones: good(), limits: goodLimits() });
  }, 60000);

  it("keeps a fence of only circles, which the firmware would otherwise wipe", async () => {
    // ArduCopter 4.6 (and 4.7 built for SITL) stores one or two circles with FENCE_TOTAL 0, and its old
    // FENCE_POINT housekeeping then clears the fence if FENCE_TOTAL had been anything else.
    const circle = [{ id: "c1", shape: "circle" as const, role: "out" as const, centre: at(150, 150), radiusM: 30 }];
    await app.fenceLink.sendFence({ zones: good(), limits: goodLimits() });
    await app.commandLink.uploadFence(app.fence.zonesToWire(circle));
    await sleep(2000);
    const raw = (await app.commandLink.downloadFence()).length;
    say(`One circle sent straight after a polygon fence, as a plain upload: the aircraft holds ${raw} item${raw === 1 ? "" : "s"} two seconds later${raw === 0 ? " (wiped by the firmware)" : ""}.`);
    await app.fenceLink.sendFence({ zones: good(), limits: goodLimits() });
    await app.fenceLink.sendFence({ zones: circle, limits: goodLimits() });
    await sleep(2000);
    const kept = await app.fenceLink.readFence();
    say(`  sent by AERONEX: the aircraft holds ${kept.zones.length} zone${kept.zones.length === 1 ? "" : "s"} two seconds later.`);
    expect(app.fence.sameZones(kept.zones, circle)).toBe(true);
    await app.fenceLink.sendFence({ zones: good(), limits: goodLimits() });
  }, 90000);

  /** Try to arm in Loiter; return what ArduCopter said. */
  async function tryArm(): Promise<{ ok: boolean; said: string[] }> {
    await app.commandLink.setMode(5);
    const before = texts.length;
    let result = -1;
    for (let i = 0; i < 6 && result !== 0; i++) {
      result = await app.commandLink.arm(true).catch(() => -1);
      if (result !== 0) await sleep(1500);
    }
    const said = texts.slice(before).filter((t) => /PreArm|Arm:/i.test(t));
    if (result === 0) {
      await app.commandLink.arm(false).catch(() => -1);
      await until("disarm", () => !armed(), 20000);
    }
    return { ok: result === 0, said };
  }

  it("agrees with ArduCopter on when home breaches the fence", async () => {
    // Settle the position estimate first, on a fence that is clear.
    for (let i = 0; i < 60; i++) {
      const r = await tryArm();
      if (r.ok) break;
      await sleep(1000);
    }
    const cases: { name: string; zones: ReturnType<typeof good>; lim?: Record<string, number> }[] = [
      { name: "the good fence", zones: good() },
      { name: "home inside a keep-out circle", zones: [{ id: "c", shape: "circle", role: "out", centre: at(10, 0), radiusM: 30 }] as unknown as ReturnType<typeof good> },
      { name: "a keep-in area away from home", zones: [box("in", 600, 0, 50, "far")] as unknown as ReturnType<typeof good> },
      { name: "two keep-in areas, home in only one", zones: [box("in", 0, 0, 100, "a"), box("in", 300, 0, 100, "b")] as unknown as ReturnType<typeof good> },
      { name: "the same, with inside any one is enough", zones: [box("in", 0, 0, 100, "a"), box("in", 300, 0, 100, "b")] as unknown as ReturnType<typeof good>, lim: { FENCE_OPTIONS: 2 } },
      { name: "only zones chosen and none drawn", zones: [] as unknown as ReturnType<typeof good>, lim: { FENCE_TYPE: 4 } },
    ];
    for (const c of cases) {
      const lim = { ...goodLimits(), ...c.lim };
      await app.fenceLink.sendFence({ zones: c.zones, limits: lim });
      await sleep(1500);
      const ours = app.check.checkFence({ zones: c.zones, limits: lim, home: home() }).filter((f) => f.sev === "bad");
      const r = await tryArm();
      say(`${c.name}: ArduCopter ${r.ok ? "ARMED" : `refused (${r.said.slice(-2).join(" | ")})`}; the app ${ours.length ? `refuses: ${ours[0].text}` : "finds nothing to refuse"}`);
      expect(r.ok).toBe(ours.length === 0);
    }
    await app.fenceLink.sendFence({ zones: good(), limits: goodLimits() });
  }, 400000);

  /** Fly the mission on the aircraft until it disarms; return where it went and what it said. */
  async function fly(): Promise<{ track: { n: number; e: number; alt: number }[]; said: string[]; modes: string[] }> {
    const track: { n: number; e: number; alt: number }[] = [];
    const modes: string[] = [];
    const stop = app.useLink.subscribe((s) => {
      const q = s.telemetry.position?.value;
      if (q) track.push({ ...app.geo.toLocal(home(), q.lat, q.lon), alt: q.relAlt });
      const m = s.vehicle?.mode;
      if (m && modes[modes.length - 1] !== m) modes.push(m);
    });
    const before = texts.length;
    await app.commandLink.setMode(4);
    let result = -1;
    for (let i = 0; i < 60 && result !== 0; i++) {
      result = await app.commandLink.arm(true).catch(() => -1);
      if (result !== 0) await sleep(1000);
    }
    expect(result, `ArduCopter would not arm: ${texts.slice(-5).join(" | ")}`).toBe(0);
    expect(await app.commandLink.setMode(3)).toBe(0);
    expect(await app.commandLink.startMission()).toBe(0);
    const end = Date.now() + 400000;
    while (armed() && Date.now() < end) await sleep(200);
    stop();
    return { track, said: texts.slice(before), modes };
  }

  it("turns back where the app says the route enters a keep-out zone, as the app predicted", async () => {
    await app.commandLink.setParam("AUTO_OPTIONS", 3);
    const zones = [box("in", 0, 0, 400, "keep-in"), box("out", 120, 0, 20, "wall")];
    const lim = goodLimits();
    await app.fenceLink.sendFence({ zones, limits: lim });
    const pts = [{ id: "a", n: 250, e: 0, alt: 15, holdS: 0 }];
    const mission = app.sim.planToMission(home(), 15, pts, "rtl");
    await app.commandLink.uploadMission(mission);
    const { modelledParams: mp } = await import("../src/sim/firmwareParams");
    const speeds = mp(app.useParams.getState().values);
    const found = app.check.checkFence({ zones, limits: lim, home: home(), other: { WPNAV_SPEED: speeds.WPNAV_SPEED, WPNAV_ACCEL: speeds.WPNAV_ACCEL }, plan: { points: pts, takeoffAlt: 15, ending: "rtl" } });
    const says = found.find((f) => f.scope === "route" && f.sev === "bad");
    const m = says?.text.match(/(\d+) m after home/);
    const where = m ? Number(m[1]) : NaN;
    const { predict } = await import("../src/sim/predict");
    const { PRESETS } = await import("../src/sim/airframe");
    const { modelledParams } = await import("../src/sim/firmwareParams");
    const { defaultParams } = await import("../src/sim/params");
    const guess = predict(PRESETS[0], { ...defaultParams(PRESETS[0]), ...modelledParams(app.useParams.getState().values), ...lim }, home(), mission, { windSpeed: 0, windFromDeg: 0, gust: 0, soc: 1, faults: [], fence: app.fence.zonesToWire(zones) });
    const guessFar = Math.max(...guess.track.map((t) => t.n));

    const f = await fly();
    const far = Math.max(...f.track.map((t) => t.n));
    const last = f.track[f.track.length - 1];
    const breach = f.said.filter((t) => /fence|breach/i.test(t));
    say(`Into a keep-out wall at 100 m: the app says "${says?.text ?? "nothing"}"`);
    say(`  ArduCopter: furthest north ${far.toFixed(1)} m; modes ${f.modes.join(" → ")}; said: ${breach.join(" | ")}; ended ${Math.hypot(last.n, last.e).toFixed(1)} m from home`);
    say(`  the app's prediction: ${guess.verdict}, furthest north ${guessFar.toFixed(1)} m; ${guess.events.filter((e) => /fence/i.test(e.text)).map((e) => e.text).join(" | ")}`);
    expect(where).toBeGreaterThanOrEqual(98);
    expect(where).toBeLessThanOrEqual(101);
    expect(breach.some((t) => /Polygon fence breached/i.test(t))).toBe(true);
    expect(f.modes).toContain("RTL");
    // It went past the start of the wall by no more than its stopping distance, and came home.
    const stop = Number(says?.text.match(/needs about (\d+) m to stop/)?.[1] ?? NaN);
    say(`  it went ${(far - where).toFixed(1)} m past the edge; the app said about ${stop} m`);
    expect(far).toBeGreaterThan(where - 3);
    expect(Math.abs(far - where - stop)).toBeLessThan(6);
    expect(Math.hypot(last.n, last.e)).toBeLessThan(5);
    expect(guess.verdict).toBe("came-home");
    // The app's own simulation of the flight goes as far past the edge as the firmware does.
    expect(Math.abs(guessFar - far)).toBeLessThan(5);
  }, 600000);

  it("holds the return home under the ceiling, as the app says it will", async () => {
    const lim = { ...goodLimits(), FENCE_ALT_MAX: 30, FENCE_MARGIN: 2 };
    await app.fenceLink.sendFence({ zones: good(), limits: lim });
    // Return height set above the ceiling: in centimetres or metres, by this firmware's own name for it.
    const v = app.useParams.getState().values;
    if (Number.isFinite(v.RTL_ALT_M)) await app.commandLink.setParam("RTL_ALT_M", 50);
    else await app.commandLink.setParam("RTL_ALT", 5000);
    const pts = [{ id: "a", n: 80, e: 40, alt: 15, holdS: 0 }];
    await app.commandLink.uploadMission(app.sim.planToMission(home(), 15, pts, "rtl"));
    const note = app.check.checkFence({ zones: good(), limits: lim, home: home(), other: { RTL_ALT: 5000 }, plan: { points: pts, takeoffAlt: 15, ending: "rtl" } }).find((f) => /flies it at/.test(f.text));
    const f = await fly();
    const top = Math.max(...f.track.map((t) => t.alt));
    say(`Return home set for 50 m under a 30 m ceiling: the app says "${note?.text ?? "nothing"}"; ArduCopter climbed to ${top.toFixed(1)} m; ${f.said.filter((t) => /fence/i.test(t)).join(" | ") || "no fence messages"}`);
    expect(note?.text).toMatch(/flies it at 28 m/);
    expect(top).toBeLessThan(30);
    expect(top).toBeGreaterThan(25);
    expect(f.said.some((t) => /Max Alt fence breached/i.test(t))).toBe(false);
  }, 600000);

  it("clears the fence when asked", async () => {
    await app.fenceLink.sendFence({ zones: [], limits: limits({ FENCE_ENABLE: 0 }) });
    const back = await app.fenceLink.readFence();
    say(`Cleared: the aircraft holds ${back.zones.length} zones and FENCE_ENABLE ${back.limits.FENCE_ENABLE}`);
    expect(back.zones).toEqual([]);
    expect(back.limits.FENCE_ENABLE).toBe(0);
  }, 60000);
});
