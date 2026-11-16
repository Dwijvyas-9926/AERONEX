import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleep, tcpSerialPort, until } from "./harness";

/*
  Servo outputs against real ArduCopter.

  What the Servo Outputs page sets up is written to the firmware itself
  (ArduPilot's SITL build, the same code as a Pixhawk) through the app's real
  serial path, and the outputs are read back from what the firmware reports
  it is sending (SERVO_OUTPUT_RAW):

  - a Disabled output moves to the pulse a mission or button sends it;
  - a motor's output refuses that, with ArduPilot's own reason, and the page
    passes the reason on;
  - an output set to follow a transmitter channel follows it, exactly or
    scaled into its own range;
  - a payload release set up the page's way (enable, then the settings that
    appear) is refused until a restart, then opens and closes from a button
    and from a transmitter switch at exactly the positions set;
  - the settings survive the restart.

      SITL_BIN=…/arducopter SITL_DEFAULTS=…/copter.parm npx vitest run sitl/servo

  Skipped without SITL_BIN.
*/
const BIN = process.env.SITL_BIN;
const DEFAULTS = process.env.SITL_DEFAULTS;
const SPEEDUP = Number(process.env.SITL_SPEEDUP ?? 5);
const REPORT = process.env.SITL_REPORT;
const INSTANCE = Number(process.env.SITL_INSTANCE ?? 3);
const PORT = 5760 + 10 * INSTANCE;

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }));
Object.defineProperty(globalThis.navigator, "serial", { value: { addEventListener: () => undefined, getPorts: async () => [] }, configurable: true });

const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};

describe.skipIf(!BIN)("servo outputs against real ArduCopter (SITL)", () => {
  let proc: ChildProcess;
  const dir = mkdtempSync(path.join(tmpdir(), "aeronex-servo-"));
  let app: {
    linkManager: (typeof import("../src/services/link/linkManager"))["linkManager"];
    commandLink: (typeof import("../src/services/link/commandLink"))["commandLink"];
    useLink: (typeof import("../src/state/linkStore"))["useLink"];
    useParams: (typeof import("../src/state/paramStore"))["useParams"];
    model: typeof import("../src/servo/model");
    actions: typeof import("../src/servo/actions");
  };
  const servo = (n: number) => app.useLink.getState().telemetry.servo?.value.pwm[n - 1];
  const servoAt = () => app.useLink.getState().telemetry.servo?.at ?? 0;
  const p = () => app.useParams.getState().values;

  async function start(wipe: boolean) {
    const args = ["--model", "quad", "--speedup", String(SPEEDUP), "--home", "23.0225,72.5714,53,0", `-I${INSTANCE}`];
    if (wipe) args.push("--wipe");
    if (DEFAULTS) args.push("--defaults", DEFAULTS);
    proc = spawn(BIN!, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
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
    await until("servo outputs to be reported", () => servo(1) !== undefined, 20000);
  }

  /** Hold transmitter channels at these pulses (RC_CHANNELS_OVERRIDE, resent as ArduPilot expects). */
  async function hold(ch: Record<number, number>, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f: Record<string, number> = {};
      for (let i = 1; i <= 18; i++) f[`chan${i}_raw`] = ch[i] ?? (i <= 8 ? 65535 : 0);
      await app.commandLink.post("RC_CHANNELS_OVERRIDE", f);
      await sleep(100);
    }
  }

  /** Wait for a fresh SERVO_OUTPUT_RAW and read an output. */
  async function settle(n: number, want?: number, ms = 4000): Promise<number | undefined> {
    const from = Date.now();
    await until(`output ${n}${want !== undefined ? ` at ${want}` : ""}`, () => servoAt() > from && (want === undefined || servo(n) === want), ms).catch(() => undefined);
    return servo(n);
  }

  beforeAll(async () => {
    app = {
      linkManager: (await import("../src/services/link/linkManager")).linkManager,
      commandLink: (await import("../src/services/link/commandLink")).commandLink,
      useLink: (await import("../src/state/linkStore")).useLink,
      useParams: (await import("../src/state/paramStore")).useParams,
      model: await import("../src/servo/model"),
      actions: await import("../src/servo/actions"),
    };
    await start(true);
    const a = app.useLink.getState().telemetry.autopilot?.value;
    say(`Linked. AUTOPILOT_VERSION: board id ${a?.boardId ?? "none (SITL has no APJ board id)"}, firmware ${a?.version ?? "?"}.`);
    say(`Outputs reported: ${app.useLink.getState().telemetry.servo!.value.pwm.join(" ")}`);
    say(`SERVO1-4_FUNCTION = ${[1, 2, 3, 4].map((n) => p()[`SERVO${n}_FUNCTION`]).join(", ")}; SERVO9_FUNCTION = ${p().SERVO9_FUNCTION}; GRIP_ENABLE = ${p().GRIP_ENABLE}; GRIP_TYPE present: ${"GRIP_TYPE" in p()}`);
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

  it("reads a stock quad's outputs as the page shows them", () => {
    const outs = app.model.readOutputs(p(), null);
    expect(outs.length).toBeGreaterThanOrEqual(16);
    expect(outs.slice(0, 4).map((o) => app.model.motorOf(o.fn))).toEqual([1, 2, 3, 4]);
    const issues = app.model.checkOutputs(p(), null, { mavType: app.useLink.getState().vehicle?.type });
    say(`Checks on the stock quad: ${issues.length ? issues.map((i) => i.id).join(", ") : "none"}`);
    expect(issues.filter((i) => i.level !== "info")).toEqual([]);
  });

  it("moves a Disabled output to the pulse sent, as a mission's Set servo does", async () => {
    expect(p().SERVO9_FUNCTION).toBe(0);
    say(`Output 9 (Disabled) before any command: ${await settle(9)} µs`);
    await app.actions.testOutput(9, 1700);
    expect(await settle(9, 1700)).toBe(1700);
    await app.actions.testOutput(9, 1234);
    expect(await settle(9, 1234)).toBe(1234);
    say("Output 9 moved to 1700 µs then 1234 µs, as sent.");
  });

  it("moves an RCPassThru (same-number channel) output too, as do_set_servo allows", async () => {
    await app.actions.writeSettings({ SERVO13_FUNCTION: 1 });
    await app.actions.testOutput(13, 1650);
    expect(await settle(13, 1650)).toBe(1650);
    say("Output 13 set to RCPassThru (1) moved to 1650 µs by DO_SET_SERVO.");
  });

  it("refuses to move a motor's output, and the page gives ArduPilot's reason", async () => {
    const err = await app.actions.testOutput(1, 1600).then(() => null, (e: Error) => e.message);
    say(`DO_SET_SERVO on output 1 (Motor 1): ${err}`);
    expect(err).toMatch(/Channel 1 is already in use/);
  });

  it("makes an output follow a transmitter channel, exactly and scaled", async () => {
    await app.actions.writeSettings({ SERVO10_FUNCTION: app.model.passThroughFunction(6, false), SERVO11_FUNCTION: app.model.passThroughFunction(7, true), SERVO11_MIN: 1000, SERVO11_TRIM: 1500, SERVO11_MAX: 2000 });
    expect(p().SERVO10_FUNCTION).toBe(56);
    expect(p().SERVO11_FUNCTION).toBe(146);
    void hold({ 6: 1800, 7: 1900 }, 3000);
    expect(await settle(10, 1800, 3000)).toBe(1800);
    // Scaled: the channel's calibrated range (RC7_MIN/TRIM/MAX) onto the output's 1000-1500-2000.
    const rc = { min: p().RC7_MIN, trim: p().RC7_TRIM, max: p().RC7_MAX };
    const norm = (1900 - rc.trim) / (rc.max - rc.trim);
    const want = Math.round(1500 + norm * 500);
    const scaled = await settle(11, want, 3000);
    say(`Channel 6 at 1800 → output 10 (exact) ${servo(10)} µs; channel 7 at 1900 (RC7 calibrated ${rc.min}-${rc.trim}-${rc.max}) → output 11 (scaled into 1000-1500-2000) ${scaled} µs, expected ${want}`);
    expect(scaled).toBe(want);
    await sleep(3100);
    void hold({ 6: 1200, 7: 1500 }, 3000);
    expect(await settle(10, 1200, 3000)).toBe(1200);
    expect(await settle(11, 1500, 3000)).toBe(1500);
    say("Exact pass-through copies the pulse; scaled maps the channel's centre to the output's centre and its top to the output's top.");
    await sleep(3100);
  }, 30000);

  it("sets up a payload release in ArduPilot's order, refused until a restart", async () => {
    const steps: string[] = [];
    await app.actions.setupGripper(12, { grab: 1800, release: 1200, neutral: 1500 }, (s) => steps.push(s));
    say(`Gripper set up on output 12: ${steps.join(" → ")}`);
    expect(p()).toMatchObject({ SERVO12_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1800, GRIP_RELEASE: 1200, GRIP_NEUTRAL: 1500 });
    await app.actions.writeSettings({ RC8_OPTION: 19 });
    // ArduPilot accepts DO_GRIPPER now but nothing moves until a restart; the page checks the output, and says so.
    const err = await app.actions.gripper("release", { servo: 12, pwm: 1200 }).then(() => null, (e: Error) => e.message);
    say(`DO_GRIPPER before restarting: ${err}`);
    expect(err).toMatch(/accepted the command, but output 12 did not move/);
    expect(err).toMatch(/Restart/);
    const issues = app.model.checkOutputs(p(), null);
    expect(issues.filter((i) => i.id.startsWith("grip"))).toEqual([]);
  }, 30000);

  it("after a restart, opens and closes from a button and a transmitter switch at exactly the positions set", async () => {
    await app.linkManager.disconnect("Restarting the simulator.");
    proc.kill("SIGKILL");
    await sleep(1000);
    await start(false);
    expect(p()).toMatchObject({ SERVO10_FUNCTION: 56, SERVO11_FUNCTION: 146, SERVO12_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1800, GRIP_RELEASE: 1200, RC8_OPTION: 19 });
    say(`After the restart the settings are kept; output 12 rests at ${await settle(12)} µs.`);
    await app.actions.gripper("release", { servo: 12, pwm: 1200 });
    expect(servo(12)).toBe(1200);
    await app.actions.gripper("grab", { servo: 12, pwm: 1800 });
    expect(servo(12)).toBe(1800);
    // Scaled pass-through after the restart too: the channel's top to the output's top.
    void hold({ 7: p().RC7_MAX }, 2000);
    expect(await settle(11, 2000, 2000)).toBe(2000);
    await sleep(2100);
    say("Release button → 1200 µs, Grab → 1800 µs.");
    // The transmitter switch: low releases, high grabs.
    void hold({ 8: 1100 }, 2500);
    expect(await settle(12, 1200, 2500)).toBe(1200);
    await sleep(2600);
    void hold({ 8: 1900 }, 2500);
    expect(await settle(12, 1800, 2500)).toBe(1800);
    say("Switch on channel 8 low → released (1200 µs), high → grabbed (1800 µs).");
    await sleep(2600);
    // A gripper output can also be moved directly, for checking the positions.
    await app.actions.testOutput(12, 1500);
    expect(await settle(12, 1500)).toBe(1500);
  }, 200000);
});
