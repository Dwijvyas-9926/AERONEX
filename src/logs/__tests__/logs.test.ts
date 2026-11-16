import { describe, expect, it } from "vitest";
import { encode } from "../../mavlink/encode";
import { looksLikeDataflash, parseDataflash } from "../dataflash";
import { toCsv, toKml, toParamFile, toReport } from "../export";
import { cellCount } from "../analyze";
import { LogFormatError, loadLog } from "../load";
import { buildFlight, indexAt, valueAt, type Flight } from "../model";
import { replayAt, replayHome } from "../replay";
import { fieldPanel, panelsFor, PRESETS } from "../series";
import { looksLikeTlog, parseTlog, tlogRecord } from "../tlog";
import { num, text } from "../types";
import { DfWriter } from "./dfwriter";
import { synthLog, type Synth } from "./synth";

const run = (o: Synth = {}) => loadLog(synthLog(o), "test.bin");
const ids = (o: Synth) => run(o).analysis.findings.map((f) => `${f.severity}:${f.id}`);

describe("DataFlash reader", () => {
  it("reads every format character the way pymavlink does", () => {
    // A format string holds at most 16 characters, so the characters are split over two types.
    const w = new DfWriter().define(200, "TEST", "QbBhHiIfdcCeEL", "TimeUS,b,B,h,H,i,I,f,d,c,C,e,E,L").define(202, "TXT", "QMqZn", "TimeUS,M,q,Z,n");
    w.write(200, [5_000_000, -5, 250, -30000, 60000, -2e9, 4e9, 1.5, 1e-9, -12.34, 600.5, -123456.78, 9876543.21, -35.1234567]);
    w.write(202, [5_000_000, 7, -9e15, "hello world", "ABCD"]);
    w.write(200, [6_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const log = parseDataflash(w.buffer(), "t.bin");
    const t = log.tables.get("TEST")!;
    const tx = log.tables.get("TXT")!;
    expect(t.count).toBe(2);
    const v = (f: string) => num(t, f)![0];
    expect([v("b"), v("B"), v("h"), v("H"), v("i"), v("I")]).toEqual([-5, 250, -30000, 60000, -2e9, 4e9]);
    expect(v("f")).toBe(1.5);
    expect(v("d")).toBe(1e-9);
    expect(v("c")).toBeCloseTo(-12.34, 6);
    expect(v("C")).toBeCloseTo(600.5, 6);
    expect(v("e")).toBeCloseTo(-123456.78, 4);
    expect(v("E")).toBeCloseTo(9876543.21, 4);
    expect(v("L")).toBeCloseTo(-35.1234567, 7);
    expect(num(tx, "M")![0]).toBe(7);
    expect(num(tx, "q")![0]).toBe(-9e15);
    expect(text(tx, "Z")![0]).toBe("hello world");
    expect(text(tx, "n")![0]).toBe("ABCD");
    // Seconds from the first timestamp.
    expect(t.t[0]).toBe(0);
    expect(t.t[1]).toBe(1);
    expect(log.stats.skipped).toBe(0);
    expect(log.stats.truncated).toBe(false);
  });

  it("decodes half-precision floats (g, ArduPilot 4.7)", () => {
    const w = new DfWriter().define(201, "HALF", "Qggggg", "TimeUS,a,b,c,d,e");
    // 1.0, -2.0, 0.5, 65504 (largest), 2^-24 (smallest subnormal)
    w.write(201, [1, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x0001]);
    const t = parseDataflash(w.buffer(), "h.bin").tables.get("HALF")!;
    expect(["a", "b", "c", "d", "e"].map((f) => num(t, f)![0])).toEqual([1, -2, 0.5, 65504, 2 ** -24]);
  });

  it("steps over junk and a torn message, and counts them", () => {
    const w = new DfWriter().define(200, "A", "QI", "TimeUS,V");
    w.write(200, [1, 1]).raw([1, 2, 3, 0xa3, 0x95]).write(200, [2, 2]).raw([0xa3, 0x95, 200, 9, 9]);
    const log = parseDataflash(w.buffer(), "j.bin");
    const t = log.tables.get("A")!;
    expect(Array.from(num(t, "V")!)).toEqual([1, 2]);
    expect(log.stats.skipped).toBeGreaterThan(0);
    expect(log.stats.corruptSpans).toBeGreaterThanOrEqual(1);
    expect(log.stats.truncated).toBe(true);
  });

  it("takes units, multipliers and the instance field from FMTU", () => {
    const log = parseDataflash(synthLog(), "s.bin");
    const mag = log.tables.get("MAG")!;
    expect(mag.fields[mag.instance]).toBe("I");
    expect(mag.units[mag.fields.indexOf("MagX")]).toBe("Gauss");
    expect(mag.mults[mag.fields.indexOf("MagX")]).toBeCloseTo(0.001);
    const pm = log.tables.get("PM")!;
    expect(pm.scales[pm.fields.indexOf("Load")]).toBe("×0.1");
  });

  it("recognises a log by its first bytes, and refuses what is not one", () => {
    expect(looksLikeDataflash(new Uint8Array(synthLog()))).toBe(true);
    expect(looksLikeDataflash(new Uint8Array(1000))).toBe(false);
    expect(() => loadLog(new Uint8Array(4000).fill(7).buffer, "eeprom.bin")).toThrow(LogFormatError);
    expect(() => loadLog(new ArrayBuffer(0), "x.bin")).toThrow(/empty/);
  });

  it("starts the log's clock from GPS week and milliseconds, less the leap seconds", () => {
    const w = new DfWriter().define(73, "GPS", "QBBIHBcLLeffff", "TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw");
    w.write(73, [5e6, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // 2026-11-16 12:00:00 UTC is GPS week 2445, 129618000 ms into it (18 leap seconds).
    w.write(73, [6e6, 0, 3, 129618000, 2445, 12, 0.8, 1, 1, 0, 0, 0, 0, 0]);
    const log = parseDataflash(w.buffer(), "g.bin");
    expect(new Date(log.startUtc!).toISOString()).toBe("2026-11-16T11:59:59.000Z");
  });
});

describe("telemetry log reader", () => {
  const rec = (us: number, name: string, fields: Record<string, number | string | number[]>, sys = 1, comp = 1) => tlogRecord(us, encode(name, fields, { sysid: sys, compid: comp }));
  const t0 = Date.UTC(2026, 10, 16, 12) * 1000;

  it("reads records, checks every packet, and keeps who sent it", () => {
    const parts = [
      rec(t0, "HEARTBEAT", { custom_mode: 5, type: 2, autopilot: 3, base_mode: 128 | 1, system_status: 4, mavlink_version: 3 }),
      rec(t0 + 100_000, "ATTITUDE", { time_boot_ms: 1, roll: 0.1, pitch: -0.2, yaw: 3, rollspeed: 0, pitchspeed: 0, yawspeed: 0 }),
      rec(t0 + 150_000, "HEARTBEAT", { custom_mode: 0, type: 6, autopilot: 8, base_mode: 0, system_status: 0, mavlink_version: 3 }, 255, 190),
      rec(t0 + 200_000, "STATUSTEXT", { severity: 2, text: "Crash: Disarming" }),
    ];
    // A damaged record in the middle: the timestamp is fine, the packet's checksum is not.
    const bad = rec(t0 + 120_000, "ATTITUDE", { time_boot_ms: 2, roll: 0, pitch: 0, yaw: 0, rollspeed: 0, pitchspeed: 0, yawspeed: 0 });
    bad[bad.length - 1] ^= 0xff;
    const all = [parts[0], parts[1], bad, parts[2], parts[3]];
    const buf = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of all) {
      buf.set(p, o);
      o += p.length;
    }
    expect(looksLikeTlog(buf)).toBe(true);
    const log = parseTlog(buf.buffer, "t.tlog");
    expect(log.stats.messages).toBe(4);
    expect(log.stats.skipped).toBeGreaterThan(0);
    const att = log.tables.get("ATTITUDE")!;
    expect(num(att, "roll")![0]).toBeCloseTo(0.1, 6);
    expect(att.t[0]).toBeCloseTo(0.1, 6);
    expect(log.startUtc).toBe(t0 / 1000);
    expect(Array.from(num(log.tables.get("HEARTBEAT")!, "sysid")!)).toEqual([1, 255]);
    const f = buildFlight(log);
    // The ground station's own heartbeat is not the aircraft's.
    expect(f.sysid).toBe(1);
    expect(f.modes.map((m) => m.name)).toEqual(["Loiter"]);
    expect(f.att!.roll[0]).toBeCloseTo((0.1 * 180) / Math.PI, 4);
    expect(f.timeline.some((it) => it.kind === "message" && it.tone === "bad" && /Crash/.test(it.text))).toBe(true);
    expect(f.vehicle).toBe("copter");
  });
});

describe("the flight model", () => {
  it("builds the flight from a .bin", () => {
    const { flight: f } = run();
    expect(f.firmware).toBe("ArduCopter V4.7.2 (test)");
    expect(f.version).toEqual([4, 7, 2]);
    expect(f.motors).toBe(4);
    expect(f.armed).toHaveLength(1);
    expect(f.armed[0].from).toBeCloseTo(1, 1);
    expect(f.armed[0].to).toBeCloseTo(104, 1);
    expect(f.flying[0].from).toBeCloseTo(3, 1);
    expect(f.flying[0].to).toBeCloseTo(100, 1);
    expect(f.gps).toHaveLength(1);
    expect(f.vibe.map((v) => v.imu)).toEqual([0, 1]);
    // XKF4 has two lanes; only the primary is kept.
    expect(f.ekf!.t.length).toBe(f.vibe[0].t.length);
    // Compass in milligauss as stored.
    expect(f.mag[0].z[0]).toBe(380);
    // PM.Load is tenths of a percent: 300 → 30 %.
    expect(f.load!.load[0]).toBeCloseTo(30);
    expect(f.home!.lat).toBeCloseTo(23.0225, 7);
    expect(f.home!.lng).toBeCloseTo(72.5714, 7);
    expect(f.home!.alt).toBeCloseTo(53, 2);
    expect(f.modes.map((m) => m.name)).toEqual(["Loiter", "Land"]);
  });

  it("interpolates and finds samples by time", () => {
    const t = Float64Array.from([0, 1, 2, 3]);
    const v = Float64Array.from([0, 10, 20, 30]);
    expect(indexAt(t, 1.5)).toBe(1);
    expect(indexAt(t, -1)).toBe(0);
    expect(indexAt(t, 9)).toBe(3);
    expect(valueAt(t, v, 1.25)).toBeCloseTo(12.5);
    expect(valueAt(t, v, 4)).toBeNaN();
  });

  it("replays position, attitude and heading the short way round", () => {
    const { flight: f } = run();
    const home = replayHome(f)!;
    expect(home.lat).toBeCloseTo(23.0225, 6);
    const s = replayAt(f, 50, home);
    expect(s.altRel).toBeCloseTo(20, 1);
    expect(s.n).toBeGreaterThan(40);
    expect(s.armed && s.flying).toBe(true);
    expect(s.mode).toBe("Loiter");
    const att = f.att!;
    att.yaw[100] = 359;
    att.yaw[101] = 1;
    const mid = replayAt(f, (att.t[100] + att.t[101]) / 2, home);
    expect(Math.min(mid.yaw, 360 - mid.yaw)).toBeLessThan(0.01);
  });
});

describe("the checks", () => {
  it("finds nothing wrong in a clean flight", () => {
    const { analysis: a } = run();
    expect(a.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(a.verdict).toBe("pass");
    expect(a.checks.filter((c) => c.status === "skipped").map((c) => c.id)).toEqual([]);
    expect(a.summary.flightTime).toBeCloseTo(97, 0);
    expect(a.summary.maxAltRel).toBeCloseTo(20, 1);
    expect(a.summary.maxFromHome).toBeGreaterThan(55);
    expect(a.summary.maxFromHome).toBeLessThan(65);
    expect(a.summary.distance).toBeGreaterThan(110);
    expect(a.summary.cells).toBe(4);
  });

  it("vibration: over 30 is a warning, over 60 a problem", () => {
    expect(ids({ vibe: 25 })).not.toContain("warn:vibe.high.0");
    expect(ids({ vibe: 40 })).toContain("warn:vibe.high.0");
    expect(ids({ vibe: 70 })).toContain("fail:vibe.high.0");
  });

  it("clipping: any in flight is a warning, a hundred or more a problem", () => {
    expect(ids({ clips: 20 })).toContain("warn:vibe.clip.0");
    expect(ids({ clips: 500 })).toContain("fail:vibe.clip.0");
    expect(ids({ clips: 500 })).not.toContain("fail:vibe.clip.1");
  });

  it("a motor failing: attitude lost, a motor at full output, the aircraft down", () => {
    const got = ids({ motorFailAt: 40 });
    expect(got).toContain("fail:control.attitude.lost");
    expect(got).toContain("fail:motors.saturated");
    const at = run({ motorFailAt: 40 }).analysis.findings.find((f) => f.id === "control.attitude.lost")!.at!;
    expect(at).toBeGreaterThanOrEqual(40);
    expect(at).toBeLessThan(41.5);
  });

  it("motor balance: averages more than 75 µs apart warn, 150 fail", () => {
    expect(ids({ motorBias: 60 })).not.toContain("warn:motors.imbalance");
    expect(ids({ motorBias: 100 })).toContain("warn:motors.imbalance");
    expect(ids({ motorBias: 180 })).toContain("fail:motors.imbalance");
  });

  it("loose tuning shows as attitude straying from the target", () => {
    expect(ids({ wobble: 14 })).toContain("warn:control.attitude.off");
  });

  it("a log that stops in the air is a power loss", () => {
    const got = ids({ endAt: 60 });
    expect(got).toContain("fail:flight.end.airborne");
  });

  it("GPS: fix lost, too few satellites, poor HDOP, and the EKF rejecting it", () => {
    const got = ids({ gpsLost: [40, 50] });
    expect(got).toContain("fail:gps.lost.0");
    expect(got).toContain("fail:gps.sats.0");
    expect(got).toContain("fail:ekf.posH.reject");
    expect(ids({ sats: 8 })).toContain("warn:gps.sats.0");
    expect(ids({ hdop: 2.5 })).toContain("warn:gps.hdop.0");
  });

  it("compass: field strength changing more than 25% warns, 35% fails, outside 120–550 warns", () => {
    expect(ids({ magPerThrottle: 80 }).filter((x) => x.includes("compass"))).toEqual([]);
    expect(ids({ magPerThrottle: 650 })).toContain("warn:compass.change.0");
    expect(ids({ magPerThrottle: 650 })).toContain("warn:compass.length.0");
    expect(ids({ magPerThrottle: 1200 })).toContain("fail:compass.change.0");
    // Not used for navigation: a note, not a problem.
    expect(ids({ magPerThrottle: 1200, params: { COMPASS_USE: 0 } })).toContain("info:compass.change.0");
  });

  it("battery: low per-cell voltage, sag, and capacity used", () => {
    expect(ids({ cells: 4, sagPerAmp: 0.035 })).toContain("fail:battery.low");
    expect(ids({ cells: 4, sagPerAmp: 0.028 })).toContain("warn:battery.low");
    expect(ids({ cells: 4, sagPerAmp: 0.025 })).toContain("warn:battery.sag");
    expect(ids({ params: { BATT_CAPACITY: 800 } })).toContain("warn:battery.capacity");
    expect(ids({ params: { BATT_CAPACITY: 700 } })).toContain("fail:battery.capacity");
  });

  it("board voltage outside 4.3–5.8 V, or swinging", () => {
    expect(ids({ vcc: 4.1 })).toContain("fail:power.vcc.range");
    expect(ids({ vcc: 4.5 })).toContain("warn:power.vcc.low");
    expect(ids({ vcc: 5.0 }).filter((x) => x.includes("power"))).toEqual([]);
    expect(ids({ vccDip: 0.5 })).toContain("warn:power.vcc.swing");
  });

  it("decodes failsafes and errors, and mode changes the autopilot made itself", () => {
    const got = ids({ errors: [[60, 6, 1], [60, 5, 1], [61, 5, 0]], modes: [[0.5, 5, 1], [60, 6, 4]] });
    expect(got).toContain("fail:err.6001");
    expect(got).toContain("fail:err.5001");
    expect(got).not.toContain("fail:err.5000");
    expect(got.some((x) => x.startsWith("fail:mode.failsafe."))).toBe(true);
    const crash = ids({ errors: [[70, 12, 1]] });
    expect(crash).toContain("fail:flight.crash.detected");
  });

  it("settings that leave the aircraft unprotected", () => {
    const got = ids({ params: { FS_THR_ENABLE: 0, BATT_FS_LOW_ACT: 0, ARMING_SKIPCHK: 3, INS_HNTCH_ENABLE: 0 } });
    expect(got).toEqual(expect.arrayContaining(["warn:setup.radiofs", "warn:setup.battfs", "warn:setup.arming", "info:setup.notch"]));
  });

  it("orders findings worst first, then by time", () => {
    const a = run({ vibe: 40, endAt: 70, errors: [[20, 11, 2]] }).analysis;
    const sev = a.findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((x, y) => ["fail", "warn", "info"].indexOf(x) - ["fail", "warn", "info"].indexOf(y)));
    expect(a.verdict).toBe("fail");
  });

  it("counts battery cells from the parameter, or the fewest that fit the starting voltage", () => {
    const at = (v: number, vmax?: number) =>
      cellCount({ params: new Map(vmax ? [["MOT_BAT_VOLT_MAX", { name: "MOT_BAT_VOLT_MAX", value: vmax, last: vmax, default: null, changes: [] }]] : []), bat: [{ volt: Float64Array.of(v) }] } as unknown as Flight)?.cells;
    expect([at(8.4), at(12.6), at(11.1), at(16.8), at(15.2), at(14), at(22.2), at(25.2), at(26.1), at(50.4)]).toEqual([2, 3, 3, 4, 4, 4, 6, 6, 6, 12]);
    expect(at(14, 25.2)).toBe(6);
  });

  it("reports every check, run or skipped, with what it measured", () => {
    const a = run().analysis;
    expect(a.checks.length).toBe(15);
    for (const c of a.checks) expect(c.note.length).toBeGreaterThan(3);
  });
});

describe("charts and exports", () => {
  it("every chart set has data in a full log, in one unit per panel", () => {
    const { flight: f } = run();
    for (const p of PRESETS) {
      const panels = panelsFor(f, p.id);
      expect(panels.length, p.id).toBeGreaterThan(0);
      for (const panel of panels) for (const s of panel.series) expect(s.t.length).toBe(s.v.length);
    }
    // A raw field, split by instance, scaled to its unit.
    const mag = fieldPanel(f.raw.tables.get("MAG")!, "MagZ")!;
    expect(mag.unit).toBe("Gauss");
    expect(mag.series[0].v[0]).toBeCloseTo(0.38);
  });

  it("writes KML, .param, CSV and a report", () => {
    const { flight: f, analysis: a } = run({ vibe: 40 });
    const kml = toKml(f);
    expect(kml).toContain("<coordinates>");
    expect(kml).toMatch(/72\.5714000,23\.02\d+,\d+\.\d\d/);
    const par = toParamFile(f);
    expect(par).toMatch(/^BATT_CAPACITY,5000$/m);
    expect(par).toMatch(/^FS_EKF_THRESH,0\.8$/m);
    const csv = toCsv(f.raw.tables.get("MSG")!);
    expect(csv.split("\n")[0]).toBe("time_s,TimeUS,Message");
    const rep = toReport(f, a);
    expect(rep).toContain("WARNING: IMU 1 vibration is high: 40 m/s²");
    expect(rep).toContain("| Vibration within limits | warn |");
  });
});
