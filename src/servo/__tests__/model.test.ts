import { describe, expect, it } from "vitest";
import { boardFor, channelUse, checkOutputs, functionInfo, gripperSettings, motorCount, motorOf, movedChannel, needsRestart, outputNumbers, passThroughFunction, portOf, rcOf, readOutputs, testable, type Params } from "../model";
import { OUTPUT_LAYOUTS, LAYOUT_BY_PLATFORM } from "../outputs.generated";
import { setServoAllowed } from "../../sim/servos";

const PX = OUTPUT_LAYOUTS[LAYOUT_BY_PLATFORM["Pixhawk1"]];

/** A quad on a Pixhawk 2.4.8, as ArduCopter leaves it after choosing the frame. */
function quad(over: Params = {}): Params {
  const p: Params = { FRAME_CLASS: 1, RC_SPEED: 490, MOT_PWM_TYPE: 0, BRD_SAFETY_DEFLT: 1, BRD_SAFETY_MASK: 0, GRIP_ENABLE: 0, FLTMODE_CH: 5, RCMAP_ROLL: 1, RCMAP_PITCH: 2, RCMAP_THROTTLE: 3, RCMAP_YAW: 4 };
  for (let n = 1; n <= 16; n++) {
    p[`SERVO${n}_FUNCTION`] = n <= 4 ? 32 + n : 0;
    p[`SERVO${n}_MIN`] = 1100;
    p[`SERVO${n}_MAX`] = 1900;
    p[`SERVO${n}_TRIM`] = 1500;
    p[`SERVO${n}_REVERSED`] = 0;
  }
  for (let c = 1; c <= 16; c++) p[`RC${c}_OPTION`] = 0;
  for (let r = 1; r <= 6; r++) p[`RELAY${r}_PIN`] = -1;
  return { ...p, ...over };
}
const ids = (p: Params) => checkOutputs(p, PX).map((i) => i.id);

describe("the Pixhawk 2.4.8's outputs, as its board definition gives them", () => {
  it("has MAIN OUT 1-8 on the IO processor in groups 1-2, 3-4, 5-8, and AUX OUT 1-6 in groups 1-4, 5-6", () => {
    expect(PX.io).toBe(true);
    expect(PX.servos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(PX.groups).toEqual([[1, 2], [3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14]]);
    // AUX 1-6 are GPIO 50-55 when used as relays (fmuv3 hwdef).
    expect(PX.gpio.slice(8)).toEqual([50, 51, 52, 53, 54, 55]);
    expect(portOf(5, PX).long).toBe("MAIN OUT 5");
    expect(portOf(9, PX).long).toBe("AUX OUT 1");
    expect(portOf(14, PX).short).toBe("AUX 6");
  });

  it("is found from the board id the flight controller reports, or from the profile", () => {
    expect(boardFor(9, null)).toMatchObject({ source: "likely", pixhawk1: true });
    expect(boardFor(9, null).layout).toBe(PX);
    expect(boardFor(null, "pixhawk-2.4.8")).toMatchObject({ source: "profile", pixhawk1: true });
    expect(boardFor(56, null)).toMatchObject({ source: "board-id", pixhawk1: false });
    expect(boardFor(56, null).layout!.servos.length).toBe(16);
    expect(boardFor(null, "other")).toMatchObject({ source: "none", layout: null });
    expect(boardFor(999_999, "pixhawk-2.4.8").layout).toBeNull();
  });

  it("lists the SERVOn settings the aircraft has when the board is unknown", () => {
    expect(outputNumbers(quad(), null)).toHaveLength(16);
    expect(outputNumbers(quad(), PX)).toHaveLength(14);
  });
});

describe("functions, as ArduPilot numbers them", () => {
  it("knows motors, pass-through and what DO_SET_SERVO may move", () => {
    expect(motorOf(33)).toBe(1);
    expect(motorOf(40)).toBe(8);
    expect(motorOf(82)).toBe(9);
    expect(motorOf(160)).toBe(13);
    expect(motorOf(28)).toBeNull();
    expect(rcOf(58, 9)).toEqual({ channel: 8, scaled: false });
    expect(rcOf(145, 9)).toEqual({ channel: 6, scaled: true });
    expect(rcOf(1, 7)).toEqual({ channel: 7, scaled: false });
    expect(passThroughFunction(6, false)).toBe(56);
    expect(passThroughFunction(6, true)).toBe(145);
    // Same rule as the virtual aircraft, which follows AP_ServoRelayEvents::do_set_servo.
    for (let fn = -1; fn <= 180; fn++) expect(testable(fn)).toBe(setServoAllowed(fn));
    expect(testable(0) && testable(28) && testable(56) && testable(145)).toBe(true);
    // RCPassThru (1) is k_manual, which do_set_servo allows.
    expect(testable(1)).toBe(true);
    expect(testable(33) || testable(10) || testable(7) || testable(29)).toBe(false);
  });

  it("names any function, from the firmware's list when it is not one of the common ones", () => {
    expect(functionInfo(28).label).toMatch(/Payload release/);
    expect(functionInfo(77, [[77, "ElevonLeft"]]).label).toBe("ElevonLeft");
    expect(functionInfo(77).label).toBe("Function 77");
  });

  it("counts a frame's motors", () => {
    expect(motorCount({ FRAME_CLASS: 1 })).toBe(4);
    expect(motorCount({ FRAME_CLASS: 2 })).toBe(6);
    expect(motorCount({ FRAME_CLASS: 6 })).toBeNull(); // helicopter
    expect(motorCount({}, 13)).toBe(6);
  });
});

describe("checks", () => {
  it("finds nothing wrong with a stock quad", () => {
    expect(checkOutputs(quad(), PX)).toEqual([]);
  });

  it("warns that a servo on MAIN 3 runs at the motors' 490 Hz, and is fine on AUX", () => {
    const hexa = quad({ FRAME_CLASS: 2, SERVO5_FUNCTION: 37, SERVO6_FUNCTION: 38, SERVO7_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1 });
    const issues = checkOutputs(hexa, PX);
    const g = issues.find((i) => i.id === "group-7")!;
    expect(g.level).toBe("warn");
    expect(g.title).toBe("MAIN OUT 7 runs at 490 Hz");
    expect(g.detail).toMatch(/MAIN 5, MAIN 6, MAIN 7, MAIN 8 share one timer with MAIN 5 and MAIN 6/);
    // Unused MAIN 8 in the same group: a note, not a warning.
    expect(issues.find((i) => i.id === "group-8")!.level).toBe("info");
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1 }))).not.toContain("group-9");
  });

  it("says a servo beside DShot motors cannot work at all", () => {
    const p = quad({ MOT_PWM_TYPE: 6, SERVO9_FUNCTION: 33, SERVO10_FUNCTION: 34, SERVO11_FUNCTION: 35, SERVO12_FUNCTION: 36, SERVO1_FUNCTION: 0, SERVO2_FUNCTION: 0, SERVO3_FUNCTION: 0, SERVO4_FUNCTION: 0, SERVO13_FUNCTION: 0 });
    // Motors on AUX 1-4 (one timer); nothing else in that group: no issue.
    expect(ids(p).filter((i) => i.startsWith("group"))).toEqual([]);
    const q = quad({ MOT_PWM_TYPE: 6, SERVO4_FUNCTION: 56, SERVO5_FUNCTION: 36 });
    const g = checkOutputs(q, PX).find((i) => i.id === "group-4")!;
    expect(g.level).toBe("danger");
    expect(g.detail).toMatch(/DShot600/);
  });

  it("finds a motor with no output, or on two", () => {
    expect(ids(quad({ SERVO3_FUNCTION: 0 }))).toContain("motor-missing-3");
    expect(ids(quad({ SERVO9_FUNCTION: 33 }))).toContain("motor-twice-1");
    expect(ids(quad({ SERVO9_FUNCTION: 37 }))).toContain("motor-extra-5");
  });

  it("warns when an output follows a channel that flies the aircraft", () => {
    expect(channelUse(quad(), 3)).toBe("the throttle stick");
    expect(channelUse(quad(), 5)).toBe("the flight-mode switch");
    expect(channelUse(quad({ FLTMODE_CH: 8 }), 5)).toBeNull();
    const i = checkOutputs(quad({ SERVO9_FUNCTION: 53 }), PX).find((x) => x.id === "rc-flying-9")!;
    expect(i.title).toBe("AUX OUT 1 follows channel 3, the throttle stick");
    expect(ids(quad({ SERVO9_FUNCTION: 56 }))).not.toContain("rc-flying-9");
    expect(ids(quad({ SERVO9_FUNCTION: 60 }))).toEqual(expect.arrayContaining([]));
    expect(checkOutputs(quad({ SERVO9_FUNCTION: 60 }), PX, { rcChannels: 8 }).map((x) => x.id)).toContain("rc-none-9");
  });

  it("explains why a pass-through output sends nothing with no transmitter signal", () => {
    const p = quad({ SERVO6_FUNCTION: 56, SERVO9_FUNCTION: 56 });
    const i = checkOutputs(p, PX, { rcChannels: 0 }).find((x) => x.id === "rc-no-signal")!;
    expect(i.detail).toMatch(/^MAIN 6, AUX 1 follow a transmitter channel/);
    expect(checkOutputs(p, PX, { rcChannels: 16 }).map((x) => x.id)).not.toContain("rc-no-signal");
  });

  it("explains that an exact pass-through ignores the output's limits", () => {
    expect(ids(quad({ SERVO9_FUNCTION: 56, SERVO9_MAX: 1700 }))).toContain("rc-limits-9");
    expect(ids(quad({ SERVO9_FUNCTION: 145, SERVO9_MAX: 1700 }))).not.toContain("rc-limits-9");
  });

  it("checks the gripper's output and settings agree", () => {
    expect(ids(quad({ SERVO9_FUNCTION: 28 }))).toContain("grip-off");
    expect(checkOutputs(quad({ SERVO9_FUNCTION: 28 }), PX).find((i) => i.id === "grip-off")!.fix).toEqual({ GRIP_ENABLE: 1 });
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 0 }))).toContain("grip-type");
    expect(ids(quad({ GRIP_ENABLE: 1, GRIP_TYPE: 1 }))).toContain("grip-no-output");
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1500, GRIP_RELEASE: 1500 }))).toContain("grip-same");
    expect(ids(quad({ RC7_OPTION: 19 }))).toContain("grip-switch-7");
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1900, GRIP_RELEASE: 1100, RC7_OPTION: 19 }))).not.toContain("grip-switch-7");
  });

  it("refuses a switch option on a channel that flies the aircraft", () => {
    const i = checkOutputs(quad({ RC3_OPTION: 19, GRIP_ENABLE: 1 }), PX).find((x) => x.id === "switch-flying-3")!;
    expect(i.level).toBe("danger");
  });

  it("finds an output that is also a relay's pin", () => {
    // AUX 5 is GPIO 54 on a Pixhawk 2.4.8.
    expect(ids(quad({ SERVO13_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, RELAY1_PIN: 54 }))).toContain("relay-13");
    expect(ids(quad({ SERVO13_FUNCTION: -1, RELAY1_PIN: 54 }))).not.toContain("relay-13");
  });

  it("checks each output's pulse range", () => {
    expect(ids(quad({ SERVO9_FUNCTION: 0, SERVO9_MIN: 1900, SERVO9_MAX: 1100 }))).toContain("range-9");
    expect(ids(quad({ SERVO9_FUNCTION: 0, SERVO9_TRIM: 2000 }))).toContain("trim-9");
    expect(ids(quad({ SERVO9_FUNCTION: 0, SERVO9_MAX: 2400 }))).toContain("wide-9");
  });

  it("notes that the safety switch holds payload servos still, unless masked", () => {
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1 }))).toContain("safety");
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, BRD_SAFETY_MASK: 1 << 8 }))).not.toContain("safety");
    expect(ids(quad({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, BRD_SAFETY_DEFLT: 0 }))).not.toContain("safety");
  });

  it("lists the most serious first", () => {
    const levels = checkOutputs(quad({ SERVO3_FUNCTION: 0, SERVO9_FUNCTION: 28 }), PX).map((i) => i.level);
    expect(levels).toEqual([...levels].sort((a, b) => ["danger", "warn", "info"].indexOf(a) - ["danger", "warn", "info"].indexOf(b)));
  });
});

describe("changes", () => {
  it("marks what applies only after a restart", () => {
    const before = quad();
    expect(needsRestart({ SERVO9_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_GRAB: 1800, SERVO9_MIN: 1000 }, before).sort()).toEqual(["GRIP_ENABLE", "SERVO9_FUNCTION"]);
    expect(needsRestart({ SERVO9_FUNCTION: 0 }, before)).toEqual([]);
  });

  it("sets up a gripper in ArduPilot's order: enable first, then the settings that appear", () => {
    expect(gripperSettings(9, quad(), { grab: 1900, release: 1100, neutral: 1500 })).toEqual({
      first: { SERVO9_FUNCTION: 28, GRIP_ENABLE: 1 },
      then: { GRIP_TYPE: 1, GRIP_GRAB: 1900, GRIP_RELEASE: 1100, GRIP_NEUTRAL: 1500 },
    });
    expect(gripperSettings(9, quad({ GRIP_ENABLE: 1 }), { grab: 1900, release: 1100, neutral: 1500 }).first).toEqual({ SERVO9_FUNCTION: 28 });
  });

  it("finds the switch that was flipped", () => {
    const before = [1500, 1500, 1000, 1500, 1100, 1500, 1100, 1500];
    expect(movedChannel(before, [1510, 1490, 1000, 1500, 1100, 1500, 1900, 1500])).toBe(7);
    expect(movedChannel(before, [1520, 1500, 1000, 1500, 1100, 1500, 1100, 1500])).toBeNull();
  });

  it("reads an output's settings", () => {
    const [o] = readOutputs(quad({ SERVO9_FUNCTION: 28, SERVO9_REVERSED: 1 }), PX).filter((x) => x.servo === 9);
    expect(o).toMatchObject({ fn: 28, reversed: true, group: [9, 10, 11, 12], gpio: 50, port: { long: "AUX OUT 1" } });
  });
});
