import { encode } from "../../mavlink/encode";
import type { Decoded } from "../../mavlink/parser";
import { useLink } from "../../state/linkStore";
import { sameParam, useParams } from "../../state/paramStore";
import { useCalibration, magCalOk } from "../../state/calibrationStore";
import { notify } from "../../state/notifyStore";
import { isArduCopter } from "../../mavlink/identity";

/*
  The command layer: the one place the app TALKS to the vehicle. It owns the
  GCS identity, encodes outbound frames (via mavlink/encode), hands them to the
  link's serial writer, tracks COMMAND_ACK / PARAM_VALUE replies, and routes the
  vehicle's calibration messages into the param and calibration stores.

  Writing is gated here, whichever page asks:
   - nothing goes out unless a vehicle link is live;
   - anything that can make an aircraft move or change how it flies (arming,
     a mode, a take-off, a guided velocity, a motor test, a calibration, a
     mission) goes only to ArduCopter, because every mode number and sequence
     in this app is ArduCopter's (see vehicleBlock);
   - a mission goes only to an aircraft with a 3D GPS fix that is disarmed.
  Pages add their own checks on top (props off, disarmed, confirmations).
*/

/**
 * Why the linked vehicle may not be flown or configured for flight by this
 * app; null when it may (or when nothing is linked: target() refuses that).
 *
 * The mode numbers, take-off, guided control and mission semantics used
 * everywhere in AERONEX are ArduCopter's. ArduPlane, Rover and PX4 number
 * their modes differently: ArduCopter's GUIDED (4) is ACRO on ArduPlane and
 * HOLD on Rover. Sent to one of those, a "take off" could put the vehicle in
 * a mode nobody asked for. Reading telemetry and parameters stays possible.
 */
export function vehicleBlock(): { title: string; body: string } | null {
  const v = useLink.getState().vehicle;
  if (!v || isArduCopter(v)) return null;
  const what = v.firmware === "ardupilot" ? `an ArduPilot ${v.typeLabel.toLowerCase()}` : `${v.firmwareLabel} firmware`;
  return {
    title: "AERONEX flies ArduCopter only",
    body: `This flight controller reports ${what}. Its telemetry and parameters can be read, but AERONEX will not arm it, change its flight mode, test its motors, calibrate it or send it a mission. Its mode numbers differ from ArduCopter's.`,
  };
}

const blocked = (b: { title: string; body: string }) => new Error(`${b.title}. ${b.body}`);

// MAVProxy/Mission Planner identify as system 255, component 190 (GCS).
const GCS = { sysid: 255, compid: 190 };

/**
 * Why a mission may not be sent to, or started on, the linked aircraft right
 * now; null when it may.
 *
 * A mission is a list of places. An aircraft whose GPS has no position cannot
 * know where it is among them, and nothing on the ground can know where it
 * will count its heights from. So a real aircraft gets no mission until its
 * GPS has a 3D fix. The virtual aircraft is exempt: losing its GPS is one of
 * the things it is there to rehearse.
 */
export function missionBlock(): { title: string; body: string } | null {
  const l = useLink.getState();
  if (l.status !== "connected" || l.virtual) return null;
  const seen = l.telemetry.gps;
  // A GPS that was reporting and has gone quiet, unplugged or failed, is no GPS.
  const g = seen && Date.now() - seen.at < 8000 ? seen.value : null;
  if (!g || g.fixType <= 0) {
    return { title: "Connect a GPS to fly a mission", body: "The flight controller is not reporting a GPS. Plug a GPS module into its GPS port, power the aircraft again, and take it outdoors. A mission cannot be sent or started without one." };
  }
  if (g.fixType < 3) {
    return {
      title: "Waiting for a GPS fix",
      body: `The GPS is connected but has no position yet${g.satellites !== null ? ` (${g.satellites} ${g.satellites === 1 ? "satellite" : "satellites"} so far)` : ""}. Take the aircraft outdoors with a clear view of the sky and wait: a first fix can take a few minutes. A mission cannot be sent or started until then.`,
    };
  }
  return null;
}

/**
 * Why the mission on the linked aircraft may not be replaced right now.
 *
 * ArduPilot accepts a new mission while it is flying the old one, and carries
 * on from the same item number in the new list. For someone learning that is
 * a trap: the aircraft turns towards whatever now sits at that number. A real
 * aircraft has its mission changed on the ground, disarmed.
 */
export function armedBlock(): { title: string; body: string } | null {
  const l = useLink.getState();
  if (l.status !== "connected" || l.virtual || !l.vehicle?.armed) return null;
  return { title: "Disarm before changing the mission", body: "The aircraft is armed. A mission sent now would replace the one it may be flying. Land, disarm, and send again." };
}

/** Why an aircraft turns a mission down, as MAV_MISSION_RESULT numbers them. */
const MISSION_RESULT: Record<number, string> = {
  1: "it reported an error",
  2: "it does not support the height reference used",
  3: "it does not support one of the commands",
  4: "it has no room for that many items",
  5: "one of the items has a value it will not accept",
  6: "a wait or radius is out of range",
  7: "a value is out of range",
  8: "a value is out of range",
  9: "a value is out of range",
  10: "a position is out of range",
  11: "a position is out of range",
  12: "a height is out of range",
  13: "the items arrived out of order",
  14: "it is busy and refused",
  15: "the transfer was cancelled",
};

/** What differs between a mission sent and the one read back; null when nothing does. */
export function compareMissions(sent: MissionWire[], got: MissionWire[]): string | null {
  if (got.length !== sent.length) return `${sent.length - 1} commands were sent and the aircraft holds ${Math.max(0, got.length - 1)}.`;
  for (let i = 1; i < sent.length; i++) {
    const a = sent[i];
    const b = got[i];
    if (a.command !== b.command) return `Command ${i} was sent as type ${a.command} and reads back as type ${b.command}.`;
    // A command with no place and no height (return home, land where you are) has no height reference
    // to compare: ArduPilot stores none for it and reports its own default.
    const placed = a.x !== 0 || a.y !== 0 || a.z !== 0;
    if (placed && a.frame !== b.frame) return `Command ${i} reads back with a different height reference.`;
    if (Math.abs(a.z - b.z) > 0.05) return `Command ${i} was sent with a height of ${a.z} m and reads back as ${b.z} m.`;
    // One unit is about a centimetre on the ground.
    if (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2) return `Command ${i} reads back at a different position.`;
    if (a.command === 211 || a.command === 183) {
      // A payload release: which release, and open or closed. Release coming back as grab is the one mistake that matters most.
      if (Math.round(a.p1) !== Math.round(b.p1)) return `Command ${i} (${a.command === 211 ? "gripper" : "set servo"}) reads back for ${a.command === 211 ? "a different gripper" : `output ${Math.round(b.p1)} instead of ${Math.round(a.p1)}`}.`;
      if (Math.round(a.p2) !== Math.round(b.p2)) return a.command === 211 ? `Command ${i} was sent to ${Math.round(a.p2) === 0 ? "release" : "grab"} and reads back as ${Math.round(b.p2) === 0 ? "release" : "grab"}.` : `Command ${i} was sent to move output ${Math.round(a.p1)} to ${Math.round(a.p2)} µs and reads back as ${Math.round(b.p2)} µs.`;
      continue;
    }
    if (Math.abs(a.p1 - b.p1) > 0.01) return a.command === 94 ? `Command ${i} (lower and release) reads back with a different give-up depth.` : `Command ${i} reads back with a different wait.`;
  }
  return null;
}

/** One mission item as MISSION_ITEM_INT carries it: x and y are degrees × 1e7. */
export interface MissionWire {
  seq: number;
  frame: number;
  command: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  x: number;
  y: number;
  z: number;
}

/** MAV_MISSION_TYPE: the three lists a vehicle keeps. */
export const MISSION_TYPE = { MISSION: 0, FENCE: 1, RALLY: 2 } as const;

// MAV_CMD ids used here.
export const CMD = {
  PREFLIGHT_CALIBRATION: 241,
  PREFLIGHT_REBOOT_SHUTDOWN: 246,
  DO_START_MAG_CAL: 42424,
  DO_ACCEPT_MAG_CAL: 42425,
  DO_CANCEL_MAG_CAL: 42426,
  DO_MOTOR_TEST: 209,
  SET_MESSAGE_INTERVAL: 511,
  COMPONENT_ARM_DISARM: 400,
  DO_SET_MODE: 176,
  NAV_TAKEOFF: 22,
  MISSION_START: 300,
  DO_SET_SERVO: 183,
  DO_GRIPPER: 211,
  REQUEST_MESSAGE: 512,
} as const;

// ArduCopter flight-mode numbers (custom_mode).
export const COPTER_MODE = {
  STABILIZE: 0,
  ALT_HOLD: 2,
  AUTO: 3,
  GUIDED: 4,
  LOITER: 5,
  RTL: 6,
  LAND: 9,
  BRAKE: 17,
} as const;

// SET_POSITION_TARGET_LOCAL_NED constants (verified against ArduPilot guided-mode docs).
const FRAME_BODY_OFFSET_NED = 9; // velocity is forward/right/down relative to heading
const TYPEMASK_VEL_YAWRATE = 1479; // use vx,vy,vz + yaw_rate; ignore position, accel, yaw
const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
// GCS heartbeat identity.
const MAV_TYPE_GCS = 6;
const MAV_AUTOPILOT_INVALID = 8;
const MAV_STATE_ACTIVE = 4;

// MOTOR_TEST_THROTTLE_TYPE
const MOTOR_TEST_THROTTLE_PERCENT = 0;

// MAV_RESULT
export const MAV_RESULT: Record<number, string> = {
  0: "Accepted",
  1: "Temporarily rejected",
  2: "Denied",
  3: "Unsupported",
  4: "Failed",
  5: "In progress",
  6: "Cancelled",
};
const MAV_PARAM_TYPE_REAL32 = 9;

/** How long the parameter stream must be quiet before gaps are chased, ms. */
const PARAM_QUIET_MS = 1500;
/** Missing parameters asked for per second. */
const FILL_BATCH = 24;
const FILL_BATCH_MAX = 96;
/** Rounds of chasing after which the vehicle is taken to have stopped answering. */
/** Give up filling gaps after this many quiet seconds in a row with nothing new arriving. */
const MAX_STALLED_ROUNDS = 10;

type SendFn = (bytes: Uint8Array) => Promise<void> | void;

interface PendingCmd {
  resolve: (result: number) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CommandLink {
  private send: SendFn | null = null;
  private pendingCmds = new Map<number, PendingCmd>();
  private pendingParams = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Which parameter indices have arrived in the current list download. */
  private seenIndices = new Set<number>();
  private fillTimer: ReturnType<typeof setInterval> | null = null;
  private fillRounds = 0;
  private stalledRounds = 0;
  private fillBatch = FILL_BATCH;
  private lastAsked = 0;
  private seenAtLastRound = 0;

  private taps = new Set<(name: string, d: Decoded) => void>();

  /** Called by the link manager when the port's writer is ready / gone. */
  attach(send: SendFn) {
    this.send = send;
  }

  /** Hear every message the session forwards here (log download). Returns a function that stops it. */
  tap(fn: (name: string, d: Decoded) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** Send one message to the connected aircraft, its target fields filled in. */
  async post(name: string, fields: Record<string, number | string | number[]>) {
    const t = this.target();
    await this.write(name, { target_system: t.sysid, target_component: t.compid, ...fields });
  }
  detach() {
    this.send = null;
    this.stopHeartbeat();
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.fillTimer = null;
    this.seenIndices.clear();
    /*
      Settle what was waiting. The timers used to be cleared and the promises
      simply dropped, so a command in flight when the cable came out never
      resolved or rejected: whatever was awaiting it — a calibration step, a
      mode change — stayed "working" on screen until the page was reloaded.
    */
    for (const p of this.pendingCmds.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Link closed"));
    }
    for (const p of this.pendingParams.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Link closed"));
    }
    this.pendingCmds.clear();
    this.pendingParams.clear();
    for (const u of [...this.ups.values()]) u.reject(new Error("Link closed"));
    for (const d of [...this.downs.values()]) d.reject(new Error("Link closed"));
  }

  get canSend() {
    return !!this.send && !!useLink.getState().vehicle;
  }

  private target() {
    const v = useLink.getState().vehicle;
    if (!v) throw new Error("No vehicle connected");
    return { sysid: v.sysid, compid: v.compid };
  }

  private async write(name: string, fields: Record<string, number | string | number[]>) {
    if (!this.send) throw new Error("The serial link is not open for writing.");
    await this.send(encode(name, fields, GCS));
  }

  // ---- low-level ----

  /**
   * Send a COMMAND_LONG and resolve with the MAV_RESULT from its COMMAND_ACK.
   *
   * `retries`: how many more times to send it when no reply comes within
   * `timeoutMs`, with `confirmation` counted up each time, as the MAVLink
   * command protocol lays down. Over a telemetry radio a command or its reply
   * is lost now and then; sent once, a mode change that had in fact been made
   * was reported as failed. Only commands that are harmless to receive twice
   * are retried (arm/disarm, a mode, a take-off); calibrations, reboots and
   * mission start are not, since a second one would start them over again.
   */
  sendCommand(command: number, params: Partial<Record<"p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7", number>> = {}, confirmation = 0, timeoutMs = 4000, retries = 0): Promise<number> {
    const fields = this.cmdFields(command, params);
    return new Promise<number>((resolve, reject) => {
      const prev = this.pendingCmds.get(command);
      if (prev) {
        clearTimeout(prev.timer);
        prev.resolve(-1);
      }
      let attempt = 0;
      const entry: PendingCmd = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      const live = () => this.pendingCmds.get(command) === entry;
      const transmit = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (!live()) return;
          if (attempt < retries && this.send) {
            attempt++;
            transmit();
            return;
          }
          this.pendingCmds.delete(command);
          reject(new Error(attempt > 0 ? `No reply from the vehicle after ${attempt + 1} tries.` : "No acknowledgement from the vehicle (timed out)."));
        }, timeoutMs);
        this.write("COMMAND_LONG", { ...fields, confirmation: Math.min(255, confirmation + attempt) }).catch((e) => {
          if (!live()) return;
          clearTimeout(entry.timer);
          this.pendingCmds.delete(command);
          reject(e as Error);
        });
      };
      this.pendingCmds.set(command, entry);
      transmit();
    });
  }

  /** Throws when the linked vehicle is not ArduCopter (see vehicleBlock). */
  private requireCopter() {
    const b = vehicleBlock();
    if (b) throw blocked(b);
  }

  /** Calibration is for ArduCopter, on the ground: a sensor calibration in flight is never intended. */
  private requireCalibratable() {
    this.requireCopter();
    if (useLink.getState().vehicle?.armed) throw new Error("Disarm before calibrating. The aircraft is armed.");
  }

  /**
   * Write one parameter and resolve when the vehicle echoes the new value.
   *
   * Refused when the value is not a finite number, and on an armed aircraft
   * unless the caller has had the operator confirm it (`armedOk`): a setting
   * takes effect the moment it is written, and the setup pages that write on
   * every change were never meant for use in flight.
   */
  setParam(id: string, value: number, timeoutMs = 4000, armedOk = false): Promise<void> {
    const t = this.target();
    if (!Number.isFinite(value)) return Promise.reject(new Error(`${id} was not written: ${String(value)} is not a number.`));
    if (!armedOk && useLink.getState().vehicle?.armed) return Promise.reject(new Error(`${id} was not written: disarm first. The aircraft is armed.`));
    useParams.getState().markPending(id, value);
    return new Promise<void>((resolve, reject) => {
      const prev = this.pendingParams.get(id);
      if (prev) {
        clearTimeout(prev.timer);
        prev.reject(new Error("Superseded"));
      }
      const timer = setTimeout(() => {
        this.pendingParams.delete(id);
        useParams.getState().markFailed(id);
        reject(new Error(`No confirmation for ${id} (timed out).`));
      }, timeoutMs);
      this.pendingParams.set(id, { resolve, reject, timer });
      this.write("PARAM_SET", { target_system: t.sysid, target_component: t.compid, param_id: id, param_value: value, param_type: MAV_PARAM_TYPE_REAL32 }).catch((e) => {
        clearTimeout(timer);
        this.pendingParams.delete(id);
        useParams.getState().markFailed(id);
        reject(e as Error);
      });
    });
  }

  /** Request a single parameter by name (param_index = -1 means "by id"). */
  async requestParam(id: string) {
    const t = this.target();
    await this.write("PARAM_REQUEST_READ", { target_system: t.sysid, target_component: t.compid, param_id: id, param_index: -1 });
  }

  /** Request a set of parameters by name, spaced slightly to avoid flooding. */
  async requestParams(ids: string[]) {
    for (const id of ids) {
      if (!this.canSend) return;
      await this.requestParam(id).catch(() => {});
      await delay(12);
    }
  }

  /** Download the whole list again from the start (Refresh). */
  async requestAllParams() {
    const t = this.target();
    this.seenIndices.clear();
    this.fillRounds = 0;
    useParams.getState().setList("downloading");
    await this.write("PARAM_REQUEST_LIST", { target_system: t.sysid, target_component: t.compid });
    this.watchParamList();
  }

  /** Is the full list here? Every index seen, or every name (some arrive by name). */
  private listComplete(): boolean {
    const { count, received } = useParams.getState();
    return count != null && count > 0 && (this.seenIndices.size >= count || received >= count);
  }

  /**
   * Make sure the full list is here or on its way. Called when a vehicle
   * connects and by any page that needs every parameter. A page reading a
   * few settings by name no longer counts as having the list: that used to
   * leave the Parameters page at "14 of 1,370" until the next reconnect.
   */
  async ensureParamList() {
    if (!this.canSend || this.fillTimer) return;
    if (this.listComplete()) {
      useParams.getState().setList("complete");
      return;
    }
    // Indices already seen are kept: only the missing ones are asked for.
    if (this.seenIndices.size > 0 && useParams.getState().count != null) {
      this.fillRounds = 0;
      useParams.getState().setList("downloading");
      this.watchParamList(true);
      return;
    }
    await this.requestAllParams();
  }

  /**
   * Fill the gaps in a parameter download.
   *
   * The vehicle answers a list request with one message per parameter and
   * does not resend any that are lost — and on a telemetry radio some always
   * are. The download then sat at "1,187 of 1,204" indefinitely, with the
   * missing ones simply absent from the list. Once the stream goes quiet,
   * whatever indices have not been seen are asked for by number, a batch at a
   * time, until the list is whole or the vehicle has plainly stopped
   * answering.
   */
  private watchParamList(fillNow = false) {
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.stalledRounds = 0;
    this.fillBatch = FILL_BATCH;
    this.lastAsked = 0;
    this.seenAtLastRound = this.seenIndices.size;
    const stop = (state: "complete" | "incomplete" | null) => {
      if (this.fillTimer) clearInterval(this.fillTimer);
      this.fillTimer = null;
      if (state) useParams.getState().setList(state);
    };
    this.fillTimer = setInterval(() => {
      const { count, lastUpdateAt } = useParams.getState();
      if (!this.canSend) return stop(null);
      if (this.listComplete()) return stop("complete");
      if (count == null) {
        // Nothing at all came back: the list request itself was lost.
        this.fillRounds++;
        if (this.fillRounds % 3 === 0) {
          const t = this.target();
          void this.write("PARAM_REQUEST_LIST", { target_system: t.sysid, target_component: t.compid }).catch(() => {});
        }
        if (this.fillRounds >= 15) stop("incomplete");
        return;
      }
      if (!fillNow && lastUpdateAt != null && Date.now() - lastUpdateAt < PARAM_QUIET_MS) return;
      fillNow = false;
      // Keep asking while answers keep coming; stop once the vehicle has
      // plainly gone quiet, however many rounds that took.
      const gained = this.seenIndices.size - this.seenAtLastRound;
      if (gained > 0) this.stalledRounds = 0;
      else if (this.fillRounds > 0 && ++this.stalledRounds >= MAX_STALLED_ROUNDS) return stop("incomplete");
      // A batch answered in full means the link has room: ask for more next time.
      this.fillBatch = this.fillRounds > 0 && gained >= this.lastAsked ? Math.min(this.fillBatch * 2, FILL_BATCH_MAX) : FILL_BATCH;
      this.seenAtLastRound = this.seenIndices.size;
      this.fillRounds++;
      const t = this.target();
      let asked = 0;
      for (let i = 0; i < count && asked < this.fillBatch; i++) {
        if (this.seenIndices.has(i)) continue;
        asked++;
        void this.write("PARAM_REQUEST_READ", { target_system: t.sysid, target_component: t.compid, param_id: "", param_index: i }).catch(() => {});
      }
      this.lastAsked = asked;
    }, 1000);
  }

  /** Ask for a message to be streamed at a given rate (Hz) via SET_MESSAGE_INTERVAL. */
  async requestMessageInterval(msgId: number, hz: number) {
    const interval = hz > 0 ? Math.round(1e6 / hz) : -1;
    await this.sendCommand(CMD.SET_MESSAGE_INTERVAL, { p1: msgId, p2: interval }, 0, 2000).catch(() => {});
  }

  // ---- GCS heartbeat (required for the vehicle's GCS failsafe to work) ----

  /**
   * Stream a 1 Hz GCS heartbeat. ArduPilot's GCS failsafe only arms once it has
   * seen heartbeats from the GCS; if they then stop (tab closed / app crash) for
   * FS_GCS_TIMEOUT seconds it triggers the configured action (we use Land). The
   * timer lives in the browser, so closing the tab stops it — which is the point.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const beat = () => {
      if (!this.send) return;
      this.write("HEARTBEAT", { custom_mode: 0, type: MAV_TYPE_GCS, autopilot: MAV_AUTOPILOT_INVALID, base_mode: 0, system_status: MAV_STATE_ACTIVE, mavlink_version: 3 }).catch(() => {});
    };
    beat();
    this.heartbeatTimer = setInterval(beat, 1000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---- guided flight ----

  /**
   * Arm or disarm the motors (MAV_CMD_COMPONENT_ARM_DISARM), never forced:
   * the autopilot's own pre-arm checks always apply. Disarming is allowed on
   * any vehicle, since stopping the motors is never the wrong thing to be
   * able to ask for.
   */
  async arm(shouldArm: boolean): Promise<number> {
    if (shouldArm) this.requireCopter();
    return this.sendCommand(CMD.COMPONENT_ARM_DISARM, { p1: shouldArm ? 1 : 0, p2: 0 }, 0, 1500, 2);
  }

  /** Switch flight mode via MAV_CMD_DO_SET_MODE using an ArduCopter custom mode number. */
  async setMode(customMode: number): Promise<number> {
    this.requireCopter();
    return this.sendCommand(CMD.DO_SET_MODE, { p1: MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, p2: customMode }, 0, 1500, 2);
  }

  /** Command an autonomous takeoff to the given altitude (metres). Requires Guided + armed. */
  async guidedTakeoff(altitudeM: number): Promise<number> {
    this.requireCopter();
    if (!Number.isFinite(altitudeM) || altitudeM <= 0) throw new Error("Take-off height must be a positive number of metres.");
    return this.sendCommand(CMD.NAV_TAKEOFF, { p7: altitudeM }, 0, 1500, 2);
  }

  /**
   * Stream a body-relative velocity target: vx forward, vy right, vz down (m/s),
   * yawRate rad/s (clockwise positive). No ACK — resend at a few Hz while flying.
   * The vehicle brakes to a stop by itself ~3 s after the last one (dead-man hold).
   */
  setVelocityBody(vx: number, vy: number, vz: number, yawRate: number) {
    // Called from a timer at several hertz. If the vehicle has gone there is
    // nothing to send to, and throwing out of a timer helps nobody.
    if (!this.canSend || vehicleBlock()) return;
    if (![vx, vy, vz, yawRate].every(Number.isFinite)) return;
    const t = this.target();
    void this.write("SET_POSITION_TARGET_LOCAL_NED", {
      time_boot_ms: 0,
      x: 0, y: 0, z: 0,
      vx, vy, vz,
      afx: 0, afy: 0, afz: 0,
      yaw: 0, yaw_rate: yawRate,
      type_mask: TYPEMASK_VEL_YAWRATE,
      target_system: t.sysid,
      target_component: t.compid,
      coordinate_frame: FRAME_BODY_OFFSET_NED,
    }).catch(() => {});
  }

  /** Request the standard ArduPilot data streams (MAV_DATA_STREAM groups) so the
      vehicle actually sends attitude, position, GPS, battery, RC, EKF and
      vibration. ArduPilot sends little beyond the heartbeat until asked. */
  async requestDataStreams() {
    if (!this.canSend) return;
    const t = this.target();
    // [MAV_DATA_STREAM id, rate Hz]
    const streams: [number, number][] = [
      [2, 2], // EXTENDED_STATUS: SYS_STATUS (sensor health), GPS_RAW_INT
      [6, 3], // POSITION: GLOBAL_POSITION_INT
      [10, 10], // EXTRA1: ATTITUDE
      [11, 4], // EXTRA2: VFR_HUD
      [12, 3], // EXTRA3: VIBRATION, EKF_STATUS_REPORT
      [3, 5], // RC_CHANNELS
      [1, 2], // RAW_SENSORS
    ];
    for (const [id, hz] of streams) {
      await this.write("REQUEST_DATA_STREAM", { target_system: t.sysid, target_component: t.compid, req_stream_id: id, req_message_rate: hz, start_stop: 1 }).catch(() => {});
    }
    // Which board this is and its firmware version (AUTOPILOT_VERSION, message 148), once.
    if (!useLink.getState().telemetry.autopilot) await this.sendCommandNoAck(CMD.REQUEST_MESSAGE, { p1: 148 });
  }

  /**
   * Move one output to a pulse width (MAV_CMD_DO_SET_SERVO), as a mission's
   * "set servo" does. ArduPilot only moves an output that nothing else drives:
   * one set to Disabled, a sprayer, the gripper or an RC pass-through; for
   * any other it answers "Channel n is already in use". Resolves to the
   * MAV_RESULT. Allowed armed (a payload is released in flight), on ArduCopter.
   */
  setServo(output: number, pwm: number): Promise<number> {
    this.requireCopter();
    if (!Number.isInteger(output) || output < 1 || output > 32) return Promise.reject(new Error(`There is no output ${output}.`));
    if (!Number.isFinite(pwm) || pwm < 500 || pwm > 2500) return Promise.reject(new Error(`${pwm} µs is not a pulse width a servo takes (500-2500).`));
    return this.sendCommand(CMD.DO_SET_SERVO, { p1: output, p2: Math.round(pwm) });
  }

  /** Open (release) or close (grab) the gripper (MAV_CMD_DO_GRIPPER). Fails unless the gripper is enabled and the board was restarted since. */
  gripper(action: "release" | "grab"): Promise<number> {
    this.requireCopter();
    return this.sendCommand(CMD.DO_GRIPPER, { p1: 1, p2: action === "grab" ? 1 : 0 });
  }

  /** Fire-and-forget COMMAND_LONG (no ACK wait) — for commands resent at a rate. */
  private async sendCommandNoAck(command: number, params: Partial<Record<"p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7", number>>) {
    await this.write("COMMAND_LONG", this.cmdFields(command, params)).catch(() => {});
  }

  // ---- motor test ----

  /** Spin one motor (1-based, in test order) at a throttle %, auto-stopping after
      `timeoutS` so the motor halts if the GCS stops resending (dead-man safety). */
  async motorTest(motor: number, throttlePct: number, timeoutS = 3) {
    // Stopping a motor is always allowed; spinning one only on ArduCopter, disarmed.
    if (vehicleBlock() || useLink.getState().vehicle?.armed || !Number.isFinite(throttlePct)) return;
    await this.sendCommandNoAck(CMD.DO_MOTOR_TEST, { p1: motor, p2: MOTOR_TEST_THROTTLE_PERCENT, p3: Math.max(0, Math.min(100, throttlePct)), p4: timeoutS, p5: 0, p6: 0 });
  }

  /** Stop one motor immediately (throttle 0, zero timeout). */
  async stopMotor(motor: number) {
    await this.sendCommandNoAck(CMD.DO_MOTOR_TEST, { p1: motor, p2: MOTOR_TEST_THROTTLE_PERCENT, p3: 0, p4: 0, p5: 0, p6: 0 });
  }

  async stopAllMotors(count: number) {
    for (let i = 1; i <= count; i++) await this.stopMotor(i);
  }

  // ---- accelerometer / level / gyro ----

  async startAccelCal() {
    useCalibration.getState().setAccel({ phase: "running", step: 0, prompt: null, awaitingConfirm: false, message: "Starting — keep the vehicle still for the gyro check." });
    try {
      this.requireCalibratable();
      await this.write("COMMAND_LONG", { ...this.cmdFields(CMD.PREFLIGHT_CALIBRATION, { p5: 1 }) });
    } catch (e) {
      useCalibration.getState().setAccel({ phase: "failed", message: (e as Error).message });
    }
  }

  /** Confirm the vehicle is in the requested position: ArduPilot expects a
      COMMAND_ACK carrying the step counter, then streams the next prompt. */
  async confirmAccelPosition() {
    const a = useCalibration.getState().accel;
    if (a.phase !== "running" || !a.awaitingConfirm) return;
    const step = a.step;
    useCalibration.getState().setAccel({ awaitingConfirm: false, prompt: null, step: step + 1, message: "Captured — collecting sample…" });
    try {
      await this.write("COMMAND_ACK", { command: step, result: 1 });
    } catch (e) {
      useCalibration.getState().setAccel({ phase: "failed", message: (e as Error).message });
    }
  }

  async startLevel() {
    useCalibration.getState().setLevel({ phase: "running", message: "Hold the vehicle level and still…" });
    try {
      this.requireCalibratable();
      const r = await this.sendCommand(CMD.PREFLIGHT_CALIBRATION, { p5: 2 }, 0, 8000);
      const ok = r === 0;
      useCalibration.getState().setLevel({ phase: ok ? "success" : "failed", message: ok ? "Level set." : `Vehicle returned: ${MAV_RESULT[r] ?? r}` });
    } catch (e) {
      useCalibration.getState().setLevel({ phase: "failed", message: (e as Error).message });
    }
  }

  async startGyro() {
    useCalibration.getState().setGyro({ phase: "running", message: "Keep the vehicle completely still…" });
    try {
      this.requireCalibratable();
      const r = await this.sendCommand(CMD.PREFLIGHT_CALIBRATION, { p1: 1 }, 0, 8000);
      const ok = r === 0;
      useCalibration.getState().setGyro({ phase: ok ? "success" : "failed", message: ok ? "Gyros calibrated." : `Vehicle returned: ${MAV_RESULT[r] ?? r}` });
    } catch (e) {
      useCalibration.getState().setGyro({ phase: "failed", message: (e as Error).message });
    }
  }

  // ---- compass (onboard MagCal) ----

  async startMagCal() {
    useCalibration.getState().setMag({ phase: "running", compasses: {}, message: "Rotate the vehicle through all orientations.", maxPct: 0, lastAdvanceAt: Date.now() });
    try {
      this.requireCalibratable();
      // p1=0 all compasses, p2=0 no auto-retry, p3=1 autosave on success, p5=0 no auto-reboot
      await this.sendCommand(CMD.DO_START_MAG_CAL, { p1: 0, p2: 0, p3: 1, p5: 0 }, 0, 4000);
    } catch (e) {
      useCalibration.getState().setMag({ phase: "failed", message: (e as Error).message });
    }
  }

  async cancelMagCal() {
    try {
      await this.sendCommand(CMD.DO_CANCEL_MAG_CAL, { p3: 1 }, 0, 3000);
    } catch {
      /* best effort */
    }
    useCalibration.getState().setMag({ phase: "cancelled", message: "Calibration cancelled." });
  }

  async acceptMagCal() {
    try {
      await this.sendCommand(CMD.DO_ACCEPT_MAG_CAL, { p3: 1 }, 0, 3000);
      useCalibration.getState().setMag({ message: "Calibration accepted and saved." });
    } catch (e) {
      useCalibration.getState().setMag({ message: (e as Error).message });
    }
  }

  /**
   * Why the flight controller may not be restarted right now; null when it may.
   *
   * Never while armed: a restart in the air is a fall. ArduPilot refuses it
   * too, but the refusal should not depend on the firmware alone.
   *
   * Never with an ESC calibration waiting: with ESC_CALIBRATION at 2 or 3
   * ArduCopter sends full throttle to every ESC as it starts
   * (esc_calibration.cpp), and ESCs that are already powered spin the motors
   * at full power. That start is to be made by plugging the battery in, with
   * the propellers off, not from a button.
   */
  rebootBlock(): { title: string; body: string } | null {
    const l = useLink.getState();
    if (l.vehicle?.armed) return { title: "Disarm before restarting", body: "The aircraft is armed. Restarting the flight controller now would stop its motors. Land and disarm first." };
    const esc = useParams.getState().values.ESC_CALIBRATION;
    if (!l.virtual && (esc === 2 || esc === 3)) {
      return {
        title: "An ESC calibration is waiting",
        body: "ESC_CALIBRATION is set, so the flight controller will send full throttle to the ESCs the next time it starts. Do not restart it from here: remove the propellers, unplug the battery and USB, and plug the battery back in. To cancel instead, clear the calibration flag on the Calibration page, ESC tab.",
      };
    }
    return null;
  }

  /** Restart the flight controller. Throws, in words, when it must not be restarted now (see rebootBlock). */
  async reboot() {
    const block = this.rebootBlock();
    if (block) throw blocked(block);
    // param1=1: reboot autopilot. Best-effort — the vehicle drops the link as it reboots.
    try {
      await this.write("COMMAND_LONG", { ...this.cmdFields(CMD.PREFLIGHT_REBOOT_SHUTDOWN, { p1: 1 }) });
    } catch {
      /* link will drop; that's expected */
    }
  }

  private cmdFields(command: number, p: Partial<Record<"p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7", number>>) {
    const t = this.target();
    return {
      target_system: t.sysid,
      target_component: t.compid,
      command,
      confirmation: 0,
      param1: p.p1 ?? 0,
      param2: p.p2 ?? 0,
      param3: p.p3 ?? 0,
      param4: p.p4 ?? 0,
      param5: p.p5 ?? 0,
      param6: p.p6 ?? 0,
      param7: p.p7 ?? 0,
    };
  }

  // ---- inbound routing (called by the link manager for each decoded frame) ----

  // ---- missions ----

  /**
   * Send a mission to the vehicle with the MAVLink mission protocol: announce
   * the count, then answer each request for an item until the vehicle
   * acknowledges the set. The same exchange a Pixhawk expects.
   */
  uploadMission(items: MissionWire[]): Promise<void> {
    // Whatever page asks, a real aircraft without a GPS position is not given a mission,
    // and neither is one that is armed.
    const block = vehicleBlock() ?? missionBlock() ?? armedBlock();
    if (block) return Promise.reject(blocked(block));
    return this.uploadList(items, MISSION_TYPE.MISSION, "mission");
  }

  /**
   * Send the fence zones (MISSION_TYPE_FENCE). Not to an armed real aircraft:
   * a fence changed in flight acts at once, and a mistake in it turns the
   * aircraft round or lands it wherever it is.
   */
  uploadFence(items: MissionWire[]): Promise<void> {
    const l = useLink.getState();
    const block = vehicleBlock() ?? (l.status === "connected" && !l.virtual && l.vehicle?.armed ? { title: "Disarm before changing the fence", body: "The aircraft is armed. A fence changed now acts at once, in flight. Land, disarm, and send it again." } : null);
    if (block) return Promise.reject(blocked(block));
    return this.uploadList(items, MISSION_TYPE.FENCE, "fence");
  }

  /** Read the mission the vehicle holds. */
  downloadMission(): Promise<MissionWire[]> {
    return this.downloadList(MISSION_TYPE.MISSION, "mission");
  }

  /** Read the fence zones the vehicle holds. */
  downloadFence(): Promise<MissionWire[]> {
    return this.downloadList(MISSION_TYPE.FENCE, "fence");
  }

  private uploadList(items: MissionWire[], type: number, what: string): Promise<void> {
    const t = this.target();
    /*
      The last check before anything is sent, whichever page built the list:
      every number must be a number, and every place a place on the Earth. A
      value that is not a number (an emptied height box, a division by zero
      upstream) would otherwise be encoded as NaN and decided by the firmware.
    */
    for (const it of items) {
      const nums = [it.seq, it.frame, it.command, it.p1, it.p2, it.p3, it.p4, it.x, it.y, it.z];
      if (!nums.every(Number.isFinite)) return Promise.reject(new Error(`The ${what} was not sent: item ${it.seq} holds a value that is not a number.`));
      if (Math.abs(it.x) > 90e7 || Math.abs(it.y) > 180e7) return Promise.reject(new Error(`The ${what} was not sent: item ${it.seq} is not at a place on the Earth.`));
    }
    if (items.some((it, i) => it.seq !== i)) return Promise.reject(new Error(`The ${what} was not sent: its items are not numbered in order.`));
    this.ups.get(type)?.reject(new Error("Superseded by a newer upload"));
    return new Promise<void>((resolve, reject) => {
      let tries = 0;
      const announce = () => {
        void this.write("MISSION_COUNT", { target_system: t.sysid, target_component: t.compid, count: items.length, mission_type: type }).catch(reject);
      };
      const arm = () =>
        setTimeout(() => {
          const u = this.ups.get(type);
          if (!u) return;
          if (++tries > 4) {
            this.ups.delete(type);
            reject(new Error(`The aircraft stopped answering during the ${what} upload.`));
            return;
          }
          if (u.sent === 0) announce();
          u.timer = arm();
        }, 1500);
      const done = () => {
        const u = this.ups.get(type);
        if (u) clearTimeout(u.timer);
        this.ups.delete(type);
      };
      this.ups.set(type, {
        items,
        sent: 0,
        said: [],
        what,
        timer: arm(),
        resolve: () => {
          done();
          resolve();
        },
        reject: (e) => {
          done();
          reject(e);
        },
        touch: () => {
          tries = 0;
        },
      });
      announce();
    });
  }

  private downloadList(type: number, what: string): Promise<MissionWire[]> {
    const t = this.target();
    this.downs.get(type)?.reject(new Error("Superseded by a newer download"));
    return new Promise<MissionWire[]>((resolve, reject) => {
      /*
        Over a telemetry radio a message is lost now and then. Each request is
        asked again if its answer does not come, five times, as the protocol
        lays down; only then is the read given up.
      */
      let tries = 0;
      const ask = () => {
        const m = this.downs.get(type);
        if (!m) return;
        if (m.count < 0) void this.write("MISSION_REQUEST_LIST", { target_system: t.sysid, target_component: t.compid, mission_type: type }).catch(() => {});
        else void this.write("MISSION_REQUEST_INT", { target_system: t.sysid, target_component: t.compid, seq: m.items.length, mission_type: type }).catch(() => {});
      };
      const arm = (): ReturnType<typeof setTimeout> =>
        setTimeout(() => {
          const m = this.downs.get(type);
          if (!m) return;
          if (++tries > 5) {
            m.reject(new Error(m.count < 0 ? `The aircraft did not answer the request for its ${what}.` : `The aircraft stopped answering at item ${m.items.length} of ${m.count} of its ${what}. Check the link and read again.`));
            return;
          }
          ask();
          m.timer = arm();
        }, 1200);
      const done = () => {
        const m = this.downs.get(type);
        if (m) clearTimeout(m.timer);
        this.downs.delete(type);
      };
      this.downs.set(type, {
        count: -1,
        items: [],
        what,
        timer: arm(),
        touch: () => {
          tries = 0;
          const m = this.downs.get(type);
          if (m) {
            clearTimeout(m.timer);
            m.timer = arm();
          }
        },
        resolve: (m) => {
          done();
          resolve(m);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      ask();
    });
  }

  async startMission(): Promise<number> {
    const block = vehicleBlock() ?? missionBlock();
    if (block) throw blocked(block);
    // Not retried: with MIS_RESTART = 1 a second start sends the aircraft back to the first item.
    return this.sendCommand(CMD.MISSION_START, {});
  }

  private ups = new Map<number, { items: MissionWire[]; sent: number; said: string[]; what: string; timer: ReturnType<typeof setTimeout>; resolve: () => void; reject: (e: Error) => void; touch: () => void }>();
  private downs = new Map<number, { count: number; items: MissionWire[]; what: string; timer: ReturnType<typeof setTimeout>; touch: () => void; resolve: (m: MissionWire[]) => void; reject: (e: Error) => void }>();

  /**
   * Reads the mission back and compares it with what was sent. Null when they
   * match; otherwise what differs, in words. Item 0 is home, which the
   * aircraft keeps for itself, so it is not compared.
   */
  async verifyMission(sent: MissionWire[]): Promise<string | null> {
    const got = await this.downloadMission();
    return compareMissions(sent, got);
  }

  private onMission(name: string, d: Decoded) {
    const t = this.target();
    // MAVLink 1 has no mission_type: then it is the mission.
    const type = (d.mission_type as number | undefined) ?? 0;
    const up = this.ups.get(type);
    const down = this.downs.get(type);
    if ((name === "MISSION_REQUEST_INT" || name === "MISSION_REQUEST") && up) {
      const it = up.items[d.seq as number];
      if (!it) return;
      up.sent = Math.max(up.sent, (d.seq as number) + 1);
      up.touch();
      void this.write("MISSION_ITEM_INT", {
        target_system: t.sysid, target_component: t.compid, seq: it.seq, frame: it.frame, command: it.command, current: 0, autocontinue: 1,
        param1: it.p1, param2: it.p2, param3: it.p3, param4: it.p4, x: it.x, y: it.y, z: it.z, mission_type: type,
      }).catch(() => {});
    } else if (name === "MISSION_ACK" && up) {
      const result = d.type as number;
      if (result === 0) {
        /*
          "Accepted" counts only once every item has been asked for. An
          acknowledgement left over from an earlier exchange, arriving as this
          one starts, would otherwise report a list as sent that the aircraft
          never took.
        */
        if (up.sent >= up.items.length) up.resolve();
      } else {
        /*
          The firmware says why in a status text, which it queues and sends
          after the refusal itself. Wait a moment for it, so the reason given
          is the aircraft's own ("Fence exceeds storage size") and not only a
          number.
        */
        clearTimeout(up.timer);
        up.timer = setTimeout(() => {
          // Its pre-arm complaints repeat all the while and are not about this list.
          const said = up.said.map((t) => t.replace(/^(Warning|Notice|Error|Critical|Emergency|Alert):\s*/i, "")).filter((t) => !/^(Debug|Info):|^(PreArm|Arm):/i.test(t));
          const why = said.length ? ` It said: "${said[said.length - 1]}".` : "";
          up.reject(new Error(`The aircraft rejected the ${up.what}: ${MISSION_RESULT[result] ?? `result ${result}`}.${why}`));
        }, 700);
      }
    } else if (name === "MISSION_COUNT" && down) {
      const count = d.count as number;
      // A repeated answer to a repeated question must not start the read again.
      if (down.count >= 0) return;
      down.count = count;
      down.touch();
      if (count === 0) down.resolve([]);
      else void this.write("MISSION_REQUEST_INT", { target_system: t.sysid, target_component: t.compid, seq: 0, mission_type: type }).catch(() => {});
    } else if (name === "MISSION_ACK" && down && (d.type as number) !== 0) {
      down.reject(new Error(`The aircraft refused to send its ${down.what} (MAV_MISSION result ${d.type as number}).`));
    } else if (name === "MISSION_ITEM_INT" && down) {
      const m = down;
      if (m.count < 0 || (d.seq as number) !== m.items.length) return;
      m.touch();
      m.items.push({ seq: d.seq as number, frame: d.frame as number, command: d.command as number, p1: d.param1 as number, p2: d.param2 as number, p3: d.param3 as number, p4: d.param4 as number, x: d.x as number, y: d.y as number, z: d.z as number });
      if (m.items.length >= m.count) {
        void this.write("MISSION_ACK", { target_system: t.sysid, target_component: t.compid, type: 0, mission_type: type }).catch(() => {});
        m.resolve(m.items);
      } else void this.write("MISSION_REQUEST_INT", { target_system: t.sysid, target_component: t.compid, seq: m.items.length, mission_type: type }).catch(() => {});
    }
  }

  handle(name: string, d: Decoded) {
    for (const fn of this.taps) {
      try {
        fn(name, d);
      } catch {
        /* a listener's fault is its own */
      }
    }
    if (name.startsWith("MISSION_")) {
      this.onMission(name, d);
      return;
    }
    switch (name) {
      case "COMMAND_ACK": {
        const cmd = d.command as number;
        const result = d.result as number;
        const p = this.pendingCmds.get(cmd);
        if (p) {
          // MAV_RESULT_IN_PROGRESS (5) is not terminal — long commands (e.g.
          // accel/gyro calibration) send it before the final ACK. Keep waiting.
          if (result === 5) {
            clearTimeout(p.timer);
            p.timer = setTimeout(() => {
              this.pendingCmds.delete(cmd);
              p.resolve(-1);
            }, 20000);
            break;
          }
          clearTimeout(p.timer);
          this.pendingCmds.delete(cmd);
          p.resolve(result);
        }
        break;
      }
      case "PARAM_VALUE": {
        const id = (d.param_id as string) ?? "";
        const value = d.param_value as number;
        const count = (d.param_count as number) ?? 0;
        // 65535 is "not part of a list" — the reply to a write, or to a read
        // by name — and is not a position in the download.
        const index = d.param_index as number;
        if (Number.isInteger(index) && index >= 0 && index < 65535) this.seenIndices.add(index);
        useParams.getState().onParamValue(id, value, count, d.param_type as number | undefined);
        const pend = this.pendingParams.get(id);
        // The vehicle echoes a float32; compare against the float32-rounded target
        // with a relative epsilon so large non-integer params still match.
        const target = useParams.getState().pending[id]?.target ?? value;
        if (pend && sameParam(target, value)) {
          clearTimeout(pend.timer);
          this.pendingParams.delete(id);
          pend.resolve();
        }
        break;
      }
      case "STATUSTEXT": {
        const text = String(d.text ?? "");
        // Kept while a list is going up, for the reason if it is refused.
        for (const u of this.ups.values()) u.said = [...u.said, text].slice(-3);
        this.onStatusText(text);
        break;
      }
      case "MAG_CAL_PROGRESS": {
        const cal = useCalibration.getState();
        const id = d.compass_id as number;
        const prev = cal.mag.compasses[id];
        const pct = d.completion_pct as number;
        const coverage = countBits(d.completion_mask as number[] | undefined);
        cal.upsertMagCompass({
          id,
          pct,
          status: d.cal_status as number,
          fitness: prev?.fitness ?? null,
          offsets: prev?.offsets ?? null,
          autosaved: prev?.autosaved ?? false,
          coverage,
        });
        // Track overall progress so the UI can tell when a cal has stalled.
        if (pct > cal.mag.maxPct) cal.setMag({ maxPct: pct, lastAdvanceAt: Date.now() });
        break;
      }
      case "MAG_CAL_REPORT": {
        this.onMagReport(d);
        break;
      }
    }
  }

  private onStatusText(text: string) {
    const cal = useCalibration.getState();
    if (cal.accel.phase !== "running") return;
    // ArduPilot drives 6-point accel cal through STATUSTEXT prompts.
    if (/^place /i.test(text)) {
      cal.setAccel({ prompt: text.replace(/\s*and press any key\.?$/i, ""), awaitingConfirm: true, message: null });
    } else if (/calibration successful/i.test(text)) {
      cal.setAccel({ phase: "success", awaitingConfirm: false, prompt: null, message: "Calibration successful." });
    } else if (/calibration failed|cal failed/i.test(text)) {
      cal.setAccel({ phase: "failed", awaitingConfirm: false, prompt: null, message: text });
    }
  }

  private onMagReport(d: Decoded) {
    const cal = useCalibration.getState();
    const id = d.compass_id as number;
    const status = d.cal_status as number;
    cal.upsertMagCompass({
      id,
      pct: 100,
      status,
      fitness: (d.fitness as number) ?? null,
      offsets: [d.ofs_x as number, d.ofs_y as number, d.ofs_z as number],
      autosaved: (d.autosaved as number) === 1,
      coverage: cal.mag.compasses[id]?.coverage ?? 80,
    });
    // Resolve overall phase from all reported compasses.
    const all = Object.values(useCalibration.getState().mag.compasses);
    const done = all.length > 0 && all.every((c) => c.status >= 4);
    if (done) {
      const ok = all.every((c) => magCalOk(c.status));
      const saved = all.every((c) => c.autosaved);
      cal.setMag({
        phase: ok ? "success" : "failed",
        message: ok ? (saved ? "Compass calibrated and saved. Reboot to apply." : "Compass calibrated. Accept to save, then reboot.") : "Calibration failed on at least one compass. Try again in a clear area.",
      });
      if (ok && !saved) notify("info", "Compass cal complete", "Accept to save the offsets.");
    }
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Count set bits across a byte array (MAG_CAL_PROGRESS completion_mask = 80 sphere sections). */
function countBits(mask: number[] | undefined): number {
  if (!mask) return 0;
  let n = 0;
  for (const byte of mask) {
    let b = byte & 0xff;
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

export const commandLink = new CommandLink();
