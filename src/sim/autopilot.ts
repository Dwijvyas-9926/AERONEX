import { G } from "./airframe";
import { euler, MOTORS, type Physics } from "./physics";
import type { Params } from "./params";
import { breachAt, FENCE_TYPE, GIVE_UP_M, localZones, OPTION_UNION, toBoundary, wireProblem, wireToZones, type FenceWire, type LocalZone } from "../geo/fence";

/*
  A model of ArduCopter's flight controller.

  It is not ArduCopter's code. It is the same cascade, driven by the same
  parameter names in the same units, written from ArduPilot's documentation:
  position error to a velocity target, velocity error to an acceleration,
  acceleration to lean angles and throttle, angle error to a body rate, rate
  error through a PID to the motors. The flight modes, arming checks and
  failsafes follow the documented behaviour. Where the real firmware does
  something subtler — square-root controllers, input shaping, the EKF — this
  does the first-order equivalent, and that is the limit of what a prediction
  made here is worth.
*/

export const MODE = { STABILIZE: 0, ALT_HOLD: 2, AUTO: 3, GUIDED: 4, LOITER: 5, RTL: 6, LAND: 9, BRAKE: 17 } as const;
export const MODE_NAME: Record<number, string> = { 0: "STABILIZE", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED", 5: "LOITER", 6: "RTL", 9: "LAND", 17: "BRAKE" };
const NEEDS_POSITION = new Set<number>([MODE.AUTO, MODE.GUIDED, MODE.LOITER, MODE.RTL, MODE.BRAKE]);

export const CMD = { WAYPOINT: 16, LOITER_UNLIM: 17, LOITER_TIME: 19, RTL: 20, LAND: 21, TAKEOFF: 22, DELAY: 93, PAYLOAD_PLACE: 94, CHANGE_SPEED: 178, SET_SERVO: 183, GRIPPER: 211 } as const;

/** A payload let go in a mission, or the attempt: where, how high, how fast it was moving. */
export interface DeliveryRecord {
  /** The mission item that did it. */
  seq: number;
  kind: "drop" | "lower";
  t: number;
  n: number;
  e: number;
  /** Height above home, and above the ground below, m. */
  alt: number;
  agl: number;
  /** Ground speed, m/s. */
  speed: number;
  /** Payload let go, kg. */
  kg: number;
  /**
   * released: something let go. nothing: the command ran and nothing let go.
   * gave-up: lowering reached its limit without touching and climbed back.
   * aborted: lowering abandoned (PLDP_RNG_MAX with no rangefinder).
   * landed: lowering ended with the aircraft itself on the ground.
   */
  outcome: "released" | "nothing" | "gave-up" | "aborted" | "landed";
}

/** ArduCopter's PayloadPlace, one state at a time (mode_auto.cpp). */
interface PlaceState {
  state: "fly" | "start" | "descend" | "release" | "delay" | "ascent";
  /** The aircraft has settled into the descent. ArduCopter's controller follows its demanded speed closely; this model's lags, so the thrust is not watched until it has caught up. */
  steady: boolean;
  startAlt: number;
  speed: number;
  established: number;
  thrustMin: number;
  placeStart: number;
  releasedAt: number;
  released: boolean;
  landed: boolean;
}

export interface MissionItem {
  seq: number;
  frame: number;
  command: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  /** Latitude and longitude in degrees × 1e7, as MISSION_ITEM_INT carries them. */
  x: number;
  y: number;
  z: number;
}

export interface Home {
  lat: number;
  lon: number;
  altMsl: number;
}

export type Severity = "info" | "warn" | "error";
export interface SimEvent {
  t: number;
  sev: Severity;
  text: string;
  /** A machine-readable tag, for the flight report. */
  kind?: string;
}

/** What the outside world tells the autopilot each step. */
export interface Inputs {
  gpsOk: boolean;
  rcOk: boolean;
  /** Seconds since a ground-station heartbeat was last heard. */
  gcsSilentS: number;
  /** Has a ground station ever been heard? The failsafe only arms once it has. */
  gcsSeen: boolean;
  /** Stick positions −1…1 (roll, pitch, yaw) and throttle 0…1; null when centred. */
  sticks: { roll: number; pitch: number; yaw: number; throttle: number } | null;
}

const M_PER_DEG = 111319.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

class Pid {
  i = 0;
  private prev = 0;
  private d = 0;
  private first = true;
  run(err: number, kp: number, ki: number, kd: number, dt: number, imax: number, saturated: boolean): number {
    if (!saturated || Math.sign(err) !== Math.sign(this.i)) this.i = clamp(this.i + err * ki * dt, -imax, imax);
    const raw = this.first ? 0 : (err - this.prev) / dt;
    this.first = false;
    this.prev = err;
    // 20 Hz low-pass on the derivative, as ATC_RAT_x_FLTD does by default.
    const alpha = dt / (dt + 1 / (2 * Math.PI * 20));
    this.d += (raw - this.d) * alpha;
    return kp * err + this.i + kd * this.d;
  }
  reset() {
    this.i = 0;
    this.d = 0;
    this.first = true;
  }
}

export class Autopilot {
  readonly phys: Physics;
  params: Params;
  home: Home;
  mode: number = MODE.STABILIZE;
  armed = false;
  mission: MissionItem[] = [];
  missionSeq = 0;
  /** The fence zones as the aircraft stores them, and in metres from home. */
  fence: FenceWire[] = [];
  private fenceZones: LocalZone[] = [];
  /** Fence types breached now (FENCE_TYPE bits), and whether the floor has switched itself on. */
  private fenceBreached = 0;
  private floorOn = false;
  /** Bitmask-free list of failsafes that have fired this flight. */
  failsafes = new Set<string>();
  events: SimEvent[] = [];
  /** Motor commands, 0–1, read by the physics. */
  out: [number, number, number, number] = [0, 0, 0, 0];
  throttleOut = 0;
  /** Where it is trying to be: north, east (m) and height (m). */
  target = { n: 0, e: 0, alt: 0, yaw: 0 };
  ekfOk = true;
  landed = true;
  /** Where the current leg ends, for anything measuring progress; null when there is no leg. */
  goal: { n: number; e: number; alt: number } | null = null;
  /** Set by the vehicle wrapper when a waypoint is reached. */
  onReached: ((seq: number) => void) | null = null;
  /**
   * A mission's do command (gripper, servo), carried out by the aircraft
   * around the autopilot. Returns the kilograms of payload that let go.
   */
  onDo: ((item: MissionItem) => number) | null = null;
  /** Payload place opening the gripper: the kilograms let go, or null when there is no gripper to open (AP::gripper().valid()). */
  onPlaceRelease: (() => number | null) | null = null;
  /** Each payload this flight let go, or tried to. */
  deliveries: DeliveryRecord[] = [];
  private place: PlaceState | null = null;
  /** Throttle the height loop asks for, before the lean compensation: what PayloadPlace watches. */
  private thrRaw = 0;

  private rate = [new Pid(), new Pid(), new Pid()];
  private rateTarget = [0, 0, 0];
  private velI = [0, 0];
  private prevVelErr = [0, 0];
  private velD = [0, 0];
  private prevVelCmd = [0, 0];
  private accFF = [0, 0];
  private accI = 0;
  private navSpeed = 0;
  /** Along-track acceleration of the held point, m/s²: changes no faster than the jerk limit. */
  private navAcc = 0;
  /**
   * The desired height and climb rate in position-held flight: a trajectory
   * toward the held height that keeps within WPNAV_SPEED_UP/DN and
   * WPNAV_ACCEL_Z. The height loop then corrects the aircraft onto it.
   */
  private zDes = 0;
  private vzCmd = 0;
  private climbCmd = 0;
  private velCmd = { n: 0, e: 0 };
  private guided: { kind: "hold" | "vel" | "pos" | "takeoff"; vx: number; vy: number; vz: number; yawRate: number; until: number } = { kind: "hold", vx: 0, vy: 0, vz: 0, yawRate: 0, until: 0 };
  private rtl: { stage: "climb" | "return" | "loiter" | "land"; since: number } = { stage: "climb", since: 0 };
  private auto: { started: boolean; legFrom: { n: number; e: number } | null; holdUntil: number | null; speed: number | null; done: boolean; liftAt?: number; rate?: number | null; stopFor?: number } = { started: false, legFrom: null, holdUntil: null, speed: null, done: false };
  private battLowSince: number | null = null;
  private battCrtSince: number | null = null;
  private rcLostSince: number | null = null;
  private gpsLostSince: number | null = null;
  private groundArmedSince: number | null = null;
  private landLowSince: number | null = null;
  private crashSince: number | null = null;
  private lastYawManual = false;

  constructor(phys: Physics, params: Params, home: Home) {
    this.phys = phys;
    this.params = params;
    this.home = home;
  }

  /* ------------------------------------------------------------ helpers */

  log(sev: Severity, text: string, kind?: string) {
    this.events.push({ t: this.phys.s.t, sev, text, kind });
  }

  /**
   * Where home is now, in metres from where the aircraft started (the origin
   * of the simulation) and in height above it. ArduCopter moves home to where
   * it arms, unless home is locked (AP_Arming_Copter::arm_checks), and every
   * height above home, the return and the circle fence go from there.
   */
  homeAt = { n: 0, e: 0, z: 0 };

  /** Height above home, m. */
  get alt() {
    return -this.phys.s.pos[2] - this.homeAt.z;
  }

  /** Height above where the aircraft started, the ground's reference, m. */
  get height() {
    return -this.phys.s.pos[2];
  }

  /** Home, as the aircraft reports it. */
  homeNow(): Home {
    const g = this.toGlobal(this.homeAt.n, this.homeAt.e);
    return { lat: g.lat, lon: g.lon, altMsl: this.home.altMsl + this.homeAt.z };
  }

  /** Store fence items; they have already passed the loader's checks. */
  setFence(items: FenceWire[]) {
    if (wireProblem(items)) throw new Error("Fence items do not make whole zones");
    this.fence = items;
    this.fenceZones = localZones(wireToZones(items).zones, this.home);
    this.fenceBreached = 0;
  }

  toLocal(latE7: number, lonE7: number): { n: number; e: number } {
    const lat = latE7 / 1e7;
    const lon = lonE7 / 1e7;
    return { n: (lat - this.home.lat) * M_PER_DEG, e: (lon - this.home.lon) * M_PER_DEG * Math.cos((this.home.lat * Math.PI) / 180) };
  }

  toGlobal(n: number, e: number): { lat: number; lon: number } {
    return { lat: this.home.lat + n / M_PER_DEG, lon: this.home.lon + e / (M_PER_DEG * Math.cos((this.home.lat * Math.PI) / 180)) };
  }

  private p(name: string) {
    return this.params[name] ?? 0;
  }

  /* -------------------------------------------------------------- arming */

  /** Reasons the autopilot would refuse to arm; empty means it would. */
  prearm(inp: Inputs): string[] {
    const why: string[] = [];
    if (this.p("ARMING_CHECK") === 0) return why;
    const s = this.phys.s;
    if (s.crashed) why.push("Crashed: reset the aircraft");
    if (NEEDS_POSITION.has(this.mode) && !inp.gpsOk) why.push("Need position estimate");
    if (this.mode === MODE.AUTO && !(this.p("AUTO_OPTIONS") & 1)) why.push("Mode not armable");
    if (this.mode === MODE.RTL || this.mode === MODE.LAND || this.mode === MODE.BRAKE) why.push("Mode not armable");
    const armV = this.p("BATT_ARM_VOLT");
    if (armV > 0 && s.volts < armV) why.push(`Battery ${s.volts.toFixed(1)}V below minimum arming voltage`);
    const lowV = this.p("BATT_LOW_VOLT");
    if (lowV > 0 && s.volts < lowV) why.push("Battery below low voltage failsafe");
    const lowMah = this.p("BATT_LOW_MAH");
    if (lowMah > 0 && this.phys.af.capacityMah - s.usedMah < lowMah) why.push("Battery below low capacity failsafe");
    if (this.p("FS_THR_ENABLE") > 0 && !inp.rcOk && (this.mode === MODE.STABILIZE || this.mode === MODE.ALT_HOLD || this.mode === MODE.LOITER)) why.push("Radio failsafe on");
    why.push(...this.fencePrearm(inp));
    return why;
  }

  /** AC_Fence::pre_arm_check, in the order the firmware makes it, with its words. */
  private fencePrearm(inp: Inputs): string[] {
    const type = Math.round(this.p("FENCE_TYPE"));
    const live = this.p("FENCE_ENABLE") >= 1 || this.p("FENCE_AUTOENABLE") > 0;
    const present = (type & (FENCE_TYPE.ALT_MAX | FENCE_TYPE.CIRCLE | FENCE_TYPE.ALT_MIN)) | (type & FENCE_TYPE.POLYGON && this.fenceZones.length ? FENCE_TYPE.POLYGON : 0);
    if (this.p("FENCE_ENABLE") >= 1 && !present) return ["Fences enabled, but none selected"];
    if (!live || !type) return [];
    if (type & (FENCE_TYPE.CIRCLE | FENCE_TYPE.POLYGON) && !inp.gpsOk) return ["Fence requires position"];
    const xy = this.p("FENCE_MARGIN_XY") > 0 ? this.p("FENCE_MARGIN_XY") : this.p("FENCE_MARGIN");
    if (type & FENCE_TYPE.POLYGON && this.fenceZones.some((z) => z.role === "in" && z.shape === "circle" && z.r < xy)) return ["Polygon fence margin is greater than inclusion circle radius"];
    if (this.p("FENCE_RADIUS") < xy) return ["Circle FENCE_MARGIN is greater than FENCE_RADIUS"];
    if (this.p("FENCE_ALT_MAX") < 0) return ["Invalid FENCE_ALT_MAX value"];
    if (this.p("FENCE_ALT_MIN") < -100) return ["Invalid FENCE_ALT_MIN value"];
    const s = this.phys.s;
    if (this.p("FENCE_ENABLE") >= 1 && type & FENCE_TYPE.POLYGON && breachAt(this.fenceZones, { n: s.pos[0], e: s.pos[1] }, (this.p("FENCE_OPTIONS") & OPTION_UNION) !== 0)) return ["Vehicle breaching Polygon fence"];
    if (this.p("FENCE_ENABLE") >= 1 && type & FENCE_TYPE.CIRCLE && Math.hypot(s.pos[0] - this.homeAt.n, s.pos[1] - this.homeAt.e) >= this.p("FENCE_RADIUS")) return ["Vehicle breaching Circle fence"];
    if (this.p("FENCE_ALT_MAX") < this.p("FENCE_ALT_MIN")) return ["FENCE_ALT_MAX < FENCE_ALT_MIN"];
    if (this.p("FENCE_ALT_MAX") - this.p("FENCE_ALT_MIN") <= 2 * this.p("FENCE_MARGIN")) return ["FENCE_MARGIN too big"];
    return [];
  }

  arm(inp: Inputs, force = false): string[] {
    if (this.armed) return [];
    const why = force ? [] : this.prearm(inp);
    if (why.length) {
      for (const w of why) this.log("error", `PreArm: ${w}`, "prearm");
      return why;
    }
    this.armed = true;
    this.landed = true;
    const at = this.phys.s.pos;
    this.homeAt = { n: at[0], e: at[1], z: -at[2] };
    this.failsafes.clear();
    this.battLowSince = this.battCrtSince = this.rcLostSince = this.gpsLostSince = null;
    this.groundArmedSince = this.phys.s.t;
    for (const r of this.rate) r.reset();
    this.accI = 0;
    this.velI = [0, 0];
    this.auto = { started: false, legFrom: null, holdUntil: null, speed: null, done: false };
    this.place = null;
    this.deliveries = [];
    this.holdHere();
    this.log("info", "Arming motors", "arm");
    return [];
  }

  disarm(reason = "Disarming motors") {
    if (!this.armed) return;
    this.armed = false;
    this.out = [0, 0, 0, 0];
    this.throttleOut = 0;
    this.log("info", reason, "disarm");
  }

  private holdHere() {
    const s = this.phys.s;
    this.target = { n: s.pos[0], e: s.pos[1], alt: this.alt, yaw: euler(s.q).yaw };
    // Start from the speed it has, so a stop is a deceleration and not a lurch.
    this.velCmd = { n: s.vel[0], e: s.vel[1] };
    this.climbCmd = -s.vel[2];
    this.vzCmd = -s.vel[2];
    this.zDes = this.alt;
    this.navSpeed = Math.hypot(s.vel[0], s.vel[1]);
    this.navAcc = 0;
    this.auto.legFrom = null;
  }

  setMode(mode: number, inp: Inputs, why = ""): boolean {
    if (!(mode in MODE_NAME)) return false;
    if (NEEDS_POSITION.has(mode) && !inp.gpsOk) {
      this.log("warn", `Mode change to ${MODE_NAME[mode]} failed: requires position`);
      return false;
    }
    if (mode === MODE.AUTO && this.mission.length < 2) {
      this.log("warn", "Mode change to AUTO failed: no mission");
      return false;
    }
    if (mode === this.mode) return true;
    this.mode = mode;
    this.goal = null;
    this.holdHere();
    if (mode === MODE.RTL) this.rtl = { stage: "climb", since: this.phys.s.t };
    if (mode === MODE.GUIDED) this.guided = { kind: "hold", vx: 0, vy: 0, vz: 0, yawRate: 0, until: 0 };
    this.place = null;
    this.auto.rate = null;
    if (mode === MODE.AUTO) {
      this.auto.legFrom = null;
      this.auto.holdUntil = null;
      if (this.auto.done) {
        this.auto.done = false;
        this.missionSeq = 1;
      }
      if (this.missionSeq < 1) this.missionSeq = 1;
      // Already flying: carry on with the mission. On the ground it waits for a start.
      if (!this.landed) this.auto.started = true;
    }
    this.log("info", `Mode ${MODE_NAME[mode]}${why ? ` (${why})` : ""}`, "mode");
    return true;
  }

  /* ----------------------------------------------------- outside requests */

  guidedTakeoff(altM: number): boolean {
    if (!this.armed || this.mode !== MODE.GUIDED) return false;
    this.holdHere();
    this.target.alt = Math.max(this.alt, altM);
    this.guided = { kind: "takeoff", vx: 0, vy: 0, vz: 0, yawRate: 0, until: 0 };
    this.landed = false;
    this.log("info", `Take-off to ${altM.toFixed(1)} m`, "takeoff");
    return true;
  }

  /** Body-frame velocity request: forward, right, down (m/s) and yaw rate. */
  guidedVelocity(vx: number, vy: number, vz: number, yawRate: number) {
    if (this.mode !== MODE.GUIDED || this.guided.kind === "takeoff") return;
    this.guided = { kind: "vel", vx, vy, vz, yawRate, until: this.phys.s.t + 3 };
  }

  guidedGoto(n: number, e: number, alt: number) {
    if (this.mode !== MODE.GUIDED) return;
    this.target.n = n;
    this.target.e = e;
    this.target.alt = alt;
    this.guided = { kind: "pos", vx: 0, vy: 0, vz: 0, yawRate: 0, until: 0 };
    this.auto.legFrom = null;
  }

  startMission(): boolean {
    if (!this.armed || this.mode !== MODE.AUTO) return false;
    this.auto.started = true;
    return true;
  }

  /* ------------------------------------------------------------ the loop */

  step(dt: number, inp: Inputs) {
    const s = this.phys.s;
    if (!this.armed) {
      this.out = [0, 0, 0, 0];
      this.throttleOut = 0;
      this.ekfOk = inp.gpsOk;
      return;
    }
    this.checkFailsafes(inp);
    if (!this.armed) return;

    const e = euler(s.q);
    let rollT = 0;
    let pitchT = 0;
    let yawRateT: number | null = null;
    let thr = 0;
    let idle = false;
    const havePos = inp.gpsOk;
    const wpSpeed = this.p("WPNAV_SPEED") / 100;

    switch (this.mode) {
      case MODE.STABILIZE:
      case MODE.ALT_HOLD:
      case MODE.LOITER: {
        const st = inp.rcOk ? inp.sticks : null;
        const max = (this.p("ANGLE_MAX") / 100) * (Math.PI / 180);
        yawRateT = st ? st.yaw * 2.0 : 0;
        if (this.mode === MODE.LOITER && havePos) {
          const sp = this.p("LOIT_SPEED") / 100;
          const fwd = st ? -st.pitch * sp : 0;
          const right = st ? st.roll * sp : 0;
          this.slewVel(fwd * Math.cos(e.yaw) - right * Math.sin(e.yaw), fwd * Math.sin(e.yaw) + right * Math.cos(e.yaw), 5, dt);
          [rollT, pitchT] = this.posControl(dt, e.yaw);
        } else {
          rollT = st ? st.roll * max : 0;
          pitchT = st ? st.pitch * max : 0;
        }
        if (this.mode === MODE.STABILIZE) {
          thr = st ? st.throttle : 0;
          idle = thr < 0.05 && this.landed;
          if (thr > this.p("MOT_THST_HOVER") * 0.8) this.landed = false;
        } else {
          const up = this.p("PILOT_SPEED_UP") / 100;
          const climb = st ? (st.throttle - 0.5) * 2 * up : 0;
          if (climb > 0.3) this.landed = false;
          idle = this.landed;
          thr = this.altControl(dt, Math.abs(climb) > 0.1 ? climb : null, e);
        }
        break;
      }
      case MODE.GUIDED: {
        const g = this.guided;
        if (g.kind === "takeoff") {
          if (this.alt >= this.target.alt - 0.3) this.guided = { ...g, kind: "hold" };
        } else if (g.kind === "vel") {
          if (s.t > g.until) {
            this.guided = { ...g, kind: "hold", vx: 0, vy: 0, vz: 0, yawRate: 0 };
          } else {
            this.slewVel(g.vx * Math.cos(e.yaw) - g.vy * Math.sin(e.yaw), g.vx * Math.sin(e.yaw) + g.vy * Math.cos(e.yaw), this.p("WPNAV_ACCEL") / 100, dt);
            yawRateT = g.yawRate;
          }
        } else if (g.kind === "pos") {
          this.flyToward(this.target.n, this.target.e, wpSpeed, dt);
        }
        if (g.kind !== "vel") this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt, g.kind === "pos");
        idle = this.landed;
        [rollT, pitchT] = havePos ? this.posControl(dt, e.yaw) : [0, 0];
        thr = this.altControl(dt, g.kind === "vel" && Math.abs(g.vz) > 0.05 ? -g.vz : null, e);
        break;
      }
      case MODE.BRAKE: {
        this.slewVel(0, 0, 5, dt);
        [rollT, pitchT] = this.posControl(dt, e.yaw);
        thr = this.altControl(dt, null, e);
        break;
      }
      case MODE.AUTO: {
        idle = this.runMission(dt, inp, wpSpeed);
        if (!this.armed) return;
        [rollT, pitchT] = havePos ? this.posControl(dt, e.yaw) : [0, 0];
        thr = this.altControl(dt, this.auto.rate ?? null, e);
        break;
      }
      case MODE.RTL: {
        this.runRtl(dt, wpSpeed);
        [rollT, pitchT] = havePos ? this.posControl(dt, e.yaw) : [0, 0];
        thr = this.altControl(dt, this.rtl.stage === "land" ? this.landRate() : null, e);
        if (this.rtl.stage === "land") this.landDetect(dt);
        break;
      }
      case MODE.LAND: {
        if (havePos) {
          this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt);
          [rollT, pitchT] = this.posControl(dt, e.yaw);
        }
        thr = this.altControl(dt, this.landRate(), e);
        this.landDetect(dt);
        break;
      }
    }
    if (!this.armed) return;

    /*
      Touching down. On the ground the airframe cannot lean, so a position
      controller still trying to correct a few centimetres winds its rate
      integrators up against the earth, the mixer raises the throttle to make
      room for them, and the aircraft hops instead of settling. ArduCopter
      relaxes its attitude targets once it believes it has landed; so does this.
    */
    const settling = s.onGround && !this.landed && (this.mode === MODE.LAND || (this.mode === MODE.RTL && this.rtl.stage === "land"));
    if (settling) {
      for (const r of this.rate) r.reset();
      this.rateTarget = [0, 0, 0];
      this.velI = [0, 0];
      const t = clamp(Math.min(thr, this.throttleOut - 0.6 * dt), 0, 1);
      this.throttleOut = t;
      this.out = [t, t, t, t];
      return;
    }

    // Sitting armed on the ground: motors idle, and disarm after the delay.
    if (idle && s.onGround) {
      if (this.groundArmedSince === null) this.groundArmedSince = s.t;
      const delay = this.p("DISARM_DELAY");
      if (delay > 0 && s.t - this.groundArmedSince > delay) {
        this.disarm("Auto-disarmed: sat armed on the ground");
        return;
      }
      const spin = this.p("MOT_SPIN_ARM");
      this.out = [spin, spin, spin, spin];
      this.throttleOut = spin;
      for (const r of this.rate) r.reset();
      this.accI = 0;
      this.target.yaw = e.yaw;
      return;
    }
    this.groundArmedSince = null;

    // Yaw: hold a heading unless a rate is being asked for.
    if (yawRateT === null) {
      if (this.lastYawManual) this.target.yaw = e.yaw;
      this.lastYawManual = false;
    } else {
      this.lastYawManual = Math.abs(yawRateT) > 0.01;
      if (this.lastYawManual) this.target.yaw = e.yaw;
    }

    this.attitude(dt, rollT, pitchT, yawRateT !== null && this.lastYawManual ? yawRateT : null, thr, e);
  }

  /* --------------------------------------------------------- navigation */

  /** Move the velocity command toward a value at a limited acceleration. */
  private slewVel(vn: number, ve: number, accel: number, dt: number, keep = false) {
    if (keep) return;
    const dn = vn - this.velCmd.n;
    const de = ve - this.velCmd.e;
    const d = Math.hypot(dn, de);
    const step = accel * dt;
    if (d <= step) this.velCmd = { n: vn, e: ve };
    else this.velCmd = { n: this.velCmd.n + (dn / d) * step, e: this.velCmd.e + (de / d) * step };
    if (vn === 0 && ve === 0 && d <= step) return;
    // The point being held moves with the command, so releasing it stops there.
    this.target.n += this.velCmd.n * dt;
    this.target.e += this.velCmd.e * dt;
  }

  /**
   * Fly the held point toward a destination: accelerate to the cruise speed,
   * and slow so as to arrive stopped. Returns the distance still to go.
   *
   * The speed follows ArduCopter's jerk-limited ("S-curve") profile: the
   * acceleration itself ramps at WPNAV_JERK (WP_JERK on 4.7) up to
   * WPNAV_ACCEL, rather than appearing at once. At the default 1 m/s³ the
   * aircraft takes 2.5 s just to reach full acceleration and some 35 m to
   * reach 10 m/s, which on the short legs of a typical mission is most of
   * the leg. Without it the prediction ran a quarter faster than the
   * firmware flew the same mission (78 s against 104 s, ArduCopter 4.7.2).
   */
  private flyToward(n: number, e: number, speed: number, dt: number): number {
    if (!this.auto.legFrom) {
      const s = this.phys.s;
      this.auto.legFrom = { n: s.pos[0], e: s.pos[1] };
      this.nav = { n: s.pos[0], e: s.pos[1] };
    }
    const dn = n - this.nav.n;
    const de = e - this.nav.e;
    const dist = Math.hypot(dn, de);
    const acc = this.p("WPNAV_ACCEL") / 100;
    const jerk = Math.max(0.1, this.p("WPNAV_JERK"));
    // The fastest speed from which it can still stop in `dist` with this acceleration and jerk:
    // stopping distance ≈ v²/2a + v·a/2j.
    const k = acc / (2 * jerk);
    const reachable = acc * (Math.sqrt(k * k + (2 * Math.max(0, dist)) / acc) - k);
    const want = Math.min(speed, reachable);
    const accWant = clamp((want - this.navSpeed) * 2, -acc, acc);
    this.navAcc += clamp(accWant - this.navAcc, -jerk * dt, jerk * dt);
    // Braking may not wait on the jerk limit past the point of no return.
    if (this.navSpeed > reachable) this.navAcc = Math.min(this.navAcc, -Math.min(acc, (this.navSpeed - reachable) / Math.max(dt, 1e-3)));
    this.navSpeed = Math.max(0, Math.min(speed, this.navSpeed + this.navAcc * dt));
    if (this.navSpeed === 0 && this.navAcc < 0) this.navAcc = 0;
    const move = Math.min(dist, this.navSpeed * dt);
    if (dist > 1e-6) {
      this.nav.n += (dn / dist) * move;
      this.nav.e += (de / dist) * move;
      this.velCmd = { n: (dn / dist) * this.navSpeed, e: (de / dist) * this.navSpeed };
    } else {
      this.velCmd = { n: 0, e: 0 };
      this.navSpeed = 0;
      this.navAcc = 0;
    }
    this.target.n = this.nav.n;
    this.target.e = this.nav.e;
    // Point the nose along the track once properly under way.
    if (dist > 3 && this.navSpeed > 1) this.target.yaw = Math.atan2(de, dn);
    const s = this.phys.s;
    return Math.hypot(n - s.pos[0], e - s.pos[1]);
  }
  private nav = { n: 0, e: 0 };

  /**
   * The descent rate while landing, as ArduCopter's land_run_vertical_control
   * sets it: a square-root approach (PSC_POSZ_P, WPNAV_ACCEL_Z) toward
   * LAND_ALT_LOW, held between WPNAV_SPEED_DN and LAND_SPEED. So it slows
   * smoothly into LAND_ALT_LOW rather than switching speed there, and then
   * comes down at LAND_SPEED.
   */
  private landRate(): number {
    const low = Math.max(1, this.p("LAND_ALT_LOW") / 100);
    const p = Math.max(0.1, this.p("PSC_POSZ_P"));
    const a = Math.max(0.1, this.p("WPNAV_ACCEL_Z") / 100);
    const err = low - this.alt;
    const linear = a / (p * p);
    const rate = Math.abs(err) > linear ? Math.sign(err) * Math.sqrt(2 * a * (Math.abs(err) - linear / 2)) : p * err;
    const slow = Math.abs(this.p("LAND_SPEED") / 100);
    const fast = Math.max(this.p("WPNAV_SPEED_DN") / 100, slow);
    return clamp(rate, -fast, -slow);
  }

  private landDetect(dt: number) {
    const s = this.phys.s;
    void dt;
    if (s.onGround && this.throttleOut < Math.max(this.p("MOT_SPIN_MIN") + 0.02, this.p("MOT_THST_HOVER") * 0.75)) {
      if (this.landLowSince === null) this.landLowSince = s.t;
      if (s.t - this.landLowSince > 1) {
        this.landed = true;
        this.landLowSince = null;
        this.disarm("Landed: disarming motors");
      }
    } else if (!s.onGround) {
      this.landLowSince = null;
    }
  }

  private runRtl(dt: number, wpSpeed: number) {
    const s = this.phys.s;
    const r = this.rtl;
    let rtlAlt = Math.max(this.alt, this.p("RTL_ALT") / 100);
    // Copter keeps the return below the fence ceiling, less its margin (mode_rtl.cpp).
    if (this.fenceOn() && this.p("FENCE_TYPE") & FENCE_TYPE.ALT_MAX) rtlAlt = Math.min(rtlAlt, this.p("FENCE_ALT_MAX") - this.p("FENCE_MARGIN"));
    this.goal = r.stage === "climb" ? { n: s.pos[0], e: s.pos[1], alt: Math.max(this.target.alt, rtlAlt) } : r.stage === "return" ? { n: this.homeAt.n, e: this.homeAt.e, alt: this.target.alt } : null;
    const speed = this.p("RTL_SPEED") > 0 ? this.p("RTL_SPEED") / 100 : wpSpeed;
    if (r.stage === "climb") {
      if (this.target.alt < rtlAlt) this.target.alt = rtlAlt;
      this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt);
      // Copter's RTL starts from its stopping point: it brakes to a stop at WPNAV_ACCEL before it turns for home.
      if (this.alt >= this.target.alt - 0.5 && Math.hypot(s.vel[0], s.vel[1]) < 0.5) {
        this.rtl = { stage: "return", since: s.t };
        this.auto.legFrom = null;
      }
    } else if (r.stage === "return") {
      const left = this.flyToward(this.homeAt.n, this.homeAt.e, speed, dt);
      if (left < Math.max(1, this.p("WPNAV_RADIUS") / 100) && this.navSpeed < 0.3) this.rtl = { stage: "loiter", since: s.t };
    } else if (r.stage === "loiter") {
      this.velCmd = { n: 0, e: 0 };
      this.target.n = this.homeAt.n;
      this.target.e = this.homeAt.e;
      if (s.t - r.since > this.p("RTL_LOIT_TIME") / 1000) {
        this.rtl = { stage: "land", since: s.t };
        this.log("info", "RTL: landing at home", "rtl-land");
      }
    }
  }

  /** Runs the mission. Returns true while it is waiting on the ground. */
  private runMission(dt: number, inp: Inputs, wpSpeed: number): boolean {
    const s = this.phys.s;
    void inp;
    if (!this.auto.started) return this.landed;
    if (this.auto.done) {
      this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt);
      return false;
    }
    const item = this.mission[this.missionSeq];
    this.goal = null;
    if (!item) {
      this.auto.done = true;
      this.holdHere();
      this.log("info", "Mission complete: holding position", "mission-done");
      return false;
    }
    const relAlt = item.frame === 0 ? item.z - this.home.altMsl - this.homeAt.z : item.z;
    const next = () => {
      this.onReached?.(item.seq);
      this.missionSeq++;
      this.auto.legFrom = null;
      this.auto.holdUntil = null;
      this.auto.rate = null;
      this.auto.stopFor = 0;
      this.place = null;
    };
    const speed = this.auto.speed ?? wpSpeed;
    switch (item.command) {
      case CMD.TAKEOFF: {
        if (this.landed) {
          /*
            ArduCopter (takeoff.cpp) first spools the motors up (MOT_SPOOL_TIME),
            then ramps the throttle at TKOFF_SLEW_TIME per full scale until it
            sees the aircraft lift, at about hover throttle. Until then it is
            on the ground, as it is here.
          */
          if (this.auto.liftAt === undefined) {
            this.auto.liftAt = s.t + this.p("MOT_SPOOL_TIME") + this.p("MOT_THST_HOVER") * this.p("TKOFF_SLEW_TIME");
            this.log("info", `Mission: take-off to ${relAlt.toFixed(0)} m`, "takeoff");
          }
          // Still on the ground: motors at their armed idle, controllers at rest.
          if (s.t < this.auto.liftAt) return true;
          this.holdHere();
          this.landed = false;
        }
        this.auto.liftAt = undefined;
        this.goal = { n: s.pos[0], e: s.pos[1], alt: relAlt };
        if (this.target.alt < relAlt) this.target.alt = relAlt;
        // Complete, as the firmware counts it, at the height with the climb all but stopped (< 10% of WPNAV_SPEED_UP).
        if (this.alt >= relAlt - 0.3 && Math.abs(this.vzCmd) < 0.1 * (this.p("WPNAV_SPEED_UP") / 100)) next();
        return false;
      }
      case CMD.WAYPOINT:
      case CMD.LOITER_TIME:
      case CMD.LOITER_UNLIM: {
        if (this.landed) {
          this.log("warn", "Mission: a take-off command is needed before the first waypoint", "mission-error");
          this.auto.started = false;
          return true;
        }
        const here = item.x === 0 && item.y === 0;
        const dest = here ? { n: this.auto.legFrom?.n ?? s.pos[0], e: this.auto.legFrom?.e ?? s.pos[1] } : this.toLocal(item.x, item.y);
        if (relAlt > 0) this.target.alt = relAlt;
        if (this.auto.holdUntil === null) this.goal = { n: dest.n, e: dest.e, alt: this.target.alt };
        const left = this.flyToward(dest.n, dest.e, speed, dt);
        // A waypoint with a wait is a stop, and is reached only once the aircraft has come to it (AC_WPNav: the
        // track's target has finished, and the aircraft is within the radius). One without is passed through.
        const arrived = item.p1 > 0 || item.command === CMD.LOITER_TIME ? this.stoppedAt(left, this.target.alt, dt) : left < this.p("WPNAV_RADIUS") / 100 && Math.abs(this.alt - this.target.alt) < 1.5;
        if (arrived && item.command !== CMD.LOITER_UNLIM) {
          if (this.auto.holdUntil === null) this.auto.holdUntil = s.t + Math.max(0, item.p1);
          if (s.t >= this.auto.holdUntil) {
            // ArduCopter says so when the wait is over (ModeAuto::verify_nav_wp).
            this.log("info", `Reached command #${item.seq}`, "waypoint");
            next();
          }
        } else this.auto.stopFor = 0;
        return false;
      }
      case CMD.DELAY: {
        if (this.auto.holdUntil === null) this.auto.holdUntil = s.t + Math.max(0, item.p1);
        this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt);
        if (s.t >= this.auto.holdUntil) next();
        return this.landed;
      }
      case CMD.CHANGE_SPEED: {
        if (item.p2 > 0) this.auto.speed = item.p2;
        next();
        return false;
      }
      case CMD.GRIPPER:
      case CMD.SET_SERVO: {
        // A do command runs at once, as the navigation command before it completes (AP_Mission), and reports itself the way the firmware does.
        const grip = item.command === CMD.GRIPPER;
        const letGo = grip ? Math.round(item.p2) === 0 : true;
        if (grip) this.log("info", letGo ? "Gripper Released" : "Gripper Grabbed", letGo ? "gripper-release" : "gripper-grab");
        const kg = this.onDo?.(item) ?? 0;
        if (!this.landed && letGo) this.recordDelivery(item.seq, "drop", kg > 0 ? "released" : "nothing", kg);
        const wasLanded = this.landed;
        next();
        return wasLanded;
      }
      case CMD.PAYLOAD_PLACE:
        return this.runPlace(item, dt, speed, next);
      case CMD.RTL: {
        this.onReached?.(item.seq);
        this.auto.done = true;
        this.setMode(MODE.RTL, { ...inp }, "mission");
        return false;
      }
      case CMD.LAND: {
        const here = item.x === 0 && item.y === 0;
        if (!here) {
          const dest = this.toLocal(item.x, item.y);
          const left = this.flyToward(dest.n, dest.e, speed, dt);
          if (left > this.p("WPNAV_RADIUS") / 100) return false;
        }
        this.onReached?.(item.seq);
        this.auto.done = true;
        this.setMode(MODE.LAND, { ...inp }, "mission");
        return false;
      }
      default:
        // A command this model does not fly is skipped, and said so.
        this.log("warn", `Mission: command ${item.command} is not simulated, skipped`, "mission-skip");
        next();
        return false;
    }
  }

  /**
   * At a stop: ArduCopter counts a waypoint with a wait as reached when the
   * track's target has arrived and the aircraft is within WPNAV_RADIUS of it.
   * The target arrives with the aircraft close behind, so here: within half a
   * metre of the point and nearly still, or, in wind that will not let it
   * settle, within the radius for three seconds.
   */
  private stoppedAt(left: number, alt: number, dt: number): boolean {
    const s = this.phys.s;
    const off = Math.hypot(left, this.alt - alt);
    const radius = Math.max(0.5, this.p("WPNAV_RADIUS") / 100);
    if (off > radius) {
      this.auto.stopFor = 0;
      return false;
    }
    this.auto.stopFor = (this.auto.stopFor ?? 0) + dt;
    const still = Math.hypot(s.vel[0], s.vel[1], s.vel[2]) < 0.3;
    return (off < 0.5 && still) || this.auto.stopFor > 3;
  }

  private recordDelivery(seq: number, kind: DeliveryRecord["kind"], outcome: DeliveryRecord["outcome"], kg: number) {
    const s = this.phys.s;
    this.deliveries.push({ seq, kind, t: s.t, n: s.pos[0], e: s.pos[1], alt: this.alt, agl: this.height - this.phys.ground(s.pos[0], s.pos[1]), speed: Math.hypot(s.vel[0], s.vel[1]), kg, outcome });
  }

  /**
   * NAV_PAYLOAD_PLACE, as ArduCopter's PayloadPlace runs it (mode_auto.cpp):
   * fly to the place if it has one, at the height it is already at (4.6:
   * shift_alt_to_current_alt; 4.7 would take the command's height), then descend at PLDP_SPEED_DN (else the
   * landing speed, never faster than WPNAV_SPEED_DN); once the descent is
   * steady, take the least throttle over two seconds as the reference; when
   * the throttle stays under PLDP_THRESH of it for half a second, or the
   * aircraft itself lands, open the gripper (if there is one), wait
   * PLDP_DELAY, and climb back to where the descent began. Having descended
   * param 1 metres without that, it gives up and climbs back.
   */
  private runPlace(item: MissionItem, dt: number, speed: number, next: () => void): boolean {
    const s = this.phys.s;
    if (this.landed) {
      this.log("warn", "Mission: a take-off command is needed before the first waypoint", "mission-error");
      this.auto.started = false;
      return true;
    }
    const now = s.t;
    const prefix = "PayloadPlace:";
    if (!this.place) {
      const placed = item.x !== 0 || item.y !== 0;
      this.place = { state: placed ? "fly" : "start", steady: false, startAlt: this.alt, speed: 0, established: now, thrustMin: 1, placeStart: now, releasedAt: 0, released: false, landed: false };
    }
    const pl = this.place;
    const hold = () => this.slewVel(0, 0, this.p("WPNAV_ACCEL") / 100, dt);
    if (pl.state === "fly") {
      const dest = this.toLocal(item.x, item.y);
      this.goal = { n: dest.n, e: dest.e, alt: this.target.alt };
      const left = this.flyToward(dest.n, dest.e, speed, dt);
      // FlyToLocation ends when the waypoint is reached, the aircraft stopped there (reached_wp_destination).
      if (this.stoppedAt(left, this.target.alt, dt)) pl.state = "start";
      return false;
    }
    if (pl.state === "start") {
      pl.startAlt = this.target.alt;
      const land = Math.max(0.1, this.p("LAND_SPEED") / 100);
      const own = this.p("PLDP_SPEED_DN");
      pl.speed = Math.min(own > 0 ? own : land, Math.max(0.1, this.p("WPNAV_SPEED_DN") / 100));
      pl.established = now;
      pl.thrustMin = 1;
      pl.state = "descend";
    }
    if (pl.state === "descend") {
      hold();
      this.auto.rate = -pl.speed;
      const giveUp = item.p1;
      this.goal = { n: this.target.n, e: this.target.e, alt: giveUp > 0 ? pl.startAlt - giveUp : this.phys.ground(s.pos[0], s.pos[1]) - this.homeAt.z };
      if (giveUp > 0 && pl.startAlt - this.alt > giveUp) {
        this.log("warn", `${prefix} Reached maximum descent`, "place-gave-up");
        this.recordDelivery(item.seq, "lower", "gave-up", 0);
        pl.state = "ascent";
      } else if (s.onGround) {
        this.log("info", `${prefix} landed`, "place-landed");
        pl.landed = true;
        pl.state = "release";
      } else {
        const thresh = this.params.PLDP_THRESH ?? 0.9;
        let check = true;
        if (!pl.steady && Math.abs(-s.vel[2] + pl.speed) < 0.05 * pl.speed) pl.steady = true;
        if (this.climbCmd > -0.95 * pl.speed || !pl.steady) {
          pl.established = now;
          check = false;
        } else if (now - pl.established < 2) {
          pl.thrustMin = Math.min(pl.thrustMin, this.thrRaw);
          pl.placeStart = now;
          check = false;
        } else if (this.thrRaw > thresh * pl.thrustMin) {
          pl.placeStart = now;
          check = false;
        } else if (this.p("PLDP_RNG_MAX") > 0) {
          // The simulator has no rangefinder.
          this.log("warn", `${prefix} PLDP_RNG_MAX set and rangefinder not enabled`, "place-aborted");
          this.recordDelivery(item.seq, "lower", "aborted", 0);
          pl.state = "ascent";
          check = false;
        }
        if (check && now - pl.placeStart > 0.5) {
          this.log("info", `${prefix} payload release thrust threshold: ${(thresh * pl.thrustMin).toFixed(6)}`, "place-touchdown");
          pl.state = "release";
        }
      }
      return false;
    }
    if (pl.state === "release") {
      // Hold here, with no more descent, while the gripper opens.
      this.auto.rate = null;
      this.target.alt = this.alt;
      this.zDes = this.alt;
      this.vzCmd = 0;
      const kg = this.onPlaceRelease?.() ?? null;
      if (kg !== null) {
        this.log("info", `${prefix} Releasing the gripper`, "place-release");
        pl.released = true;
      }
      this.recordDelivery(item.seq, "lower", pl.landed ? "landed" : kg && kg > 0 ? "released" : "nothing", kg ?? 0);
      pl.releasedAt = now;
      pl.state = "delay";
    }
    if (pl.state === "delay") {
      hold();
      this.goal = null;
      // The gripper takes half a second to open (SERVO_ACTUATION_TIME), then PLDP_DELAY counts from the touchdown.
      if (now >= pl.releasedAt + (pl.released ? 0.5 : 0) && now - pl.placeStart >= 0.5 + this.p("PLDP_DELAY")) pl.state = "ascent";
      return false;
    }
    // Ascent: back to where the descent began.
    hold();
    this.auto.rate = null;
    this.target.alt = pl.startAlt;
    this.goal = { n: this.target.n, e: this.target.e, alt: pl.startAlt };
    if (this.alt >= pl.startAlt - 0.3) next();
    return false;
  }

  /* ---------------------------------------------------------- controllers */

  /** Position and velocity loops: returns target roll and pitch. */
  private posControl(dt: number, yaw: number): [number, number] {
    const s = this.phys.s;
    const maxLean = (this.p("ANGLE_MAX") / 100) * (Math.PI / 180);
    const kp = this.p("PSC_POSXY_P");
    let vn = this.velCmd.n + kp * (this.target.n - s.pos[0]);
    let ve = this.velCmd.e + kp * (this.target.e - s.pos[1]);
    // Catching up with the point being followed may add a little speed, not a lot:
    // the cruise speed is a limit the pilot set.
    const vmax = Math.max(3, Math.hypot(this.velCmd.n, this.velCmd.e) * 1.03 + 0.3);
    const vm = Math.hypot(vn, ve);
    if (vm > vmax) {
      vn *= vmax / vm;
      ve *= vmax / vm;
    }
    const err = [vn - s.vel[0], ve - s.vel[1]];
    const amax = G * Math.tan(maxLean);
    const out = [0, 0];
    // Feed the commanded acceleration forward, so it leans as the target
    // speeds up or slows rather than after it has fallen behind.
    const cmd = [this.velCmd.n, this.velCmd.e];
    const ff = [0, 0];
    for (let i = 0; i < 2; i++) {
      const a = clamp((cmd[i] - this.prevVelCmd[i]) / dt, -6, 6);
      this.prevVelCmd[i] = cmd[i];
      this.accFF[i] += (a - this.accFF[i]) * (dt / (dt + 0.15));
      ff[i] = this.accFF[i];
    }
    for (let i = 0; i < 2; i++) {
      const raw = (err[i] - this.prevVelErr[i]) / dt;
      this.prevVelErr[i] = err[i];
      this.velD[i] += (raw - this.velD[i]) * (dt / (dt + 1 / (2 * Math.PI * 5)));
      const unsat = this.p("PSC_VELXY_P") * err[i] + this.velI[i] + this.p("PSC_VELXY_D") * this.velD[i];
      if (Math.abs(unsat) < amax || Math.sign(err[i]) !== Math.sign(this.velI[i])) {
        this.velI[i] = clamp(this.velI[i] + this.p("PSC_VELXY_I") * err[i] * dt, -amax, amax);
      }
      out[i] = unsat + ff[i];
    }
    const am = Math.hypot(out[0], out[1]);
    if (am > amax) {
      out[0] *= amax / am;
      out[1] *= amax / am;
    }
    const fwd = out[0] * Math.cos(yaw) + out[1] * Math.sin(yaw);
    const right = -out[0] * Math.sin(yaw) + out[1] * Math.cos(yaw);
    const pitch = clamp(-Math.atan(fwd / G), -maxLean, maxLean);
    const roll = clamp(Math.atan((right * Math.cos(pitch)) / G), -maxLean, maxLean);
    return [roll, pitch];
  }

  /** Altitude, climb-rate and vertical-acceleration loops: returns throttle. */
  private altControl(dt: number, climbRate: number | null, e: { roll: number; pitch: number }): number {
    const s = this.phys.s;
    const up = this.p("WPNAV_SPEED_UP") / 100;
    const dn = this.p("WPNAV_SPEED_DN") / 100;
    let velT: number;
    if (climbRate !== null) {
      // A commanded rate: the held height follows the aircraft.
      this.climbCmd += clamp(climbRate - this.climbCmd, -2.5 * dt, 2.5 * dt);
      this.target.alt = this.alt + this.climbCmd * 0.2;
      velT = this.climbCmd;
      this.vzCmd = this.climbCmd;
      this.zDes = this.alt;
    } else {
      this.climbCmd += clamp(0 - this.climbCmd, -2.5 * dt, 2.5 * dt);
      /*
        A change of held height is flown as ArduCopter's position controller
        flies it: climb rate limited to WPNAV_SPEED_UP/DN and changing no
        faster than WPNAV_ACCEL_Z (WP_ACC_Z on 4.7, 1 m/s² by default), and
        slowing so as to arrive. A step in height used to become full climb
        rate at once, which made every take-off and height change quicker
        than the firmware's.
      */
      const accZ = Math.max(0.1, this.p("WPNAV_ACCEL_Z") / 100);
      const kP = this.p("PSC_POSZ_P");
      const err = this.target.alt - this.zDes;
      const arrive = Math.sign(err) * Math.sqrt(2 * accZ * Math.abs(err));
      const want = clamp(Math.abs(arrive) < Math.abs(kP * err) ? arrive : kP * err, -dn, up);
      this.vzCmd += clamp(want - this.vzCmd, -accZ * dt, accZ * dt);
      this.zDes += this.vzCmd * dt;
      // The planned climb rate, plus a correction for wherever the aircraft has been pushed off the plan.
      velT = this.vzCmd + clamp(kP * (this.zDes - this.alt), -2.5, 2.5);
    }
    const climb = -s.vel[2];
    const accT = clamp(this.p("PSC_VELZ_P") * (velT - climb), -7.5, 7.5);
    const accUp = -s.acc[2];
    const err = accT - accUp;
    const hover = this.p("MOT_THST_HOVER");
    const sat = this.throttleOut >= 0.99 || this.throttleOut <= this.p("MOT_SPIN_MIN") + 0.01;
    if (!sat || Math.sign(err) !== Math.sign(this.accI)) this.accI = clamp(this.accI + this.p("PSC_ACCZ_I") * 0.1 * err * dt, -0.4, 0.4);
    let thr = hover + this.p("PSC_ACCZ_P") * 0.1 * err + this.accI;
    this.thrRaw = thr;
    // Lean costs lift: add throttle to hold height in a bank.
    thr /= Math.max(0.5, Math.cos(e.roll) * Math.cos(e.pitch));
    return clamp(thr, 0, 1);
  }

  /** Angle and rate loops and the motor mixer. */
  private attitude(dt: number, rollT: number, pitchT: number, yawRate: number | null, thr: number, e: { roll: number; pitch: number; yaw: number }) {
    const s = this.phys.s;
    const want = [
      this.p("ATC_ANG_RLL_P") * (rollT - e.roll),
      this.p("ATC_ANG_PIT_P") * (pitchT - e.pitch),
      yawRate ?? clamp(this.p("ATC_ANG_YAW_P") * wrap(this.target.yaw - e.yaw), -1.6, 1.6),
    ];
    const lim = [this.p("ATC_ACCEL_R_MAX"), this.p("ATC_ACCEL_P_MAX"), this.p("ATC_ACCEL_Y_MAX")];
    const kp = [this.p("ATC_RAT_RLL_P"), this.p("ATC_RAT_PIT_P"), this.p("ATC_RAT_YAW_P")];
    const ki = [this.p("ATC_RAT_RLL_I"), this.p("ATC_RAT_PIT_I"), this.p("ATC_RAT_YAW_I")];
    const kd = [this.p("ATC_RAT_RLL_D"), this.p("ATC_RAT_PIT_D"), 0];
    const u = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const maxStep = lim[i] > 0 ? ((lim[i] / 100) * Math.PI) / 180 * dt : Infinity;
      this.rateTarget[i] += clamp(want[i] - this.rateTarget[i], -maxStep, maxStep);
      const raw = this.rate[i].run(this.rateTarget[i] - s.w[i], kp[i], ki[i], kd[i], dt, 0.5, this.saturated);
      u[i] = clamp(raw, -1, 1);
    }
    // Mix. Attitude has priority over collective when the motors run out.
    const spinMin = this.p("MOT_SPIN_MIN");
    const mix = MOTORS.map((m) => 0.5 * (-m.sy * u[0] + m.sx * u[1]) + 0.5 * m.c * u[2]);
    let hi = Math.max(...mix);
    let lo = Math.min(...mix);
    const room = 1 - spinMin;
    this.saturated = false;
    if (hi - lo > room) {
      const k = room / (hi - lo);
      for (let i = 0; i < 4; i++) mix[i] *= k;
      hi *= k;
      lo *= k;
      this.saturated = true;
    }
    let t = Math.max(thr, spinMin);
    if (t + hi > 1) {
      t = 1 - hi;
      this.saturated = true;
    }
    if (t + lo < spinMin) t = spinMin - lo;
    this.throttleOut = t;
    this.out = [clamp(t + mix[0], 0, 1), clamp(t + mix[1], 0, 1), clamp(t + mix[2], 0, 1), clamp(t + mix[3], 0, 1)];
  }
  private saturated = false;

  /* ------------------------------------------------------------ failsafes */

  private failsafeAction(name: string, text: string, action: "rtl" | "land" | "none" | "disarm", inp: Inputs) {
    if (this.failsafes.has(name)) return;
    this.failsafes.add(name);
    this.log("error", text, `fs-${name}`);
    if (action === "none") return;
    if (this.landed && this.phys.s.onGround) {
      this.disarm(`${text}: disarmed on the ground`);
      return;
    }
    if (action === "disarm") {
      this.disarm(`${text}: motors stopped`);
      return;
    }
    // Already on its way down or home: leave it be.
    if (this.mode === MODE.LAND || (this.mode === MODE.RTL && action === "rtl")) return;
    if (action === "rtl" && inp.gpsOk && this.setMode(MODE.RTL, inp, "failsafe")) return;
    this.setMode(MODE.LAND, inp, "failsafe");
  }

  private fenceOn() {
    return this.p("FENCE_ENABLE") >= 1 || (this.p("FENCE_AUTOENABLE") === 3 && this.armed);
  }

  /**
   * The fence, as Copter's fence_check and AC_Fence::check run it: each kind
   * is tested, a fresh breach triggers FENCE_ACTION once, and a breach clears
   * when the aircraft is back inside, so a second breach acts again. The
   * floor switches itself on once the aircraft is above it by the margin and
   * is ignored while landing. More than 100 m outside, it gives up and lands.
   */
  private checkFence(inp: Inputs) {
    const s = this.phys.s;
    if (!this.fenceOn() || !inp.gpsOk || !this.armed) {
      this.fenceBreached = 0;
      if (!this.armed) this.floorOn = false;
      return;
    }
    const type = Math.round(this.p("FENCE_TYPE"));
    const margin = this.p("FENCE_MARGIN");
    const here = { n: s.pos[0], e: s.pos[1] };
    const landing = this.landed || this.mode === MODE.LAND || (this.mode === MODE.RTL && this.rtl.stage === "land");
    let now = 0;
    let outBy = 0;
    if (type & FENCE_TYPE.ALT_MAX && this.alt >= this.p("FENCE_ALT_MAX")) {
      now |= FENCE_TYPE.ALT_MAX;
      outBy = Math.max(outBy, this.alt - this.p("FENCE_ALT_MAX"));
    }
    if (type & FENCE_TYPE.ALT_MIN) {
      if (landing) this.floorOn = false;
      else if (!this.floorOn && this.alt >= this.p("FENCE_ALT_MIN") + margin) {
        this.floorOn = true;
        this.log("info", "Min Alt fence enabled (auto enable)", "fence-floor");
      }
      if (this.floorOn && this.alt <= this.p("FENCE_ALT_MIN")) {
        now |= FENCE_TYPE.ALT_MIN;
        outBy = Math.max(outBy, this.p("FENCE_ALT_MIN") - this.alt);
      }
    }
    const fromHome = Math.hypot(here.n - this.homeAt.n, here.e - this.homeAt.e);
    if (type & FENCE_TYPE.CIRCLE && fromHome >= this.p("FENCE_RADIUS")) {
      now |= FENCE_TYPE.CIRCLE;
      outBy = Math.max(outBy, fromHome - this.p("FENCE_RADIUS"));
    }
    if (type & FENCE_TYPE.POLYGON && this.fenceZones.length) {
      const z = breachAt(this.fenceZones, here, (this.p("FENCE_OPTIONS") & OPTION_UNION) !== 0);
      if (z) {
        now |= FENCE_TYPE.POLYGON;
        outBy = Math.max(outBy, toBoundary(z, here));
      }
    }
    const fresh = now & ~this.fenceBreached;
    if (this.fenceBreached && !now) {
      this.failsafes.delete("fence");
      this.log("info", "Fence breach cleared", "fence-clear");
    }
    this.fenceBreached = now;
    if (!fresh) return;
    const names = [[FENCE_TYPE.ALT_MAX, "Max Alt"], [FENCE_TYPE.CIRCLE, "Circle"], [FENCE_TYPE.POLYGON, "Polygon"], [FENCE_TYPE.ALT_MIN, "Min Alt"]]
      .filter(([bit]) => fresh & (bit as number))
      .map(([, n]) => n);
    const text = `${names.join(" and ")} fence${names.length > 1 ? "s" : ""} breached`;
    const a = Math.round(this.p("FENCE_ACTION"));
    // A new breach acts even if an older one has not cleared.
    this.failsafes.delete("fence");
    if (a === 0) {
      this.failsafeAction("fence", text, "none", inp);
      return;
    }
    if (outBy > GIVE_UP_M) {
      this.failsafeAction("fence", `${text}: more than ${GIVE_UP_M} m outside, landing`, "land", inp);
      return;
    }
    if (a === 4) {
      this.failsafes.add("fence");
      this.log("error", text, "fs-fence");
      if (this.landed && s.onGround) this.disarm(`${text}: disarmed on the ground`);
      else if (!this.setMode(MODE.BRAKE, inp, "failsafe")) this.setMode(MODE.LAND, inp, "failsafe");
      return;
    }
    // SmartRTL (3, 5) is not modelled: it is flown as RTL, its usual fallback.
    this.failsafeAction("fence", text, a === 2 ? "land" : "rtl", inp);
  }

  private checkFailsafes(inp: Inputs) {
    const s = this.phys.s;
    const act = (v: number): "rtl" | "land" | "none" | "disarm" => (v === 1 ? "land" : v === 2 || v === 3 || v === 4 || v === 6 ? "rtl" : v === 5 ? "disarm" : v === 7 ? "land" : "none");

    // Battery: voltage has to stay low for BATT_LOW_TIMER; capacity acts at once.
    const remaining = this.phys.af.capacityMah - s.usedMah;
    const timer = this.p("BATT_LOW_TIMER");
    const lowV = this.p("BATT_LOW_VOLT");
    const crtV = this.p("BATT_CRT_VOLT");
    this.battLowSince = lowV > 0 && s.volts < lowV ? (this.battLowSince ?? s.t) : null;
    this.battCrtSince = crtV > 0 && s.volts < crtV ? (this.battCrtSince ?? s.t) : null;
    const crt = (this.battCrtSince !== null && s.t - this.battCrtSince >= timer) || (this.p("BATT_CRT_MAH") > 0 && remaining < this.p("BATT_CRT_MAH"));
    const low = (this.battLowSince !== null && s.t - this.battLowSince >= timer) || (this.p("BATT_LOW_MAH") > 0 && remaining < this.p("BATT_LOW_MAH"));
    if (crt) this.failsafeAction("batt-critical", "Battery critical failsafe", act(this.p("BATT_FS_CRT_ACT")), inp);
    else if (low) this.failsafeAction("batt-low", "Battery low failsafe", act(this.p("BATT_FS_LOW_ACT")), inp);

    // Radio.
    const thr = this.p("FS_THR_ENABLE");
    const opts = this.p("FS_OPTIONS");
    if (!inp.rcOk) {
      this.rcLostSince ??= s.t;
      if (thr > 0 && s.t - this.rcLostSince >= this.p("RC_FS_TIMEOUT")) {
        const carryOn = (this.mode === MODE.AUTO && opts & 1) || (this.mode === MODE.GUIDED && opts & 4);
        if (carryOn) {
          if (!this.failsafes.has("radio")) {
            this.failsafes.add("radio");
            this.log("warn", "Radio failsafe: continuing as FS_OPTIONS allows", "fs-radio");
          }
        } else this.failsafeAction("radio", "Radio failsafe", thr === 3 || thr === 5 || thr === 7 ? "land" : "rtl", inp);
      }
    } else {
      this.rcLostSince = null;
      this.failsafes.delete("radio");
    }

    // Ground station.
    const gcs = this.p("FS_GCS_ENABLE");
    if (gcs > 0 && inp.gcsSeen && inp.gcsSilentS > this.p("FS_GCS_TIMEOUT")) {
      const carryOn = (this.mode === MODE.AUTO && (opts & 2 || gcs === 2)) || ((this.mode === MODE.STABILIZE || this.mode === MODE.ALT_HOLD || this.mode === MODE.LOITER) && opts & 16 && inp.rcOk);
      if (carryOn) {
        if (!this.failsafes.has("gcs")) {
          this.failsafes.add("gcs");
          this.log("warn", "Ground station failsafe: continuing as FS_OPTIONS allows", "fs-gcs");
        }
      } else this.failsafeAction("gcs", "Ground station failsafe", gcs === 5 || gcs === 4 || gcs === 7 ? "land" : "rtl", inp);
    } else if (inp.gcsSilentS < 1) {
      this.failsafes.delete("gcs");
    }

    // Position lost.
    this.ekfOk = inp.gpsOk;
    if (!inp.gpsOk) {
      this.gpsLostSince ??= s.t;
      if (NEEDS_POSITION.has(this.mode) && s.t - this.gpsLostSince > 1) {
        const a = this.p("FS_EKF_ACTION");
        if (!this.failsafes.has("ekf")) {
          this.failsafes.add("ekf");
          this.log("error", "EKF failsafe: position lost", "fs-ekf");
          if (this.landed && s.onGround) this.disarm("Position lost: disarmed on the ground");
          else {
            this.mode = a === 2 ? MODE.ALT_HOLD : MODE.LAND;
            this.goal = null;
            this.holdHere();
            this.log("info", `Mode ${MODE_NAME[this.mode]} (failsafe)`, "mode");
          }
        }
      }
    } else {
      this.gpsLostSince = null;
    }

    this.checkFence(inp);

    // Crash: far from the attitude it wants and not recovering.
    if (this.p("FS_CRASH_CHECK")) {
      const e = euler(s.q);
      const tilt = Math.acos(clamp(Math.cos(e.roll) * Math.cos(e.pitch), -1, 1));
      const lim = (this.p("ANGLE_MAX") / 100) * (Math.PI / 180) + 0.52;
      if (s.crashed) {
        const how =
          s.crashWhy === "sliding"
            ? `touched down moving sideways at ${s.lastSlide.toFixed(1)} m/s and went over`
            : s.crashWhy === "water"
              ? "came down in the water"
              : s.crashWhy === "tipped"
                ? "came down on its side"
              : `hit the ground at ${s.lastImpact.toFixed(1)} m/s`;
        this.log("error", `Crash: ${how}`, "crash");
        this.disarm("Crash: disarming");
      } else if (tilt > lim && !this.landed) {
        // In the air and far past the lean limit: it has lost control. The
        // motors stay on — the real firmware does not disarm in mid-air.
        this.crashSince ??= s.t;
        if (s.t - this.crashSince > 1 && !this.failsafes.has("control")) {
          this.failsafes.add("control");
          this.log("error", "Lost control of attitude", "loss-of-control");
        }
      } else this.crashSince = null;
    }
  }
}
