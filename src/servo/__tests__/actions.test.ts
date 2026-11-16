import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
  The page's save, test and gripper actions through the app's own link to the
  virtual aircraft, which hides the gripper's settings until GRIP_ENABLE is on
  and starts the gripper only at start-up, as ArduCopter does. The same
  actions are run against real ArduCopter in sitl/servo.test.ts.
*/
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined, setInterval, clearInterval, setTimeout, clearTimeout }));

const until = async (what: string, test: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("servo actions on the virtual aircraft", () => {
  let app: {
    linkManager: (typeof import("../../services/link/linkManager"))["linkManager"];
    commandLink: (typeof import("../../services/link/commandLink"))["commandLink"];
    useLink: (typeof import("../../state/linkStore"))["useLink"];
    useParams: (typeof import("../../state/paramStore"))["useParams"];
    reboot: (typeof import("../../features/params/rebootStore"))["useRebootNeeded"];
    actions: typeof import("../actions");
  };
  const p = () => app.useParams.getState().values;
  const out = (n: number) => app.useLink.getState().telemetry.servo?.value.pwm[n - 1];

  beforeAll(async () => {
    app = {
      linkManager: (await import("../../services/link/linkManager")).linkManager,
      commandLink: (await import("../../services/link/commandLink")).commandLink,
      useLink: (await import("../../state/linkStore")).useLink,
      useParams: (await import("../../state/paramStore")).useParams,
      reboot: (await import("../../features/params/rebootStore")).useRebootNeeded,
      actions: await import("../actions"),
    };
    const { PRESETS } = await import("../../sim/airframe");
    app.linkManager.connectVirtual({ airframe: PRESETS[0], home: { lat: 23.0225, lon: 72.5714, altMsl: 53 } });
    await until("the virtual aircraft", () => app.useLink.getState().status === "connected");
    await app.commandLink.ensureParamList();
    await until("its parameters", () => app.useParams.getState().list === "complete" && p().SERVO9_FUNCTION !== undefined, 15000);
  }, 30000);

  afterAll(async () => {
    await app?.linkManager.disconnect("Test finished.");
  });

  it("saves a payload release in two steps: the gripper's settings are written once they appear", async () => {
    expect("GRIP_TYPE" in p()).toBe(false);
    const steps: string[] = [];
    const written = await app.actions.saveChanges({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1850, GRIP_RELEASE: 1150, GRIP_NEUTRAL: 1500, RC8_OPTION: 19 }, false, (s) => steps.push(s));
    expect(written.sort()).toEqual(["GRIP_ENABLE", "GRIP_GRAB", "GRIP_NEUTRAL", "GRIP_RELEASE", "GRIP_TYPE", "RC8_OPTION", "SERVO9_FUNCTION"]);
    expect(steps).toContain("Reading the settings that just appeared…");
    expect(p()).toMatchObject({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1850, GRIP_RELEASE: 1150 });
    expect(app.reboot.getState().names).toEqual(["GRIP_ENABLE", "GRIP_TYPE", "SERVO9_FUNCTION"]);
  }, 20000);

  it("says the gripper did not move until the restart, then releases and closes at exactly the positions", async () => {
    await expect(app.actions.gripper("release", { servo: 9, pwm: 1150 })).rejects.toThrow(/accepted the command, but output 9 did not move/);
    await app.commandLink.reboot();
    await until("the gripper at rest", () => out(9) === 1500);
    await app.actions.gripper("release", { servo: 9, pwm: 1150 });
    expect(out(9)).toBe(1150);
    await app.actions.gripper("grab", { servo: 9, pwm: 1850 });
    expect(out(9)).toBe(1850);
  }, 20000);

  it("moves a Disabled output, and passes on the refusal for a motor's", async () => {
    await app.actions.testOutput(10, 1600);
    await until("output 10 at 1600", () => out(10) === 1600);
    await expect(app.actions.testOutput(1, 1600)).rejects.toThrow(/Channel 1 is already in use/);
  }, 20000);

  it("reports the setting that does not exist", async () => {
    await expect(app.actions.saveChanges({ NOT_A_SETTING: 1 })).rejects.toThrow(/NOT_A_SETTING does not exist/);
  }, 20000);
});
