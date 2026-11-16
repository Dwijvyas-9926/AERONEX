import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../../geo/fence";
import type { VehicleIdentity } from "../../../state/linkStore";
import { buildLiveContext, type LiveInput } from "../context";
import { apiTurns, type Turn } from "../store";
import { searchManual } from "../offline";

const NOW = 1_800_000_000_000;
const at = <T,>(value: T, age = 0) => ({ value, at: NOW - age });
const copter: VehicleIdentity = { sysid: 1, compid: 1, type: 2, typeLabel: "Quadrotor", autopilot: 3, firmware: "ardupilot", firmwareLabel: "ArduPilot", armed: false, mode: "STABILIZE", customMode: 0, systemStatus: "STANDBY", mavlinkVersion: 3, protocol: 2 };

const input = (over: Partial<LiveInput> = {}): LiveInput => ({
  now: NOW,
  path: "/keyboard-flight",
  share: true,
  status: "connected",
  virtual: false,
  vehicle: copter,
  telemetry: {
    gps: at({ fixType: 3, satellites: 7, hdop: 1.8 }),
    position: at({ lat: 23.0225123, lon: 72.5714456, relAlt: 0.2, mslAlt: 53, heading: 90 }),
    battery: at({ voltage: 16.4, current: 1.2, remaining: 88 }),
    home: at({ lat: 23.0225123, lon: 72.5714456, altMsl: 53 }),
  },
  events: [{ id: 1, at: NOW - 2000, level: "vehicle", text: "PreArm: Compass not calibrated" }],
  params: { FS_GCS_ENABLE: 0, RTL_ALT_M: 30, FRAME_CLASS: 1, ARMING_SKIPCHK: 0, WP_SPD: 5 },
  paramCount: 1370,
  plan: { points: [{ id: "a", n: 50, e: 0, alt: 20, holdS: 0 }], ending: "rtl", takeoffAlt: 10 },
  fence: { zones: [], limits: { ...DEFAULT_LIMITS }, sentAndSame: null },
  ...over,
});

describe("the live snapshot", () => {
  it("names the page and the aircraft, with its readings and settings", () => {
    const c = buildLiveContext(input());
    expect(c).toContain("Page open: Keyboard Flight (#/keyboard-flight).");
    expect(c).toContain("a physical flight controller");
    expect(c).toContain("ArduCopter: AERONEX can command it");
    expect(c).toContain("4.7 or later");
    expect(c).toContain("7 satellites");
    expect(c).toContain("16.40 V");
    expect(c).toContain('"Compass not calibrated"');
    expect(c).toContain("FS_GCS_ENABLE=0");
    expect(c).toContain("RTL_ALT=3000"); // 30 m as the older name has it, in cm
    expect(c).toContain("arming checks: all");
    expect(c).toContain("1 waypoint");
    expect(c).toContain("Fence in AERONEX's Fence tab: off");
  });

  it("never gives away where the aircraft is", () => {
    const c = buildLiveContext(input());
    expect(c).not.toMatch(/23\.02|72\.57/);
  });

  it("says when the aircraft is not one AERONEX commands", () => {
    const c = buildLiveContext(input({ vehicle: { ...copter, autopilot: 12, firmware: "px4", firmwareLabel: "PX4" } }));
    expect(c).toContain("NOT ArduCopter");
  });

  it("leaves out readings that have stopped, and says the GPS has", () => {
    const c = buildLiveContext(input({ telemetry: { gps: at({ fixType: 3, satellites: 12, hdop: 0.8 }, 60_000) } }));
    expect(c).toContain("GPS stopped reporting");
    expect(c).not.toContain("12 satellites");
  });

  it("says the data is simulated on the virtual aircraft", () => {
    expect(buildLiveContext(input({ virtual: true }))).toContain("virtual aircraft (simulated");
  });

  it("holds nothing about the aircraft when sharing is off", () => {
    const c = buildLiveContext(input({ share: false }));
    expect(c).toContain("turned off sharing");
    expect(c).not.toContain("satellites");
    expect(c).not.toContain("FS_GCS_ENABLE");
  });

  it("says when nothing is linked", () => {
    expect(buildLiveContext(input({ vehicle: null, status: "idle" }))).toContain("no aircraft linked");
  });
});

describe("the conversation sent back", () => {
  it("leaves out a question whose answer failed, and keeps a stopped answer's words", () => {
    const turns: Turn[] = [
      { id: 1, role: "user", content: "a", at: 0 },
      { id: 2, role: "assistant", content: [{ type: "text", text: "A" }], at: 0, status: "done" },
      { id: 3, role: "user", content: "b", at: 0 },
      { id: 4, role: "assistant", content: [], at: 0, status: "error", error: "x" },
      { id: 5, role: "user", content: "c", at: 0 },
      { id: 6, role: "assistant", content: [{ type: "text", text: "half" }, { type: "server_tool_use", id: "s", name: "web_search", input: {} }], at: 0, status: "stopped" },
    ];
    const m = apiTurns(turns);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(m[2].content).toBe("c");
    expect(m[3].content).toMatch(/^half\n\n\(The person stopped/);
  });
});

describe("the manual searched without the AI", () => {
  const top = (q: string) => searchManual(q)[0]?.topic.id;
  it("finds the right page for common questions", () => {
    expect(["page:/keyboard-flight", "keyboard-howto"]).toContain(top("how to fly my pixhawk 2.4.8 using the keyboard flight feature"));
    expect(top("geofence keep out zone")).toBe("page:/missions");
    expect(top("baud rate radio no data")).toBe("page:/connection");
    expect(top("export dxf laser cut")).toBe("page:/frame-studio");
    expect(top("pid wobble")).toBe("page:/pid");
    expect(top("flash firmware")).toBe("page:/firmware");
    expect(top("pixhawk1-1M bootloader")).toBe("page:/firmware");
  });

  it("returns at most one passage per topic, and nothing for nothing", () => {
    const hits = searchManual("calibration compass accelerometer", 5);
    expect(new Set(hits.map((h) => h.topic.id)).size).toBe(hits.length);
    expect(searchManual("the and of")).toEqual([]);
  });

  it("includes the open flight log's findings, unless sharing is off", async () => {
    const { loadLog } = await import("../../../logs/load");
    const { logBrief } = await import("../../../logs/export");
    const { synthLog } = await import("../../../logs/__tests__/synth");
    const l = loadLog(synthLog({ vibe: 45 }), "flight.bin");
    const brief = logBrief(l.flight, l.analysis, "flight.bin");
    const c = buildLiveContext(input({ path: "/logs", log: brief }));
    expect(c).toContain("Flight log open in Flight Logs");
    expect(c).toMatch(/\[CHECK\] IMU 1 vibration is high: 45 m\/s²/);
    expect(buildLiveContext(input({ path: "/logs", log: brief, share: false }))).not.toContain("vibration");
  });
});
