import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandLink } from "../commandLink";
import { useLink, type VehicleIdentity } from "../../../state/linkStore";
import { useParams } from "../../../state/paramStore";
import { MavlinkParser, decode } from "../../../mavlink/parser";

/*
  Two ways a button could hurt a real aircraft, pinned shut.

  Restarting: never while armed, and never with an ESC calibration waiting,
  because ArduCopter then starts by sending full throttle to its ESCs.

  A list reported as sent: only when the aircraft asked for every item and
  then accepted, not on an acknowledgement left over from before.
*/
const ident = (over: Partial<VehicleIdentity> = {}): VehicleIdentity => ({
  sysid: 1, compid: 1, type: 2, typeLabel: "Quadrotor", autopilot: 3, firmware: "ardupilot", firmwareLabel: "ArduPilot",
  armed: false, mode: null, customMode: 0, systemStatus: "Standby", mavlinkVersion: 3, protocol: 2, ...over,
});

let sent: { name: string; d: Record<string, unknown> }[] = [];
beforeEach(() => {
  sent = [];
  const parser = new MavlinkParser();
  commandLink.attach(async (bytes) => {
    for (const f of parser.push(bytes)) sent.push({ name: f.name, d: decode(f) ?? {} });
  });
  useParams.setState({ values: {} });
});
afterEach(() => {
  commandLink.detach();
  useLink.setState({ vehicle: null, status: "idle", virtual: false });
  useParams.setState({ values: {} });
});

const restarts = () => sent.filter((m) => m.name === "COMMAND_LONG" && m.d.command === 246);

describe("restarting the flight controller", () => {
  it("is sent to a disarmed aircraft with no calibration waiting", async () => {
    useLink.setState({ vehicle: ident(), status: "connected" });
    expect(commandLink.rebootBlock()).toBeNull();
    await commandLink.reboot();
    expect(restarts()).toHaveLength(1);
    expect(restarts()[0].d.param1).toBe(1);
  });

  it("is refused while armed, and nothing is sent", async () => {
    useLink.setState({ vehicle: ident({ armed: true }), status: "connected" });
    await expect(commandLink.reboot()).rejects.toThrow(/Disarm before restarting/);
    expect(sent).toHaveLength(0);
  });

  it("is refused with an ESC calibration waiting: the next start sends full throttle", async () => {
    useLink.setState({ vehicle: ident(), status: "connected" });
    for (const mode of [2, 3]) {
      useParams.setState({ values: { ESC_CALIBRATION: mode } });
      await expect(commandLink.reboot()).rejects.toThrow(/ESC calibration is waiting/);
    }
    expect(sent).toHaveLength(0);
    // 0 is no calibration, 9 is calibration switched off, 1 needs the stick held high as it starts.
    for (const mode of [0, 1, 9]) {
      useParams.setState({ values: { ESC_CALIBRATION: mode } });
      expect(commandLink.rebootBlock()).toBeNull();
    }
  });

  it("does not hold the virtual aircraft to the ESC rule: it has no ESCs", () => {
    useLink.setState({ vehicle: ident(), status: "connected", virtual: true });
    useParams.setState({ values: { ESC_CALIBRATION: 3 } });
    expect(commandLink.rebootBlock()).toBeNull();
  });
});

describe("a list is sent only when the aircraft took all of it", () => {
  const item = (seq: number) => ({ seq, frame: 3, command: 16, p1: 0, p2: 0, p3: 0, p4: 0, x: 230000000 + seq, y: 720000000, z: 10 });

  it("ignores an acknowledgement that arrives before the items were asked for", async () => {
    useLink.setState({ vehicle: ident(), status: "connected", virtual: true });
    let settled: "sent" | "failed" | null = null;
    const up = commandLink.uploadMission([item(0), item(1), item(2)]).then(
      () => (settled = "sent"),
      () => (settled = "failed"),
    );
    // Left over from an earlier exchange.
    commandLink.handle("MISSION_ACK", { type: 0, mission_type: 0 });
    await Promise.resolve();
    expect(settled).toBeNull();
    // The real exchange: each item asked for, then accepted.
    for (const seq of [0, 1, 2]) commandLink.handle("MISSION_REQUEST_INT", { seq, mission_type: 0 });
    commandLink.handle("MISSION_ACK", { type: 0, mission_type: 0 });
    await up;
    expect(settled).toBe("sent");
    expect(sent.filter((m) => m.name === "MISSION_ITEM_INT")).toHaveLength(3);
  });

  it("still takes the acknowledgement of an empty list, which clears the aircraft's own", async () => {
    useLink.setState({ vehicle: ident(), status: "connected", virtual: true });
    const up = commandLink.uploadFence([]);
    commandLink.handle("MISSION_ACK", { type: 0, mission_type: 1 });
    await expect(up).resolves.toBeUndefined();
  });
});

describe("a list with a value that is not a number is never sent", () => {
  const item = (seq: number, over: Record<string, number> = {}) => ({ seq, frame: 3, command: 16, p1: 0, p2: 0, p3: 0, p4: 0, x: 230000000, y: 720000000, z: 10, ...over });

  it("refuses NaN, infinity, a place off the Earth and items out of order, sending nothing", async () => {
    useLink.setState({ vehicle: ident(), status: "connected", virtual: true });
    await expect(commandLink.uploadMission([item(0), item(1, { z: NaN })])).rejects.toThrow(/not a number/);
    await expect(commandLink.uploadMission([item(0), item(1, { p1: Infinity })])).rejects.toThrow(/not a number/);
    await expect(commandLink.uploadMission([item(0), item(1, { x: 95e7 })])).rejects.toThrow(/not at a place on the Earth/);
    await expect(commandLink.uploadFence([item(0), item(2)])).rejects.toThrow(/not numbered in order/);
    expect(sent).toHaveLength(0);
  });
});
