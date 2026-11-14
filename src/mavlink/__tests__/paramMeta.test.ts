import { describe, expect, it } from "vitest";
import { compareParams, parseParamFile } from "../paramFile";
import raw46 from "../params/copter-4.6.json?raw";
import raw47 from "../params/copter-4.7.json?raw";
import { bitLabels, bitsOf, checkValue, defFor, describeValue, groupOf, matchesSearch, metaVersionFor, unitText, withBit, type MetaSet } from "../paramMeta";

/* The definitions are ArduCopter's own; these tests pin how the app reads them. */

const m47 = JSON.parse(raw47) as MetaSet;
const m46 = JSON.parse(raw46) as MetaSet;

describe("bundled definitions", () => {
  it("come from the firmware sources they claim", () => {
    expect(m47.firmware).toBe("ArduCopter 4.7.2");
    expect(m46.firmware).toBe("ArduCopter 4.6.3");
    expect(Object.keys(m47.params).length).toBeGreaterThan(5000);
    expect(Object.keys(m46.params).length).toBeGreaterThan(4500);
  });

  it("describe every setting the app reads by name, in each version", () => {
    const both = ["FRAME_CLASS", "FRAME_TYPE", "BATT_CAPACITY", "BATT_LOW_VOLT", "MOT_THST_HOVER", "FS_THR_ENABLE", "FENCE_ENABLE", "ATC_RAT_RLL_P", "INS_ACCOFFS_X", "LOG_BITMASK"];
    for (const n of [...both, "WP_SPD", "RTL_ALT_M", "PSC_D_ACC_P", "ARMING_SKIPCHK"]) expect(m47.params[n], n).toBeDefined();
    for (const n of [...both, "WPNAV_SPEED", "RTL_ALT", "PSC_ACCZ_P", "ARMING_CHECK"]) expect(m46.params[n], n).toBeDefined();
    for (const d of Object.values(m47.params)) expect(d.n.length + d.d.length).toBeGreaterThan(0);
  });

  it("describe every setting the virtual aircraft offers, under ArduCopter 4.6 names", async () => {
    const { PARAM_DEFS, defaultParams } = await import("../../sim/params");
    const { PRESETS } = await import("../../sim/airframe");
    expect(metaVersionFor(defaultParams(PRESETS[0]))).toBe("4.6");
    expect(PARAM_DEFS.map((p) => p.name).filter((n) => !m46.params[n])).toEqual([]);
  });

  it("use the multirotor definition, with the helicopter one for helicopter frames", () => {
    expect(m47.params.ATC_RAT_RLL_P.r).toEqual([0.01, 0.5]);
    expect(defFor(m47, "ATC_RAT_RLL_P", { FRAME_CLASS: 1 })?.r).toEqual([0.01, 0.5]);
    expect(defFor(m47, "ATC_RAT_RLL_P", { FRAME_CLASS: 6 })?.r).toEqual([0, 0.35]);
  });

  it("pick the documentation by the names the aircraft uses", () => {
    expect(metaVersionFor({ WP_SPD: 10 })).toBe("4.7");
    expect(metaVersionFor({ WPNAV_SPEED: 1000 })).toBe("4.6");
    expect(metaVersionFor({ ARMING_CHECK: 1 })).toBe("4.6");
    expect(metaVersionFor({})).toBe("4.7");
  });
});

describe("what a value means", () => {
  it("names options, bits and units", () => {
    expect(describeValue(m47, m47.params.FRAME_CLASS, 1)).toBe("Quad");
    expect(describeValue(m47, m47.params.WP_SPD, 10)).toBe("10 m/s");
    expect(bitLabels(m47.params.LOG_BITMASK, 0b101)).toEqual(["Fast Attitude", "GPS"]);
    expect(describeValue(m47, m47.params.ARMING_SKIPCHK, 0)).toBe("None");
    expect(unitText(m47, "m/s")).toBe("meters per second");
    expect(unitText(m47, "made-up")).toBe("made-up");
  });

  it("reads and toggles bits without 32-bit overflow", () => {
    expect(bitsOf(2 ** 31 + 1)).toEqual([0, 31]);
    expect(withBit(0, 3, true)).toBe(8);
    expect(withBit(8, 3, false)).toBe(0);
    expect(withBit(8, 3, true)).toBe(8);
    expect(withBit(2 ** 31, 0, true)).toBe(2 ** 31 + 1);
  });
});

describe("checking a value before it is staged", () => {
  it("refuses what cannot be stored", () => {
    expect(checkValue(m47.params.WP_SPD, NaN)[0].level).toBe("error");
    expect(checkValue(m47.params.FRAME_CLASS, 1.5, 2)[0].text).toMatch(/whole number/);
    expect(checkValue(undefined, 300, 2)[0].text).toMatch(/-128 to 127/);
    expect(checkValue(m47.params.COMPASS_DEV_ID, 5)[0].text).toMatch(/Read-only/);
  });

  it("flags values outside the documented range for an explicit decision", () => {
    const c = checkValue(m47.params.WP_SPD, 50, 9);
    expect(c[0].level).toBe("outside");
    expect(c[0].text).toBe("Outside the documented range, 0.1 to 20 m/s.");
    expect(checkValue(m47.params.WP_SPD, 12, 9)).toEqual([]);
  });

  it("accepts a documented option even beyond the range", () => {
    // BATT_VOLT_PIN: -1 = Disabled is an option and inside the range.
    expect(checkValue(m47.params.BATT_VOLT_PIN, -1, 2)).toEqual([]);
  });

  it("warns about undocumented options and bits", () => {
    expect(checkValue(m47.params.FRAME_CLASS, 99, 2)[0]?.level).toBe("warn");
    expect(checkValue(m47.params.LOG_BITMASK, 2 ** 30, 6)[0]?.text).toMatch(/bit 30/);
  });
});

describe("groups and search", () => {
  it("groups numbered instances together", () => {
    expect(groupOf("SERVO3_FUNCTION")).toBe("SERVO");
    expect(groupOf("BATT2_MONITOR")).toBe("BATT");
    expect(groupOf("BATTA_MONITOR")).toBe("BATT");
    expect(groupOf("RC10_OPTION")).toBe("RC");
    expect(groupOf("FORMAT_VERSION")).toBe("FORMAT");
  });

  it("finds a setting by what it does, not only its name", () => {
    expect(matchesSearch("WP_SPD", m47.params.WP_SPD, "waypoint speed")).toBe(true);
    expect(matchesSearch("WP_SPD", m47.params.WP_SPD, "wp_s")).toBe(true);
    expect(matchesSearch("WP_SPD", m47.params.WP_SPD, "battery")).toBe(false);
  });
});

describe("parameter files", () => {
  it("reads Mission Planner and QGroundControl files", () => {
    const mp = parseParamFile("# saved\nFRAME_CLASS,1\nWP_SPD 10.5\nATC_RAT_RLL_P\t0.135\nnot a line\n");
    expect(mp.format).toBe("mission-planner");
    expect(mp.values).toEqual({ FRAME_CLASS: 1, WP_SPD: 10.5, ATC_RAT_RLL_P: 0.135 });
    expect(mp.bad).toEqual([{ line: 5, text: "not a line" }]);

    const qgc = parseParamFile("# Onboard parameters\n1\t1\tFRAME_CLASS\t1\t2\n1\t1\tWP_SPD\t10\t9\n");
    expect(qgc.format).toBe("qgroundcontrol");
    expect(qgc.values).toEqual({ FRAME_CLASS: 1, WP_SPD: 10 });
    expect(parseParamFile("").format).toBe("empty");
  });

  it("compares a file with the aircraft and holds back what belongs to one board", () => {
    const vehicle = { WP_SPD: 10, FRAME_CLASS: 1, INS_ACCOFFS_X: 0.1, STAT_RUNTIME: 100, COMPASS_DEV_ID: 5, LOG_BITMASK: 0 };
    const file = { WP_SPD: 12, FRAME_CLASS: 1, INS_ACCOFFS_X: 0.3, STAT_RUNTIME: 900, COMPASS_DEV_ID: 7, LOG_BITMASK: 1, Q_ENABLE: 1, RTL_ALT_M: 400 };
    const d = compareParams(file, vehicle, m47, { WP_SPD: 9, FRAME_CLASS: 2 });
    expect(d.same).toBe(1);
    expect(d.missing).toEqual(["Q_ENABLE", "RTL_ALT_M"]);
    const by = Object.fromEntries(d.changed.map((r) => [r.name, r.caution]));
    expect(by).toEqual({ WP_SPD: undefined, INS_ACCOFFS_X: "calibration", STAT_RUNTIME: "read-only", COMPASS_DEV_ID: "read-only", LOG_BITMASK: undefined });
  });

  it("treats float32 rounding as the same value", () => {
    expect(compareParams({ ATC_RAT_RLL_P: 0.135 }, { ATC_RAT_RLL_P: Math.fround(0.135) }, m47).same).toBe(1);
  });
});

describe("the virtual aircraft stores values the way ArduCopter does", () => {
  it("reports whole-number settings as integers and truncates like AP_Param", async () => {
    const { PARAM_TYPES, storedValue } = await import("../../sim/params");
    expect(PARAM_TYPES.FRAME_CLASS).toBeUndefined();
    expect(PARAM_TYPES.FENCE_TYPE).toBe(2);
    expect(storedValue("RTL_ALT", 1500.7)).toBe(1500);
    expect(storedValue("RTL_ALT", 1499.995)).toBe(1500);
    expect(storedValue("DISARM_DELAY", 300)).toBe(127);
    expect(storedValue("WPNAV_SPEED", 0.1)).toBe(Math.fround(0.1));
    // Every integer the simulator declares is documented as a whole-number kind of setting.
    for (const [n, t] of Object.entries(PARAM_TYPES)) expect(checkValue(m46.params[n], 2.5, t).some((c) => c.text.includes("whole")), n).toBe(true);
  });
});
