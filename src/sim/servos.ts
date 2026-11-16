/*
  The virtual aircraft's servo outputs, behaving as ArduCopter's do:

  - each of SERVO1-14 does what its SERVOn_FUNCTION says (laid out like a
    Pixhawk 2.4.8: MAIN OUT 1-8, AUX OUT 1-6);
  - motors 1-4 follow the simulated motors;
  - RC pass-through follows the transmitter channel exactly (51-66, and 1 for
    the channel of the same number), or scaled to the output's own
    MIN/TRIM/MAX (140-155);
  - DO_SET_SERVO moves only an output that nothing else drives (Disabled, a
    sprayer, the gripper, an RC pass-through), and refuses any other with
    ArduPilot's own "Channel n is already in use"
    (AP_ServoRelayEvents::do_set_servo); on a pass-through it holds until the
    stick moves;
  - the gripper exists only if GRIP_ENABLE = 1 and GRIP_TYPE = 1 when the
    aircraft started (AP_Gripper::init runs once at boot), sits at
    GRIP_NEUTRAL, and DO_GRIPPER moves it to GRIP_GRAB or GRIP_RELEASE;
  - an output set to Disabled sends no pulses (reported as 0).
*/
export interface ServoParamDef {
  name: string;
  def: number;
  help: string;
}

export const SIM_OUTPUTS = 14;

const DEFAULT_FN = [33, 34, 35, 36];

export const SERVO_PARAM_DEFS: ServoParamDef[] = [
  ...Array.from({ length: SIM_OUTPUTS }, (_, i) => {
    const n = i + 1;
    return [
      { name: `SERVO${n}_FUNCTION`, def: DEFAULT_FN[i] ?? 0, help: `What output ${n} does` },
      { name: `SERVO${n}_MIN`, def: 1100, help: `Output ${n} lowest pulse, µs` },
      { name: `SERVO${n}_MAX`, def: 1900, help: `Output ${n} highest pulse, µs` },
      { name: `SERVO${n}_TRIM`, def: 1500, help: `Output ${n} centre pulse, µs` },
      { name: `SERVO${n}_REVERSED`, def: 0, help: `Output ${n} reversed` },
    ];
  }).flat(),
  { name: "RC_SPEED", def: 490, help: "Motor output rate, Hz" },
  { name: "MOT_PWM_TYPE", def: 0, help: "Motor output protocol (0 = PWM)" },
  { name: "RCMAP_ROLL", def: 1, help: "Roll stick channel" },
  { name: "RCMAP_PITCH", def: 2, help: "Pitch stick channel" },
  { name: "RCMAP_THROTTLE", def: 3, help: "Throttle stick channel" },
  { name: "RCMAP_YAW", def: 4, help: "Yaw stick channel" },
  { name: "FLTMODE_CH", def: 5, help: "Flight mode switch channel" },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `RC${i + 5}_OPTION`, def: 0, help: `What a switch on channel ${i + 5} does` })),
  { name: "GRIP_ENABLE", def: 0, help: "Gripper on" },
  { name: "GRIP_TYPE", def: 0, help: "Gripper type (1 = servo)" },
  { name: "GRIP_GRAB", def: 1900, help: "Gripper closed pulse, µs" },
  { name: "GRIP_RELEASE", def: 1100, help: "Gripper open pulse, µs" },
  { name: "GRIP_NEUTRAL", def: 1500, help: "Gripper resting pulse, µs" },
  { name: "GRIP_AUTOCLOSE", def: 0, help: "Close again this long after a release, s (0 = never)" },
  { name: "BRD_SAFETY_DEFLT", def: 0, help: "Safety switch at start-up (the virtual aircraft has none)" },
  { name: "BRD_SAFETY_MASK", def: 0, help: "Outputs that move with the safety switch on" },
  // RELAY2-6_PIN appear only once their relay is given a function (RELAYn_FUNCTION is their enable flag); relay 1 is listed.
  { name: "RELAY1_PIN", def: -1, help: "Relay 1 pin (-1 = none)" },
];

/**
  Listed only while their enable flag is on, as ArduPilot does
  (AP_PARAM_FLAG_ENABLE): the gripper's settings appear once GRIP_ENABLE is 1.
*/
export function hiddenByEnable(name: string, p: Record<string, number>): boolean {
  return name.startsWith("GRIP_") && name !== "GRIP_ENABLE" && p.GRIP_ENABLE !== 1;
}

export const SERVO_RANGES: Record<string, [number, number]> = {
  ...Object.fromEntries(
    Array.from({ length: SIM_OUTPUTS }, (_, i) => [
      [`SERVO${i + 1}_FUNCTION`, [-1, 180]],
      [`SERVO${i + 1}_MIN`, [500, 2200]],
      [`SERVO${i + 1}_MAX`, [800, 2500]],
      [`SERVO${i + 1}_TRIM`, [800, 2200]],
      [`SERVO${i + 1}_REVERSED`, [0, 1]],
    ]).flat(),
  ),
  RC_SPEED: [50, 490],
  MOT_PWM_TYPE: [0, 9],
  RELAY1_PIN: [-1, 127],
  GRIP_GRAB: [1000, 2000],
  GRIP_RELEASE: [1000, 2000],
  GRIP_NEUTRAL: [1000, 2000],
  GRIP_AUTOCLOSE: [0, 255],
};

/** ArduCopter's storage types for these (MAV_PARAM_TYPE: 2 INT8, 4 INT16, 6 INT32). */
export const SERVO_TYPES: Record<string, number> = {
  ...Object.fromEntries(
    Array.from({ length: SIM_OUTPUTS }, (_, i) => [
      [`SERVO${i + 1}_FUNCTION`, 4],
      [`SERVO${i + 1}_MIN`, 4],
      [`SERVO${i + 1}_MAX`, 4],
      [`SERVO${i + 1}_TRIM`, 4],
      [`SERVO${i + 1}_REVERSED`, 2],
    ]).flat(),
  ),
  RC_SPEED: 4,
  MOT_PWM_TYPE: 2,
  RCMAP_ROLL: 2,
  RCMAP_PITCH: 2,
  RCMAP_THROTTLE: 2,
  RCMAP_YAW: 2,
  FLTMODE_CH: 2,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`RC${i + 5}_OPTION`, 4])),
  GRIP_ENABLE: 2,
  GRIP_TYPE: 2,
  GRIP_GRAB: 4,
  GRIP_RELEASE: 4,
  GRIP_NEUTRAL: 4,
  BRD_SAFETY_DEFLT: 2,
  BRD_SAFETY_MASK: 6,
  RELAY1_PIN: 2,
};

/** Functions DO_SET_SERVO may move (AP_ServoRelayEvents::do_set_servo). */
export function setServoAllowed(fn: number): boolean {
  return fn === 0 || fn === 22 || fn === 23 || fn === 28 || (fn >= 51 && fn <= 66) || (fn >= 140 && fn <= 155);
}

type P = Record<string, number>;

export class SimServos {
  /** Pulse widths set by DO_SET_SERVO, and the RC input they were set against (for pass-through). */
  private held = new Map<number, { pwm: number; rcAt: number | null }>();
  private gripperOn = false;
  private gripper: { pwm: number; closeAt: number | null } | null = null;

  /** At start-up, as AP_Gripper::init: the gripper exists only if enabled as a servo now. */
  boot(p: P) {
    this.gripperOn = p.GRIP_ENABLE === 1 && p.GRIP_TYPE === 1;
    this.gripper = this.gripperOn ? { pwm: p.GRIP_NEUTRAL, closeAt: null } : null;
    this.held.clear();
  }

  /** DO_SET_SERVO. Null when done, or ArduPilot's reason when refused. */
  setServo(p: P, output: number, pwm: number, rc: number[]): string | null {
    if (output < 1 || output > SIM_OUTPUTS) return "no such output";
    const fn = p[`SERVO${output}_FUNCTION`] ?? 0;
    if (!setServoAllowed(fn)) return `ServoRelayEvent: Channel ${output} is already in use`;
    let v = pwm;
    // Scaled pass-through takes the command as an input position (1000-2000), as ArduPilot maps it.
    if (fn >= 140 && fn <= 155) v = this.scaled(p, output, Math.min(2000, Math.max(1000, pwm)));
    const ch = fn >= 51 && fn <= 66 ? fn - 50 : fn >= 140 ? fn - 139 : null;
    this.held.set(output, { pwm: Math.round(v), rcAt: ch ? (rc[ch - 1] ?? 0) : null });
    return null;
  }

  /**
    DO_GRIPPER, as GCS_MAVLINK::handle_command_do_gripper: refused only when
    GRIP_ENABLE is 0. Accepted, and doing nothing, when enabled but not yet
    started (the restart has not happened).
  */
  grip(p: P, grab: boolean, clock: number): boolean {
    if (p.GRIP_ENABLE !== 1) return false;
    if (!this.gripperOn || !this.gripper) return true;
    this.gripper.pwm = grab ? p.GRIP_GRAB : p.GRIP_RELEASE;
    this.gripper.closeAt = !grab && p.GRIP_AUTOCLOSE > 0 ? clock + p.GRIP_AUTOCLOSE : null;
    return true;
  }

  /** A transmitter channel scaled into an output's own range, as SRV_Channel does for RCINnScaled. */
  private scaled(p: P, output: number, input: number): number {
    const min = p[`SERVO${output}_MIN`];
    const max = p[`SERVO${output}_MAX`];
    const trim = p[`SERVO${output}_TRIM`];
    let x = Math.max(-1, Math.min(1, (input - 1500) / 400));
    if (p[`SERVO${output}_REVERSED`] === 1) x = -x;
    return x >= 0 ? trim + x * (max - trim) : trim + x * (trim - min);
  }

  /** Every output's pulse width now: what SERVO_OUTPUT_RAW reports. */
  outputs(p: P, motors: number[], armed: boolean, rc: number[], clock: number): number[] {
    if (this.gripper?.closeAt !== null && this.gripper && clock >= (this.gripper.closeAt ?? Infinity)) {
      this.gripper.pwm = p.GRIP_GRAB;
      this.gripper.closeAt = null;
    }
    const out: number[] = [];
    for (let n = 1; n <= 16; n++) {
      if (n > SIM_OUTPUTS) {
        out.push(0);
        continue;
      }
      const fn = p[`SERVO${n}_FUNCTION`] ?? 0;
      const held = this.held.get(n);
      if (held && held.rcAt !== null) {
        const ch = fn >= 51 && fn <= 66 ? fn - 50 : fn >= 140 && fn <= 155 ? fn - 139 : null;
        // A moved stick takes a pass-through back from the command.
        if (ch === null || Math.abs((rc[ch - 1] ?? 0) - held.rcAt) > 10) this.held.delete(n);
      }
      const h = this.held.get(n);
      if (h) {
        out.push(h.pwm);
        continue;
      }
      if (fn >= 33 && fn <= 36) {
        const m = motors[fn - 33] ?? 0;
        out.push(Math.round(armed ? 1000 + 1000 * Math.max(0, Math.min(1, m)) : 1000));
      } else if (fn >= 51 && fn <= 66) out.push(rc[fn - 51] ?? 0);
      else if (fn === 1) out.push(rc[n - 1] ?? 0);
      else if (fn >= 140 && fn <= 155) {
        const input = rc[fn - 140] ?? 0;
        out.push(input ? Math.round(this.scaled(p, n, input)) : p[`SERVO${n}_TRIM`]);
      } else if (fn === 28) out.push(this.gripper ? Math.round(this.gripper.pwm) : 0);
      else if (fn === 134) out.push(p[`SERVO${n}_MIN`]);
      else if (fn === 136) out.push(p[`SERVO${n}_MAX`]);
      else if (fn <= 0 || (fn >= 37 && fn <= 40)) out.push(0);
      // Anything else (camera, gimbal, landing gear…) rests at its trim here.
      else out.push(p[`SERVO${n}_TRIM`]);
    }
    return out;
  }
}
