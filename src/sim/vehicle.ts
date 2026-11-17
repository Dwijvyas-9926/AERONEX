import { encode, type FieldValue } from "../mavlink/encode";
import { decode, MavlinkParser, type Decoded } from "../mavlink/parser";
import type { Airframe } from "./airframe";
import { letGoBody, newBody, stepBodies, type PayloadBody } from "./payloadBody";
import { Autopilot, CMD, MODE, type Home, type Inputs, type MissionItem, type SimEvent } from "./autopilot";
import { hiddenByEnable, SimServos } from "./servos";
import { defaultParams, PARAM_DEFS, PARAM_TYPES, sanitizeParam, sanitizeParams, storedValue, type Params } from "./params";
import { euler, Physics } from "./physics";
import { FENCE_CMD, PIXHAWK_FENCE_BYTES, wireProblem, type FenceWire } from "../geo/fence";
import type { Terrain } from "./terrain";

/*
  A virtual aircraft that speaks MAVLink.

  It is the physics, the flight-controller model and a MAVLink endpoint in
  one object. Bytes go in exactly as they would go down a serial cable to a
  Pixhawk, and bytes come out the same way, so the rest of the app cannot
  tell it from hardware and nothing in the app is special-cased for it.
*/

export interface VehicleOptions {
  airframe: Airframe;
  home: Home;
  params?: Params;
  /** State of charge at the start, 0–1. */
  soc?: number;
  yawDeg?: number;
  seed?: number;
  /** The landscape. Level ground when left out. */
  terrain?: Terrain;
}

/** A payload hanging below the aircraft, and what lets it go: "gripper" or "servo:n" (opened by `open` µs). */
export interface Payload {
  kg: number;
  hangM: number;
  release: string;
  open?: number;
}

const SELF = { sysid: 1, compid: 1 };
export const SIM_DT = 1 / 400;

// SYS_STATUS sensor bits.
const SENS = { GYRO: 1, ACCEL: 2, MAG: 4, BARO: 8, GPS: 32, RATE: 1024, ATT: 2048, YAW: 4096, ALT: 8192, XY: 16384, MOTORS: 32768, RC: 65536, AHRS: 2097152, BATTERY: 33554432, PREARM: 268435456 };

export class VirtualVehicle {
  readonly phys: Physics;
  readonly ap: Autopilot;
  readonly home: Home;
  terrain: Terrain | null = null;
  /** Parameters that were outside their range and had to be changed. */
  paramNotes: string[] = [];
  private fullThrottleOnGround = 0;
  private saidGrounded = false;
  gpsOk = true;
  rcOk = true;
  sticks: Inputs["sticks"] = null;
  /** In a scripted run there is no real ground station: say whether one is "there". */
  scriptedGcs: boolean | null = null;

  private parser = new MavlinkParser();
  private outbox: Uint8Array[] = [];
  private seq = 0;
  /** Wall-clock seconds, advanced by the host; telemetry is paced on it. */
  private clock = 0;
  private due: Record<string, number> = {};
  private gcsHeardAt: number | null = null;
  private gcsLostAt: number | null = null;
  private sentEvents = 0;
  private paramQueue: number[] = [];
  private upload: { count: number; next: number; items: MissionItem[] } | null = null;
  private fenceUp: { count: number; next: number; items: FenceWire[] } | null = null;
  private accelCal: number | null = null;
  private magCal: { start: number; last: number } | null = null;
  private paramNames: string[];
  private rcOverrideAt = -1;
  /** Transmitter channels 5-16 from RC_CHANNELS_OVERRIDE (0 = not overridden: the switch rests at 1500). */
  private aux: number[] = Array(12).fill(0);
  private servos = new SimServos();

  constructor(o: VehicleOptions) {
    this.home = o.home;
    this.phys = new Physics(o.airframe, { soc: o.soc, yawDeg: o.yawDeg, seed: o.seed });
    if (o.terrain) {
      this.terrain = o.terrain;
      this.phys.ground = o.terrain.surface;
      this.phys.water = o.terrain.isWater;
    }
    const clean = sanitizeParams({ ...defaultParams(o.airframe), ...(o.params ?? {}) });
    this.paramNotes = clean.notes;
    this.ap = new Autopilot(this.phys, clean.params, o.home);
    this.ap.mode = MODE.STABILIZE;
    // ArduPilot reports reaching navigation commands; a do command completes without a word.
    this.ap.onReached = (seq) => {
      const c = this.ap.mission[seq]?.command;
      if (c !== CMD.GRIPPER && c !== CMD.SET_SERVO && c !== CMD.CHANGE_SPEED) this.send("MISSION_ITEM_REACHED", { seq });
    };
    this.ap.onDo = (item) => this.doCommand(item);
    this.ap.onPlaceRelease = () => this.placeRelease();
    this.paramNames = PARAM_DEFS.map((d) => d.name);
    this.servos.boot(this.ap.params);
  }

  /* ------------------------------------------------------------ payload */

  /** What hangs below the aircraft, and what lets each one go. */
  private payloads: (Payload & { attached: boolean })[] = [];
  /** No aircraft's settings were known: each release works as planned, whatever the gripper and servo settings say. */
  private assumeRelease = false;

  /**
   * Hang payloads below the aircraft, as if loaded before take-off. With
   * `assumeRelease`, a release lets go even if the aircraft's own settings
   * would not (for a plan made before any aircraft was linked).
   */
  loadPayloads(list: Payload[], assumeRelease = false) {
    this.payloads = list.map((p) => ({ ...p, attached: true }));
    const s = this.phys.s;
    this.bodies = list.map((p, i) => newBody(i, p, s.pos, this.phys.ground(s.pos[0], s.pos[1])));
    this.assumeRelease = assumeRelease;
    this.syncPayload();
  }

  /** The payloads as things in the world: hanging, falling or on the ground. */
  bodies: PayloadBody[] = [];

  /** Kilograms still hanging below. */
  get payloadKg(): number {
    return this.payloads.filter((p) => p.attached).reduce((a, p) => a + p.kg, 0);
  }

  private syncPayload() {
    const on = this.payloads.filter((p) => p.attached);
    this.phys.payload = on.length ? { kg: on.reduce((a, p) => a + p.kg, 0), hangM: Math.max(...on.map((p) => p.hangM)) } : null;
  }

  /** Let go of what `key` holds; the kilograms let go. */
  private letGo(match: (p: Payload) => boolean): number {
    let kg = 0;
    const s = this.phys.s;
    const at = { t: s.t, seq: this.ap.missionSeq, n: s.pos[0], e: s.pos[1], agl: this.ap.height - this.phys.ground(s.pos[0], s.pos[1]), speed: Math.hypot(s.vel[0], s.vel[1]) };
    this.payloads.forEach((p, i) => {
      if (p.attached && match(p)) {
        p.attached = false;
        kg += p.kg;
        const b = this.bodies[i];
        if (b) letGoBody(b, this.phys.ground(b.pos[0], b.pos[1]), at);
      }
    });
    this.syncPayload();
    return kg;
  }

  /** A mission's gripper or servo command, as the firmware carries it out. */
  private doCommand(item: MissionItem): number {
    const ap = this.ap;
    if (item.command === CMD.GRIPPER) {
      const release = Math.round(item.p2) === 0;
      // The firmware moves the gripper only if it started at boot; it says "Gripper Released" either way.
      if (this.servos.gripperReady) this.servos.grip(ap.params, !release, this.clock);
      if (!release || !(this.servos.gripperReady || this.assumeRelease)) return 0;
      return this.letGo((p) => p.release === "gripper");
    }
    if (item.command === CMD.SET_SERVO) {
      const servo = Math.round(item.p1);
      const why = this.servos.setServo(ap.params, servo, item.p2, this.rcRaw());
      if (why) ap.log("warn", why, "servo-refused");
      if (why && !this.assumeRelease) return 0;
      return this.letGo((p) => p.release === `servo:${servo}` && p.open !== undefined && Math.abs(p.open - item.p2) <= 50);
    }
    return 0;
  }

  /** PayloadPlace opening the gripper: the kilograms let go, or null with no gripper. */
  private placeRelease(): number | null {
    if (!this.servos.gripperReady && !this.assumeRelease) return null;
    if (this.servos.gripperReady) this.servos.grip(this.ap.params, false, this.clock);
    return this.letGo((p) => p.release === "gripper");
  }

  /* ----------------------------------------------------------- stepping */

  inputs(): Inputs {
    const silent = this.scriptedGcs !== null ? (this.scriptedGcs ? 0 : this.phys.s.t - (this.gcsLostAt ?? this.phys.s.t)) : this.gcsHeardAt === null ? 0 : this.clock - this.gcsHeardAt;
    return {
      gpsOk: this.gpsOk,
      rcOk: this.rcOk,
      gcsSilentS: silent,
      gcsSeen: this.scriptedGcs !== null ? true : this.gcsHeardAt !== null,
      sticks: this.sticks,
    };
  }

  /** In a scripted run, connect or cut the ground-station link. */
  setScriptedGcs(present: boolean) {
    if (this.scriptedGcs !== false && !present) this.gcsLostAt = this.phys.s.t;
    this.scriptedGcs = present;
  }

  /** Advance the simulation by `simSeconds`; `wallSeconds` paces telemetry. */
  advance(simSeconds: number, wallSeconds = simSeconds, telemetry = true) {
    const steps = Math.max(0, Math.round(simSeconds / SIM_DT));
    for (let i = 0; i < steps; i++) {
      this.ap.step(SIM_DT, this.inputs());
      this.phys.step(this.ap.out, SIM_DT);
      if (this.bodies.length) stepBodies(this.bodies, this.phys.s, this.phys.wind(), this.phys.ground, SIM_DT, this.phys.s.t);
    }
    this.watchGrounded(steps * SIM_DT);
    this.clock += wallSeconds;
    // Stick overrides lapse if the ground station stops sending them.
    if (this.sticks && this.rcOverrideAt >= 0 && this.clock - this.rcOverrideAt > 1.5) this.sticks = null;
    if (telemetry) this.emit();
  }

  /**
   * Full throttle and still on the ground: the aircraft cannot lift itself.
   * A real autopilot says nothing about this — it just sits there roaring —
   * so the simulator says it, once.
   */
  private watchGrounded(dt: number) {
    const s = this.phys.s;
    const trying = this.ap.armed && !this.ap.landed && s.onGround && !s.crashed && this.ap.throttleOut > 0.85;
    this.fullThrottleOnGround = trying ? this.fullThrottleOnGround + dt : 0;
    if (!trying && !this.ap.armed) this.saidGrounded = false;
    if (this.fullThrottleOnGround > 4 && !this.saidGrounded) {
      this.saidGrounded = true;
      const sag = s.volts < this.phys.af.cells * 3.1;
      this.ap.log(
        "error",
        sag ? "Simulator: full throttle but no lift, battery sagging" : "Simulator: full throttle but too heavy to lift",
        "grounded",
      );
    }
  }

  /** Everything the vehicle has to say since the last call, as one buffer. */
  drain(): Uint8Array {
    const n = this.outbox.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const b of this.outbox) {
      out.set(b, at);
      at += b.length;
    }
    this.outbox = [];
    return out;
  }

  /** Put it back on the ground at home, as it started. */
  reset(soc = 1) {
    const s = this.phys.s;
    this.ap.disarm("Reset");
    Object.assign(s, { pos: [0, 0, -this.phys.ground(0, 0)], vel: [0, 0, 0], acc: [0, 0, 0], w: [0, 0, 0], thrust: [0, 0, 0, 0], onGround: true, crashed: false, crashWhy: null, usedMah: (1 - soc) * this.phys.af.capacityMah });
    this.phys.faults.motor = [1, 1, 1, 1];
    this.gpsOk = true;
    this.rcOk = true;
    this.ap.landed = true;
    this.ap.failsafes.clear();
    this.ap.mode = MODE.STABILIZE;
    this.ap.homeAt = { n: 0, e: 0, z: 0 };
    this.payloads = [];
    this.bodies = [];
    this.syncPayload();
    this.ap.log("info", "Aircraft reset to home");
  }

  /* ----------------------------------------------------------- outbound */

  private send(name: string, fields: Record<string, FieldValue>) {
    this.outbox.push(encode(name, fields, { ...SELF, seq: this.seq++ & 0xff }));
  }

  private every(key: string, hz: number): boolean {
    const next = this.due[key] ?? 0;
    if (this.clock < next) return false;
    this.due[key] = Math.max(next + 1 / hz, this.clock - 1 / hz);
    return true;
  }

  private text(sev: number, text: string) {
    this.send("STATUSTEXT", { severity: sev, text: text.slice(0, 50) });
  }

  private emit() {
    const { phys, ap } = this;
    const s = phys.s;
    const e = euler(s.q);
    const ms = Math.round(s.t * 1000) >>> 0;
    const g = ap.toGlobal(s.pos[0], s.pos[1]);
    // Above sea level from where it is; above home from where home is now.
    const msl = this.home.altMsl - s.pos[2];
    const alt = ap.alt;
    const inp = this.inputs();

    // The autopilot's own log, as status text.
    for (; this.sentEvents < ap.events.length; this.sentEvents++) {
      const ev = ap.events[this.sentEvents];
      this.text(ev.sev === "error" ? 3 : ev.sev === "warn" ? 4 : 6, ev.text);
    }
    if (ap.events.length > 300) {
      ap.events.splice(0, 200);
      this.sentEvents = Math.max(0, this.sentEvents - 200);
    }

    if (this.every("hb", 1)) {
      const failsafe = ap.failsafes.size > 0 && ap.armed;
      this.send("HEARTBEAT", {
        type: 2,
        autopilot: 3,
        base_mode: 1 | 16 | 64 | (ap.armed ? 128 : 0),
        custom_mode: ap.mode,
        system_status: s.crashed ? 6 : failsafe ? 5 : ap.armed ? 4 : 3,
        mavlink_version: 3,
      });
    }
    if (this.every("att", 10)) {
      this.send("ATTITUDE", { time_boot_ms: ms, roll: e.roll, pitch: e.pitch, yaw: e.yaw, rollspeed: s.w[0], pitchspeed: s.w[1], yawspeed: s.w[2] });
    }
    const hdg = ((e.yaw * 180) / Math.PI + 360) % 360;
    if (this.gpsOk && this.every("pos", 5)) {
      this.send("GLOBAL_POSITION_INT", {
        time_boot_ms: ms,
        lat: Math.round(g.lat * 1e7),
        lon: Math.round(g.lon * 1e7),
        alt: Math.round(msl * 1000),
        relative_alt: Math.round(alt * 1000),
        vx: Math.round(s.vel[0] * 100),
        vy: Math.round(s.vel[1] * 100),
        vz: Math.round(s.vel[2] * 100),
        hdg: Math.round(hdg * 100),
      });
    }
    if (this.every("hud", 5)) {
      const gs = Math.hypot(s.vel[0], s.vel[1]);
      const w = phys.wind();
      this.send("VFR_HUD", {
        airspeed: Math.hypot(s.vel[0] - w[0], s.vel[1] - w[1]),
        groundspeed: gs,
        heading: Math.round(hdg),
        throttle: Math.round(ap.throttleOut * 100),
        alt: msl,
        climb: -s.vel[2],
      });
    }
    if (this.every("gps", 2)) {
      this.send("GPS_RAW_INT", {
        time_usec: ms * 1000,
        fix_type: this.gpsOk ? 3 : 1,
        lat: this.gpsOk ? Math.round(g.lat * 1e7) : 0,
        lon: this.gpsOk ? Math.round(g.lon * 1e7) : 0,
        alt: Math.round(msl * 1000),
        eph: this.gpsOk ? 80 : 9999,
        epv: this.gpsOk ? 120 : 9999,
        vel: Math.round(Math.hypot(s.vel[0], s.vel[1]) * 100),
        cog: Math.round(((Math.atan2(s.vel[1], s.vel[0]) * 180) / Math.PI + 360) % 360 * 100),
        satellites_visible: this.gpsOk ? 14 : 0,
      });
    }
    if (this.every("sys", 2)) {
      const present = SENS.GYRO | SENS.ACCEL | SENS.MAG | SENS.BARO | SENS.GPS | SENS.RATE | SENS.ATT | SENS.YAW | SENS.ALT | SENS.XY | SENS.MOTORS | SENS.RC | SENS.AHRS | SENS.BATTERY | SENS.PREARM;
      let health = present;
      if (!this.gpsOk) health &= ~(SENS.GPS | SENS.XY);
      if (!this.rcOk) health &= ~SENS.RC;
      if (ap.failsafes.has("batt-low") || ap.failsafes.has("batt-critical")) health &= ~SENS.BATTERY;
      if (phys.faults.motor.some((m) => m < 0.5)) health &= ~SENS.MOTORS;
      if (!ap.armed && ap.prearm(inp).length > 0) health &= ~SENS.PREARM;
      this.send("SYS_STATUS", {
        onboard_control_sensors_present: present,
        onboard_control_sensors_enabled: present,
        onboard_control_sensors_health: health,
        load: 180,
        voltage_battery: Math.round(s.volts * 1000),
        current_battery: Math.round(s.amps * 100),
        battery_remaining: Math.max(0, Math.min(100, Math.round(phys.soc * 100))),
      });
    }
    if (this.every("batt", 1)) {
      const cells = Array.from({ length: 10 }, (_, i) => (i < phys.af.cells ? Math.round((s.volts / phys.af.cells) * 1000) : 65535));
      this.send("BATTERY_STATUS", {
        id: 0,
        battery_function: 1,
        type: 1,
        temperature: 32767,
        voltages: cells,
        current_battery: Math.round(s.amps * 100),
        current_consumed: Math.round(s.usedMah),
        energy_consumed: -1,
        battery_remaining: Math.max(0, Math.min(100, Math.round(phys.soc * 100))),
      });
    }
    if (this.every("ekf", 1)) {
      this.send("EKF_STATUS_REPORT", {
        flags: this.gpsOk ? 831 : 165,
        velocity_variance: this.gpsOk ? 0.04 : 0.9,
        pos_horiz_variance: this.gpsOk ? 0.03 : 1.2,
        pos_vert_variance: 0.04,
        compass_variance: 0.03,
        terrain_alt_variance: 0,
      });
    }
    if (this.every("vibe", 1)) {
      const worst = Math.min(...phys.faults.motor);
      const level = ap.armed ? 4 + 14 * ap.throttleOut + (worst < 0.95 ? 25 * (1 - worst) : 0) : 0.3;
      this.send("VIBRATION", { time_usec: ms * 1000, vibration_x: level, vibration_y: level * 1.05, vibration_z: level * 1.4, clipping_0: 0, clipping_1: 0, clipping_2: 0 });
    }
    if (this.every("rc", 2)) {
      const ch = this.rcRaw();
      const f: Record<string, FieldValue> = { time_boot_ms: ms, chancount: this.rcOk ? 16 : 0, rssi: this.rcOk ? 200 : 0 };
      for (let i = 1; i <= 18; i++) f[`chan${i}_raw`] = this.rcOk && i <= 16 ? ch[i - 1] : 0;
      this.send("RC_CHANNELS", f);
    }
    if (this.every("servo", 5)) {
      const pwm = this.servos.outputs(ap.params, ap.out, ap.armed, this.rcOk ? this.rcRaw() : [], this.clock);
      const f: Record<string, FieldValue> = { time_usec: (ms * 1000) >>> 0, port: 0 };
      for (let i = 1; i <= 16; i++) f[`servo${i}_raw`] = pwm[i - 1];
      this.send("SERVO_OUTPUT_RAW", f);
    }
    if (this.every("mis", 1)) this.send("MISSION_CURRENT", { seq: ap.missionSeq });
    // Home moves when it arms: say so at once, as ArduPilot does, and every 5 s besides.
    const h = ap.homeAt;
    const key = `${h.n.toFixed(2)},${h.e.toFixed(2)},${h.z.toFixed(2)}`;
    if (key !== this.homeKey) {
      this.homeKey = key;
      this.due.home = 0;
    }
    if (this.every("home", 0.2)) this.sendHome();

    // A parameter download is paced, as a real one is.
    for (let n = 0; n < 12 && this.paramQueue.length; n++) this.sendParam(this.paramQueue.shift()!);

    // Compass calibration: reports progress, then succeeds.
    if (this.magCal && this.clock - this.magCal.last > 0.4) {
      this.magCal.last = this.clock;
      const pct = Math.min(100, Math.round(((this.clock - this.magCal.start) / 6) * 100));
      if (pct < 100) {
        this.send("MAG_CAL_PROGRESS", { compass_id: 0, cal_mask: 1, cal_status: 3, attempt: 1, completion_pct: pct, completion_mask: Array(10).fill(pct > 50 ? 255 : 15), direction_x: 0, direction_y: 0, direction_z: 0 });
      } else {
        this.send("MAG_CAL_REPORT", { compass_id: 0, cal_mask: 1, cal_status: 4, autosaved: 1, fitness: 6.5, ofs_x: 12, ofs_y: -8, ofs_z: 31, diag_x: 1, diag_y: 1, diag_z: 1, offdiag_x: 0, offdiag_y: 0, offdiag_z: 0 });
        this.magCal = null;
      }
    }
  }

  /** What the transmitter sends on channels 1-16: the sticks, and switches resting at 1500 unless overridden. */
  private rcRaw(): number[] {
    const st = this.sticks;
    const pwm = (v: number) => Math.round(1500 + 500 * v);
    return [pwm(st?.roll ?? 0), pwm(st?.pitch ?? 0), Math.round(1000 + 1000 * (st?.throttle ?? 0)), pwm(st?.yaw ?? 0), ...this.aux.map((v) => v || 1500)];
  }

  private homeKey = "";

  private sendHome() {
    const h = this.ap.homeNow();
    const at = this.ap.homeAt;
    this.send("HOME_POSITION", { latitude: Math.round(h.lat * 1e7), longitude: Math.round(h.lon * 1e7), altitude: Math.round(h.altMsl * 1000), x: at.n, y: at.e, z: -at.z, q: [1, 0, 0, 0], approach_x: 0, approach_y: 0, approach_z: 0 });
  }

  /** The parameters listed now: some appear only while their enable flag is on, as in ArduPilot. */
  private listed(): string[] {
    return this.paramNames.filter((n) => !hiddenByEnable(n, this.ap.params));
  }

  private sendParam(index: number, listed = true) {
    const names = this.listed();
    const name = names[index];
    if (!name) return;
    this.send("PARAM_VALUE", { param_id: name, param_value: this.ap.params[name], param_type: PARAM_TYPES[name] ?? 9, param_count: names.length, param_index: listed ? index : 65535 });
  }

  private ack(command: number, result: number) {
    this.send("COMMAND_ACK", { command, result });
  }

  /* ------------------------------------------------------------ inbound */

  /** Bytes from the ground station. */
  receive(bytes: Uint8Array) {
    for (const f of this.parser.push(bytes)) {
      const d = decode(f);
      if (!d) continue;
      if (f.name === "HEARTBEAT") {
        this.gcsHeardAt = this.clock;
        continue;
      }
      const ts = d.target_system as number | undefined;
      if (ts !== undefined && ts !== 0 && ts !== SELF.sysid) continue;
      this.handle(f.name, d);
    }
  }

  private handle(name: string, d: Decoded) {
    const ap = this.ap;
    const num = (k: string) => (d[k] as number) ?? 0;
    switch (name) {
      case "PARAM_REQUEST_LIST":
        this.paramQueue = this.listed().map((_, i) => i);
        break;
      case "PARAM_REQUEST_READ": {
        const idx = num("param_index");
        const i = idx >= 0 && idx < 65535 ? idx : this.listed().indexOf(String(d.param_id ?? ""));
        if (i >= 0) this.sendParam(i, idx >= 0 && idx < 65535);
        break;
      }
      case "PARAM_SET": {
        const id = String(d.param_id ?? "");
        // A hidden setting cannot be written, and is not answered, as in ArduPilot.
        if (this.listed().indexOf(id) < 0) break;
        const v = num("param_value");
        if (Number.isFinite(v)) {
          const stored = storedValue(id, v);
          ap.params[id] = sanitizeParam(id, stored);
          if (ap.params[id] !== stored) ap.log("warn", `${id} is outside its range: using ${ap.params[id]}`);
        }
        this.sendParam(this.listed().indexOf(id), false);
        break;
      }
      case "SET_MODE":
        ap.setMode(num("custom_mode"), this.inputs(), "ground station");
        break;
      case "COMMAND_LONG":
        this.command(num("command"), [num("param1"), num("param2"), num("param3"), num("param4"), num("param5"), num("param6"), num("param7")]);
        break;
      case "COMMAND_INT":
        this.command(num("command"), [num("param1"), num("param2"), num("param3"), num("param4"), num("x") / 1e7, num("y") / 1e7, num("z")]);
        break;
      case "COMMAND_ACK":
        // The ground station confirming an accelerometer-calibration position.
        if (this.accelCal !== null) this.accelStep(this.accelCal + 1);
        break;
      case "SET_POSITION_TARGET_LOCAL_NED":
        ap.guidedVelocity(num("vx"), num("vy"), num("vz"), num("yaw_rate"));
        break;
      case "SET_POSITION_TARGET_GLOBAL_INT": {
        const l = ap.toLocal(num("lat_int"), num("lon_int"));
        ap.guidedGoto(l.n, l.e, num("alt"));
        break;
      }
      case "RC_CHANNELS_OVERRIDE": {
        const c = (i: number) => num(`chan${i}_raw`);
        if (c(1) === 0 && c(3) === 0) {
          this.sticks = null;
          for (let i = 5; i <= 16; i++) {
            const v = c(i);
            if (v && v !== 65535 && v !== 65534) this.aux[i - 5] = Math.max(800, Math.min(2200, v));
          }
          break;
        }
        const n = (v: number) => Math.max(-1, Math.min(1, (v - 1500) / 500));
        this.sticks = { roll: n(c(1)), pitch: n(c(2)), throttle: Math.max(0, Math.min(1, (c(3) - 1000) / 1000)), yaw: n(c(4)) };
        // Channels 5 and up: 0 or 65535 means "not overridden" (MAVLink), and 9-16 only exist in MAVLink 2.
        for (let i = 5; i <= 16; i++) {
          const v = c(i);
          if (v && v !== 65535 && v !== 65534) this.aux[i - 5] = Math.max(800, Math.min(2200, v));
        }
        this.rcOverrideAt = this.clock;
        break;
      }
      case "MISSION_COUNT": {
        const type = num("mission_type");
        if (type === 1) {
          this.fenceCount(num("count"));
          break;
        }
        if (type !== 0) {
          this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: num("count") === 0 ? 0 : 3, mission_type: type });
          break;
        }
        const count = num("count");
        if (count === 0) {
          ap.mission = [];
          this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: 0, mission_type: 0 });
          break;
        }
        this.upload = { count, next: 0, items: [] };
        this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: 0, mission_type: 0 });
        break;
      }
      case "MISSION_ITEM_INT":
      case "MISSION_ITEM": {
        if (num("mission_type") === 1) {
          this.fenceItem(name, num);
          break;
        }
        const u = this.upload;
        if (!u) break;
        const seq = num("seq");
        if (seq !== u.next) {
          this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: u.next, mission_type: 0 });
          break;
        }
        const scale = name === "MISSION_ITEM" ? 1e7 : 1;
        u.items.push({ seq, frame: num("frame"), command: num("command"), p1: num("param1"), p2: num("param2"), p3: num("param3"), p4: num("param4"), x: Math.round(num("x") * scale), y: Math.round(num("y") * scale), z: num("z") });
        u.next++;
        if (u.next < u.count) {
          this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: u.next, mission_type: 0 });
        } else {
          ap.mission = u.items;
          ap.missionSeq = 0;
          this.upload = null;
          this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: 0, mission_type: 0 });
          ap.log("info", `Mission received: ${u.items.length - 1} commands`);
        }
        break;
      }
      case "MISSION_REQUEST_LIST": {
        const type = num("mission_type");
        this.send("MISSION_COUNT", { target_system: 255, target_component: 190, count: type === 0 ? ap.mission.length : type === 1 ? ap.fence.length : 0, mission_type: type });
        break;
      }
      case "MISSION_REQUEST_INT":
      case "MISSION_REQUEST": {
        if (num("mission_type") === 1) {
          const f = ap.fence[num("seq")];
          if (!f) this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: 13, mission_type: 1 });
          // ArduPilot reports fence items with the frame left at zero and no height.
          else this.send("MISSION_ITEM_INT", { target_system: 255, target_component: 190, seq: num("seq"), frame: 0, command: f.command, current: 0, autocontinue: 0, param1: f.p1, param2: 0, param3: 0, param4: 0, x: f.x, y: f.y, z: 0, mission_type: 1 });
          break;
        }
        const it = ap.mission[num("seq")];
        if (!it) {
          this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: 13, mission_type: 0 });
          break;
        }
        this.send("MISSION_ITEM_INT", { target_system: 255, target_component: 190, seq: it.seq, frame: it.frame, command: it.command, current: it.seq === ap.missionSeq ? 1 : 0, autocontinue: 1, param1: it.p1, param2: it.p2, param3: it.p3, param4: it.p4, x: it.x, y: it.y, z: it.z, mission_type: 0 });
        break;
      }
      case "MISSION_CLEAR_ALL":
        if (num("mission_type") === 1) ap.setFence([]);
        else {
          ap.mission = [];
          ap.missionSeq = 0;
        }
        this.send("MISSION_ACK", { target_system: 255, target_component: 190, type: 0, mission_type: num("mission_type") });
        break;
      case "MISSION_SET_CURRENT":
        if (num("seq") < ap.mission.length) ap.missionSeq = num("seq");
        break;
    }
  }

  /*
    The fence list, as ArduPilot's MissionItemProtocol_Fence takes it: more
    items than storage can hold are refused at the count; the whole set is
    checked by the loader's rules once the last item is in, and either stored
    or refused with its reason in a status text.
  */
  private fenceCount(count: number) {
    const ack = (type: number) => this.send("MISSION_ACK", { target_system: 255, target_component: 190, type, mission_type: 1 });
    if (count > PIXHAWK_FENCE_BYTES / 8) {
      ack(4);
      return;
    }
    if (count === 0) {
      this.ap.setFence([]);
      ack(0);
      return;
    }
    this.fenceUp = { count, next: 0, items: [] };
    this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: 0, mission_type: 1 });
  }

  private fenceItem(name: string, num: (k: string) => number) {
    const u = this.fenceUp;
    if (!u) return;
    const ack = (type: number) => this.send("MISSION_ACK", { target_system: 255, target_component: 190, type, mission_type: 1 });
    const seq = num("seq");
    if (seq !== u.next) {
      this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: u.next, mission_type: 1 });
      return;
    }
    const frame = num("frame");
    if (![0, 3, 5, 6, 10, 11].includes(frame)) {
      this.fenceUp = null;
      ack(6);
      return;
    }
    const cmd = num("command");
    if (!(Object.values(FENCE_CMD) as number[]).includes(cmd)) {
      this.fenceUp = null;
      ack(3);
      return;
    }
    const scale = name === "MISSION_ITEM" ? 1e7 : 1;
    u.items.push({ seq, frame: 0, command: cmd, p1: Math.fround(num("param1")), p2: 0, p3: 0, p4: 0, x: Math.round(num("x") * scale), y: Math.round(num("y") * scale), z: 0 });
    u.next++;
    if (u.next < u.count) {
      this.send("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: u.next, mission_type: 1 });
      return;
    }
    this.fenceUp = null;
    const problem = wireProblem(u.items);
    if (problem) {
      this.text(4, problem);
      this.text(4, "Fence validation failed");
      ack(1);
      return;
    }
    // fence_storage_space_required, against a Pixhawk's fence storage.
    let bytes = 5;
    for (let i = 0; i < u.items.length; ) {
      const it = u.items[i];
      if (it.command === FENCE_CMD.POLYGON_IN || it.command === FENCE_CMD.POLYGON_OUT) {
        bytes += 2 + 8 * it.p1;
        i += it.p1;
      } else {
        bytes += it.command === FENCE_CMD.RETURN_POINT ? 9 : 13;
        i++;
      }
    }
    if (bytes > PIXHAWK_FENCE_BYTES) {
      this.text(4, "Fence exceeds storage size");
      ack(1);
      return;
    }
    this.ap.setFence(u.items);
    ack(0);
  }

  private command(cmd: number, p: number[]) {
    const ap = this.ap;
    const inp = this.inputs();
    switch (cmd) {
      case 400: {
        if (p[0] >= 0.5) {
          const why = ap.arm(inp, p[1] === 21196);
          this.ack(cmd, why.length ? 4 : 0);
        } else {
          if (!ap.landed && p[1] !== 21196) {
            ap.log("warn", "Disarm refused: in flight");
            this.ack(cmd, 4);
          } else {
            ap.disarm();
            this.ack(cmd, 0);
          }
        }
        break;
      }
      case 176:
        this.ack(cmd, ap.setMode(p[1], inp, "ground station") ? 0 : 4);
        break;
      case 22:
        this.ack(cmd, ap.guidedTakeoff(p[6]) ? 0 : 4);
        break;
      case 21:
        this.ack(cmd, ap.setMode(MODE.LAND, inp, "ground station") ? 0 : 4);
        break;
      case 20:
        this.ack(cmd, ap.setMode(MODE.RTL, inp, "ground station") ? 0 : 4);
        break;
      case 300:
        this.ack(cmd, ap.startMission() ? 0 : 4);
        break;
      case 209:
        if (ap.armed) this.ack(cmd, 4);
        else {
          ap.log("info", `Motor test: motor ${p[0]} at ${p[2]}%`);
          this.ack(cmd, 0);
        }
        break;
      case 241:
        if (p[4] === 1) {
          this.ack(cmd, 0);
          this.accelStep(0);
        } else {
          ap.log("info", p[0] === 1 ? "Gyro calibration complete" : p[4] === 2 ? "Trim OK: level set" : "Calibration complete");
          this.ack(cmd, 0);
        }
        break;
      case 42424:
        this.magCal = { start: this.clock, last: this.clock };
        this.ack(cmd, 0);
        break;
      case 42425:
      case 42426:
        this.magCal = null;
        this.ack(cmd, 0);
        break;
      case 246:
        // It stays up, but takes what is read only at start-up afresh (the gripper).
        this.servos.boot(ap.params);
        ap.log("info", "Reboot requested: the virtual aircraft stays up, and re-reads its start-up settings");
        this.ack(cmd, 0);
        break;
      case 183: {
        const why = this.servos.setServo(ap.params, Math.round(p[0]), p[1], this.rcRaw());
        if (why) this.text(6, why);
        this.ack(cmd, why ? 4 : 0);
        break;
      }
      case 211:
        this.ack(cmd, this.servos.grip(ap.params, Math.round(p[1]) === 1, this.clock) ? 0 : 4);
        break;
      case 410:
        this.sendHome();
        this.ack(cmd, 0);
        break;
      case 512:
        this.ack(cmd, 0);
        // Board id 9 (Pixhawk1 class) in the top 16 bits, as ArduPilot reports it: the virtual aircraft's outputs are laid out like a Pixhawk 2.4.8.
        if (Math.round(p[0]) === 148) this.send("AUTOPILOT_VERSION", { capabilities: 0, flight_sw_version: (4 << 24) | (6 << 16) | (3 << 8), middleware_sw_version: 0, os_sw_version: 0, board_version: (9 << 16) >>> 0, flight_custom_version: Array(8).fill(0), middleware_custom_version: Array(8).fill(0), os_custom_version: Array(8).fill(0), vendor_id: 0, product_id: 0, uid: 0 });
        break;
      case 511:
      case 520:
        this.ack(cmd, 0);
        break;
      default:
        this.ack(cmd, 3); // unsupported
    }
  }

  /** ArduPilot's six-position accelerometer calibration, driven by status text. */
  private accelStep(step: number) {
    const prompts = ["level", "on its LEFT side", "on its RIGHT side", "nose DOWN", "nose UP", "on its BACK"];
    if (step < prompts.length) {
      this.accelCal = step;
      this.text(5, `Place vehicle ${prompts[step]} and press any key.`);
    } else {
      this.accelCal = null;
      this.text(5, "Calibration successful");
    }
  }

  get events(): SimEvent[] {
    return this.ap.events;
  }
}
