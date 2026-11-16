/*
  A made-up but realistic ArduCopter flight as a DataFlash log, with knobs
  for the faults the checks look for. 10 Hz, 120 s: armed at 1 s, airborne
  at 3 s, climbs to 20 m, flies out 60 m and back, lands at 100 s, disarms
  at 104 s.
*/
import { copterLog, T } from "./dfwriter";

export interface Synth {
  /** Vibration on Z, m/s². */
  vibe?: number;
  /** Clips added during flight, on IMU 0. */
  clips?: number;
  /** From this time motor 1 stops: its output goes to full and the aircraft rolls over. */
  motorFailAt?: number;
  /** GPS has no fix in this window. */
  gpsLost?: [number, number];
  /** Satellites in view. */
  sats?: number;
  hdop?: number;
  /** Battery: resting voltage, sag per amp, capacity used per second. */
  cells?: number;
  sagPerAmp?: number;
  /** Compass field added per unit of throttle above idle, mGauss. */
  magPerThrottle?: number;
  /** The log stops at this time (power lost). */
  endAt?: number;
  /** Board voltage. */
  vcc?: number;
  vccDip?: number;
  /** ERR rows to add: [t, subsys, code]. */
  errors?: [number, number, number][];
  /** MODE rows: [t, modeNum, reason]. */
  modes?: [number, number, number][];
  /** Extra parameters. */
  params?: Record<string, number>;
  /** Attitude error added in flight, degrees (bad tuning). */
  wobble?: number;
  /** Motor 3 average offset, µs (imbalance). */
  motorBias?: number;
}

const HOME = { lat: 23.0225, lng: 72.5714, alt: 53 };

export function synthLog(o: Synth = {}): ArrayBuffer {
  const w = copterLog();
  // Units and multipliers, as ArduPilot logs them.
  for (const [id, label] of [["s", "s"], ["#", "instance"], ["-", ""], ["G", "Gauss"], ["%", "%"], ["m", "m"], ["d", "deg"], ["v", "V"], ["A", "A"]] as const) w.write(T.UNIT, [0, id.charCodeAt(0), label]);
  for (const [id, m] of [["-", 0], ["F", 1e-6], ["C", 1e-3], ["A", 0.1]] as const) w.write(T.MULT, [0, id.charCodeAt(0), m]);
  const fmtu = (type: number, units: string, mults: string) => w.write(T.FMTU, [0, type, units, mults]);
  fmtu(T.VIBE, "s#----", "F-----");
  fmtu(T.MAG, "s#GGG", "F-CCC");
  fmtu(T.PM, "s----%", "F----A");
  fmtu(T.GPS, "s#------------", "F-------------");
  fmtu(T.BAT, "s#vvA--", "F------");
  fmtu(T.XKF4, "s#------", "F-------");
  fmtu(T.ATT, "sdddddd-", "F-------");

  const params: Record<string, number> = {
    FRAME_CLASS: 1, MOT_PWM_MIN: 1000, MOT_PWM_MAX: 2000, BATT_MONITOR: 4, BATT_CAPACITY: 5000, BATT_LOW_VOLT: 14, BATT_FS_LOW_ACT: 2,
    FS_THR_ENABLE: 1, ARMING_SKIPCHK: 0, FS_EKF_THRESH: 0.8, INS_HNTCH_ENABLE: 1, COMPASS_USE: 1, MOT_BAT_VOLT_MAX: 16.8, LOG_DISARMED: 0,
    SERVO1_FUNCTION: 33, SERVO2_FUNCTION: 34, SERVO3_FUNCTION: 35, SERVO4_FUNCTION: 36,
    ...o.params,
  };
  for (const [k, v] of Object.entries(params)) w.write(T.PARM, [1e6, k, v, v]);
  w.write(T.VER, [1e6, 4, 7, 2, 255, "ArduCopter V4.7.2 (test)"]);
  w.write(T.MSG, [1e6, "ArduCopter V4.7.2 (test)"]);
  w.write(T.ORGN, [1e6, 1, HOME.lat, HOME.lng, HOME.alt]);

  const end = o.endAt ?? 120;
  const modes = o.modes ?? [[0.5, 5, 1], [96, 9, 1]];
  const errors = [...(o.errors ?? [])];
  const cells = o.cells ?? 4;
  let used = 0;
  let clips = 0;
  let mi = 0;
  let ei = 0;
  const events: [number, number][] = [[1, 10], [3, 28], [100, 18], [104, 11]];
  let evi = 0;
  for (let k = 0; k <= end * 10; k++) {
    const t = k / 10;
    const us = 1e6 + t * 1e6;
    while (mi < modes.length && modes[mi][0] <= t) {
      w.write(T.MODE, [us, modes[mi][1], modes[mi][1], modes[mi][2]]);
      mi++;
    }
    while (evi < events.length && events[evi][0] <= t) {
      w.write(T.EV, [us, events[evi][1]]);
      evi++;
    }
    while (ei < errors.length && errors[ei][0] <= t) {
      w.write(T.ERR, [us, errors[ei][1], errors[ei][2]]);
      ei++;
    }
    const armed = t >= 1 && t < 104;
    const flying = t >= 3 && t < 100;
    const failed = o.motorFailAt !== undefined && t >= o.motorFailAt;
    // Height: climb at 2 m/s to 20 m, descend from 90 s.
    let alt = flying ? Math.min(20, (t - 3) * 2) : 0;
    if (t > 90 && flying) alt = Math.max(0, 20 - (t - 90) * 2);
    if (failed) alt = Math.max(0, alt - (t - o.motorFailAt!) * 6);
    // Out 60 m north and back.
    const n = flying ? 60 * Math.sin((Math.PI * Math.min(87, Math.max(0, t - 13))) / 87) : 0;
    const desRoll = flying ? 5 * Math.sin(t / 4) : 0;
    let roll = desRoll + (o.wobble && flying ? o.wobble * Math.sin(t * 7) : 0);
    if (failed) roll = Math.min(170, (t - o.motorFailAt!) * 90);
    const desPitch = flying ? -8 * Math.cos((Math.PI * Math.min(87, Math.max(0, t - 13))) / 87) : 0;
    const pitch = failed ? 20 : desPitch;
    w.write(T.ATT, [us, desRoll, roll, desPitch, pitch, 10, 10, 3]);
    const thr = !armed ? 0 : flying ? (failed ? 1 : 0.45) : 0.1;
    w.write(T.CTUN, [us, 0, 0, thr, 0.42, alt, alt, alt, 0, 0, 0, 0]);
    const lat = HOME.lat + n / 111320;
    w.write(T.POS, [us, lat, HOME.lng, HOME.alt + alt, alt, alt]);
    // Motors: hover ~1450, failed motor 1 pinned at full.
    const base = !armed ? 1000 : flying ? 1450 : 1100;
    const m = [base, base, base + (o.motorBias ?? 0), base].map((x, i) => (failed && i === 0 ? 2000 : failed ? 1700 : x));
    w.write(T.RCOU, [us, ...m, 0, 0, 0, 0]);
    // Battery.
    const amps = !armed ? 0.5 : flying ? 25 : 3;
    used += (amps * 1000) / 3600 / 10;
    const volt = cells * 4.15 - (used / 5000) * cells * 0.6 - amps * (o.sagPerAmp ?? 0.004) * cells;
    w.write(T.BAT, [us, 0, volt, volt + amps * 0.01, amps, used, 0]);
    // Every other row: 5 Hz sensors.
    if (k % 2 === 0) {
      const gpsOk = !(o.gpsLost && t >= o.gpsLost[0] && t < o.gpsLost[1]);
      const sats = gpsOk ? (o.sats ?? 16) : 3;
      w.write(T.GPS, [us, 0, gpsOk ? 3 : 1, 0, 0, sats, gpsOk ? (o.hdop ?? 0.8) : 9.99, lat, HOME.lng, HOME.alt + alt, flying ? 3 : 0, 0, 0, 0]);
      const vz = flying ? (o.vibe ?? 3) : 0.3;
      if (flying && o.clips && clips < o.clips) clips += Math.ceil(o.clips / 400);
      for (const imu of [0, 1]) w.write(T.VIBE, [us, imu, vz * 0.6, vz * 0.7, vz, imu === 0 ? Math.min(clips, o.clips ?? 0) : 0]);
      const sv = gpsOk ? 0.1 : 1.6;
      w.write(T.XKF4, [us, 0, sv, gpsOk ? 0.1 : 2, 0.1, 0.05, 0, 0]);
      w.write(T.XKF4, [us, 1, sv, gpsOk ? 0.1 : 2, 0.1, 0.05, 0, 0]);
      const extra = (o.magPerThrottle ?? 0) * Math.max(0, thr - 0.1);
      w.write(T.MAG, [us, 0, 200 + extra, 100, 380]);
      const dip = o.vccDip && flying && t > 50 && t < 52 ? o.vccDip : 0;
      w.write(T.POWR, [us, (o.vcc ?? 5.1) - dip, 0, 3, 0]);
    }
    if (k % 10 === 0) w.write(T.PM, [us, 0, 400, 2000, 50000, 300]);
  }
  return w.buffer();
}
