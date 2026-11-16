import { describe, expect, it } from "vitest";
import { encode } from "../../mavlink/encode";
import { decode, MavlinkParser, type Decoded } from "../../mavlink/parser";
import { VehicleSession } from "../../services/link/vehicleSession";
import { boardFor, checkOutputs, readOutputs } from "../../servo/model";
import { PRESETS } from "../airframe";
import { VirtualVehicle } from "../vehicle";

/*
  The virtual aircraft's servo outputs, put through the same situations as
  real ArduCopter in sitl/servo.test.ts: it must answer the same way.
*/
const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };
const GCS = { sysid: 255, compid: 190 };

function rig() {
  const v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME });
  const parser = new MavlinkParser();
  const session = new VehicleSession(() => 0);
  const got: { name: string; d: Decoded }[] = [];
  const pump = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) {
      v.receive(encode("HEARTBEAT", { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 }, GCS));
      v.advance(0.05, 0.05);
      const bytes = v.drain();
      session.ingest(bytes);
      for (const f of parser.push(bytes)) got.push({ name: f.name, d: decode(f)! });
    }
  };
  const send = (name: string, fields: Record<string, number | string | number[]>) => v.receive(encode(name, { target_system: 1, target_component: 1, ...fields }, GCS));
  const cmd = (command: number, p: number[] = []) => send("COMMAND_LONG", { command, confirmation: 0, param1: p[0] ?? 0, param2: p[1] ?? 0, param3: p[2] ?? 0, param4: p[3] ?? 0, param5: p[4] ?? 0, param6: p[5] ?? 0, param7: p[6] ?? 0 });
  const set = (id: string, value: number) => send("PARAM_SET", { param_id: id, param_value: value, param_type: 9 });
  const ack = (command: number) => [...got].reverse().find((g) => g.name === "COMMAND_ACK" && g.d.command === command)?.d.result;
  const out = (n: number) => session.telemetry.servo?.value.pwm[n - 1];
  const rc = (ch: Record<number, number>) => {
    const f: Record<string, number> = {};
    for (let i = 1; i <= 18; i++) f[`chan${i}_raw`] = ch[i] ?? (i <= 8 ? 65535 : 0);
    send("RC_CHANNELS_OVERRIDE", f);
  };
  return { v, got, pump, cmd, set, ack, out, rc, session };
}

describe("the virtual aircraft's servo outputs", () => {
  it("reports its outputs and says it is laid out like a Pixhawk 2.4.8", () => {
    const r = rig();
    r.pump(1);
    expect(r.session.telemetry.servo?.value.pwm).toEqual([1000, 1000, 1000, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    r.cmd(512, [148]);
    r.pump(0.2);
    expect(r.session.telemetry.autopilot?.value).toEqual({ boardId: 9, version: "4.6.3" });
    expect(boardFor(9, null).pixhawk1).toBe(true);
  });

  it("moves a Disabled output, and refuses a motor's with ArduPilot's words", () => {
    const r = rig();
    r.cmd(183, [9, 1700]);
    r.pump(0.5);
    expect(r.ack(183)).toBe(0);
    expect(r.out(9)).toBe(1700);
    r.cmd(183, [1, 1600]);
    r.pump(0.5);
    expect(r.ack(183)).toBe(4);
    expect(r.session.events.map((e) => e.text).join("\n")).toMatch(/ServoRelayEvent: Channel 1 is already in use/);
  });

  it("follows a transmitter channel exactly or scaled", () => {
    const r = rig();
    r.set("SERVO10_FUNCTION", 56);
    r.set("SERVO11_FUNCTION", 146);
    r.set("SERVO11_MIN", 1000);
    r.set("SERVO11_MAX", 2000);
    r.rc({ 6: 1800, 7: 1900 });
    r.pump(0.5);
    expect(r.out(10)).toBe(1800);
    // Channel 7 at the top of its default 1100-1900 range → the output's top.
    expect(r.out(11)).toBe(2000);
  });

  it("starts the gripper only after a restart, as ArduPilot does, and accepts the command before it does nothing", () => {
    const r = rig();
    for (const [k, v] of Object.entries({ SERVO12_FUNCTION: 28, GRIP_ENABLE: 1, GRIP_TYPE: 1, GRIP_GRAB: 1800, GRIP_RELEASE: 1200, GRIP_NEUTRAL: 1500 })) r.set(k, v);
    r.pump(0.3);
    r.cmd(211, [1, 0]);
    r.pump(0.5);
    expect(r.ack(211)).toBe(0);
    expect(r.out(12)).toBe(0);
    r.cmd(246, [1]);
    r.pump(0.5);
    expect(r.out(12)).toBe(1500);
    r.cmd(211, [1, 0]);
    r.pump(0.5);
    expect(r.out(12)).toBe(1200);
    r.cmd(211, [1, 1]);
    r.pump(0.5);
    expect(r.out(12)).toBe(1800);
  });

  it("lists the gripper's settings only once it is turned on, as ArduPilot does", () => {
    const r = rig();
    r.set("GRIP_TYPE", 1);
    r.pump(0.3);
    expect(r.got.some((g) => g.name === "PARAM_VALUE" && g.d.param_id === "GRIP_TYPE")).toBe(false);
    r.set("GRIP_ENABLE", 1);
    r.set("GRIP_TYPE", 1);
    r.pump(0.3);
    const echo = r.got.filter((g) => g.name === "PARAM_VALUE" && g.d.param_id === "GRIP_TYPE");
    expect(echo.at(-1)?.d.param_value).toBe(1);
  });

  it("refuses the gripper command when the gripper is off", () => {
    const r = rig();
    r.cmd(211, [1, 0]);
    r.pump(0.3);
    expect(r.ack(211)).toBe(4);
  });

  it("gives the page the same outputs and checks a real quad would", () => {
    const v = new VirtualVehicle({ airframe: PRESETS[0], home: HOME });
    const params = (v as unknown as { ap: { params: Record<string, number> } }).ap.params;
    const outs = readOutputs(params, boardFor(9, null).layout);
    expect(outs).toHaveLength(14);
    expect(outs.slice(0, 4).map((o) => o.fn)).toEqual([33, 34, 35, 36]);
    expect(checkOutputs(params, boardFor(9, null).layout, { mavType: 2 })).toEqual([]);
  });
});
