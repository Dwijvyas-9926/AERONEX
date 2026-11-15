import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, sameZones, snap, zonesToWire, type FenceZone } from "../../../geo/fence";
import { toGlobal } from "../../../geo/geo";
import { MavlinkParser, decode } from "../../../mavlink/parser";
import { PRESETS } from "../../../sim/airframe";
import { VirtualVehicle } from "../../../sim/vehicle";
import { useLink, type VehicleIdentity } from "../../../state/linkStore";
import { useParams } from "../../../state/paramStore";
import { commandLink } from "../commandLink";
import { readFence, sendFence } from "../fenceLink";

/*
  A fence sent and read back over MAVLink, end to end: the app's command link
  on one side, the virtual aircraft on the other, every byte through the
  encoder and the parser. The same exchange is run against ArduCopter itself
  in sitl/fence.test.ts.
*/

const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const at = (n: number, e: number) => snap(toGlobal(HOME, n, e));
const box = (role: "in" | "out", cn: number, ce: number, half: number, id = `${role}${cn}${ce}`): FenceZone => ({
  id, shape: "polygon", role, points: [at(cn - half, ce - half), at(cn - half, ce + half), at(cn + half, ce + half), at(cn + half, ce - half)],
});
const ring = (role: "in" | "out", corners: number, cn: number, r: number, id: string): FenceZone => ({
  id, shape: "polygon", role, points: Array.from({ length: corners }, (_, k) => at(cn + r * Math.cos((2 * Math.PI * k) / corners), r * Math.sin((2 * Math.PI * k) / corners))),
});

const ident: VehicleIdentity = {
  sysid: 1, compid: 1, type: 2, typeLabel: "Quadrotor", autopilot: 3, firmware: "ardupilot", firmwareLabel: "ArduPilot",
  armed: false, mode: null, customMode: 0, systemStatus: "Standby", mavlinkVersion: 3, protocol: 2,
};

let v: VirtualVehicle;
let pump: ReturnType<typeof setInterval>;
let sent: string[] = [];

beforeEach(() => {
  v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME });
  sent = [];
  const fromApp = new MavlinkParser();
  const fromVehicle = new MavlinkParser();
  commandLink.attach(async (bytes) => {
    for (const f of fromApp.push(bytes)) {
      const d = decode(f) ?? {};
      sent.push(f.name === "PARAM_SET" ? `PARAM_SET ${String(d.param_id)}` : f.name);
    }
    v.receive(bytes);
  });
  useLink.setState({ vehicle: ident, status: "connected", virtual: false });
  useParams.getState().reset();
  // The aircraft runs, and everything it says reaches the app.
  pump = setInterval(() => {
    v.advance(0.05, 0.05, false);
    for (const f of fromVehicle.push(v.drain())) {
      const d = decode(f);
      if (!d) continue;
      if (f.name === "PARAM_VALUE") useParams.getState().onParamValue(String(d.param_id), d.param_value as number, d.param_count as number, d.param_type as number);
      commandLink.handle(f.name, d);
    }
  }, 2);
});

afterEach(() => {
  clearInterval(pump);
  commandLink.detach();
  useLink.setState({ vehicle: null, status: "idle", virtual: false });
});

const zones = [box("in", 0, 0, 300, "a"), { id: "b", shape: "circle", role: "out", centre: at(100, 100), radiusM: 25.5 } as FenceZone, box("out", -100, 50, 20, "c")];

describe("sending and reading a fence", () => {
  it("sends the zones and settings, turns the fence on last, and reads back the same", async () => {
    await commandLink.requestAllParams();
    const limits = { ...DEFAULT_LIMITS, FENCE_ENABLE: 1, FENCE_ALT_MAX: 80, FENCE_ACTION: 2, FENCE_MARGIN: 3 };
    const steps: string[] = [];
    const got = await sendFence({ zones, limits }, (s) => steps.push(s));
    expect(sameZones(got.zones, zones)).toBe(true);
    expect(got.limits).toMatchObject({ FENCE_ENABLE: 1, FENCE_ALT_MAX: 80, FENCE_ACTION: 2, FENCE_MARGIN: 3 });
    expect(v.ap.fence).toEqual(zonesToWire(zones).map((w) => ({ ...w, p1: Math.fround(w.p1) })));
    expect(v.ap.params.FENCE_ENABLE).toBe(1);
    // The switch goes last, after the zones are read back and the limits are in.
    const writes = sent.filter((s) => s.startsWith("PARAM_SET"));
    expect(writes[writes.length - 1]).toBe("PARAM_SET FENCE_ENABLE");
    expect(sent.indexOf("MISSION_COUNT")).toBeLessThan(sent.indexOf("PARAM_SET FENCE_ENABLE"));
    expect(steps).toContain("Reading the zones back");

    const back = await readFence();
    expect(sameZones(back.zones, zones)).toBe(true);
    expect(back.limits.FENCE_ALT_MAX).toBe(80);
  });

  it("turns the fence off before changing its zones", async () => {
    await commandLink.requestAllParams();
    await sendFence({ zones, limits: { ...DEFAULT_LIMITS, FENCE_ENABLE: 1 } });
    sent = [];
    await sendFence({ zones: [], limits: { ...DEFAULT_LIMITS, FENCE_ENABLE: 0 } });
    expect(sent.indexOf("PARAM_SET FENCE_ENABLE")).toBeLessThan(sent.indexOf("MISSION_COUNT"));
    expect(v.ap.fence).toEqual([]);
  });

  it("reports the aircraft's own reason when it refuses a fence too big for its storage", async () => {
    // Seven areas of ten corners: 70 items, within the count a Pixhawk takes, but 579 bytes of its 560.
    const many = Array.from({ length: 7 }, (_, k) => ring("out", 10, 200 + k * 100, 30, `r${k}`));
    await expect(sendFence({ zones: many, limits: DEFAULT_LIMITS })).rejects.toThrow(/Fence exceeds storage size/);
    expect(v.ap.fence).toEqual([]);
  });

  it("is refused outright when the count is more than the aircraft can hold", async () => {
    const many = Array.from({ length: 8 }, (_, k) => ring("out", 10, 200 + k * 100, 30, `r${k}`));
    await expect(commandLink.uploadFence(zonesToWire(many))).rejects.toThrow(/no room for that many items/);
  });

  it("will not change the fence of an armed real aircraft", async () => {
    useLink.setState({ vehicle: { ...ident, armed: true } });
    await expect(commandLink.uploadFence(zonesToWire(zones))).rejects.toThrow(/Disarm before changing the fence/);
    expect(sent).not.toContain("MISSION_COUNT");
  });

  it("keeps the mission and the fence apart", async () => {
    await sendFence({ zones, limits: DEFAULT_LIMITS });
    expect(await commandLink.downloadMission()).toEqual([]);
    expect(v.ap.fence.length).toBe(zonesToWire(zones).length);
  });
});
