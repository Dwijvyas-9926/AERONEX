/*
  Servo outputs: what each output pin of the flight controller does, read
  from and written to ArduCopter's own settings, and every check that stops
  a payload or a servo being wired or set up wrong.

  The rules are ArduPilot's, read from its source (Copter 4.6.3 and 4.7.2):
  - SERVOn_FUNCTION picks what output n does (SRV_Channel.h); MIN, TRIM and
    MAX bound the pulse; REVERSED flips it.
  - RC pass-through: 51-66 copies transmitter channel 1-16 exactly (the
    output's own limits do nothing); 140-155 scales it into MIN/TRIM/MAX; 1
    copies the channel with the output's own number.
  - DO_SET_SERVO, from a mission or a button, only moves an output set to
    Disabled (0), a sprayer, the gripper or an RC pass-through; any other
    answers "Channel n is already in use" (AP_ServoRelayEvents). RCPassThru (1)
    counts as a pass-through.
  - The gripper: GRIP_ENABLE = 1 shows the other GRIP_ settings, GRIP_TYPE = 1
    makes it a servo, and both take effect at the next start-up
    (AP_Gripper::init runs once). A switch on a transmitter channel with
    RCn_OPTION = 19 opens and closes it; DO_GRIPPER does from a mission.
  - Outputs that share a timer run at one rate. With motors in a group the
    whole group runs at the motor rate (RC_SPEED, 490 Hz by default) or in the
    motor protocol (MOT_PWM_TYPE OneShot/DShot), where a servo burns out or
    does nothing (AP_IOMCU::set_freq widens a request to its whole group).
  - With a safety switch, outputs stay still until it is pressed, except
    those in BRD_SAFETY_MASK.

  Everything here is a pure function of the settings, so it is tested without
  a flight controller.
*/
import { LAYOUT_BY_BOARD_ID, LAYOUT_LIKELY_BY_BOARD_ID, LAYOUT_BY_PLATFORM, OUTPUT_LAYOUTS, type OutputLayout } from "./outputs.generated";

export type Params = Record<string, number>;

/* ------------------------------------------------------------------ */
/* Functions                                                           */
/* ------------------------------------------------------------------ */

export type Category = "motor" | "payload" | "rc" | "command" | "camera" | "gimbal" | "signal" | "gpio" | "other";

export interface FunctionInfo {
  value: number;
  label: string;
  category: Category;
  /** One sentence: what this output then does. */
  what: string;
}

const F = (value: number, label: string, category: Category, what: string): FunctionInfo => ({ value, label, category, what });

/** The functions an ArduCopter builder uses, in plain words. Others are named from the firmware's own list. */
export const FUNCTIONS: FunctionInfo[] = [
  F(0, "Mission or button (Disabled)", "command", "Sends no pulses until a mission's Set servo step or a button in AERONEX moves it. ArduPilot calls this Disabled."),
  F(28, "Payload release (gripper)", "payload", "Opens and closes a gripper or drop mechanism: from a transmitter switch, a mission's Release payload step, or AERONEX."),
  F(27, "Parachute release", "payload", "Fires the parachute release servo when the parachute is deployed (needs CHUTE_ENABLED and CHUTE_TYPE = Servo)."),
  F(29, "Landing gear", "payload", "Raises and lowers retractable landing gear (needs LGR_ENABLE = 1, and a transmitter switch set to Landing gear)."),
  F(22, "Sprayer pump", "payload", "Runs a crop-sprayer pump (needs SPRAY_ENABLE)."),
  F(23, "Sprayer spinner", "payload", "Runs a crop-sprayer spinner (needs SPRAY_ENABLE)."),
  F(88, "Winch", "payload", "Drives a winch for lowering a payload (needs WINCH_TYPE)."),
  F(10, "Camera shutter", "camera", "Presses a camera's shutter with a servo (needs CAM1_TYPE = Servo)."),
  F(7, "Gimbal tilt", "gimbal", "Tilts a servo gimbal (needs MNT1_TYPE = Servo)."),
  F(8, "Gimbal roll", "gimbal", "Rolls a servo gimbal (needs MNT1_TYPE = Servo)."),
  F(6, "Gimbal pan", "gimbal", "Pans a servo gimbal (needs MNT1_TYPE = Servo)."),
  F(1, "Same-number transmitter channel", "rc", "Copies the transmitter channel with this output's number, exactly."),
  ...Array.from({ length: 16 }, (_, i) => F(51 + i, `Transmitter channel ${i + 1}`, "rc", `Copies transmitter channel ${i + 1} exactly: the output's own limits do nothing.`)),
  ...Array.from({ length: 16 }, (_, i) => F(140 + i, `Transmitter channel ${i + 1}, scaled`, "rc", `Follows transmitter channel ${i + 1}: its calibrated range (RC${i + 1}_MIN/TRIM/MAX) is mapped onto this output's lowest, centre and highest pulse.`)),
  ...Array.from({ length: 8 }, (_, i) => F(33 + i, `Motor ${i + 1}`, "motor", `Drives the ESC of motor ${i + 1}.`)),
  ...Array.from({ length: 4 }, (_, i) => F(82 + i, `Motor ${i + 9}`, "motor", `Drives the ESC of motor ${i + 9}.`)),
  F(134, "Always lowest pulse", "signal", "Holds the output at its lowest pulse."),
  F(135, "Always centre pulse", "signal", "Holds the output at its centre pulse."),
  F(136, "Always highest pulse", "signal", "Holds the output at its highest pulse."),
  F(138, "Alarm (buzzer)", "signal", "Drives an external buzzer when the alarm sounds."),
  F(120, "NeoPixel LEDs 1", "signal", "Drives a NeoPixel LED strip."),
  ...Array.from({ length: 16 }, (_, i) => F(94 + i, `Script output ${i + 1}`, "other", `Driven by a Lua script (scripting output ${i + 1}).`)),
  F(-1, "GPIO pin", "gpio", "Used as a plain on/off pin (relay, button or sensor) instead of a servo output."),
];

const byValue = new Map(FUNCTIONS.map((f) => [f.value, f]));

/** A function's plain name; the firmware's own name (from its parameter documentation) for anything not listed. */
export function functionInfo(value: number, firmwareNames?: [number, string][]): FunctionInfo {
  const known = byValue.get(value);
  if (known) return known;
  const name = firmwareNames?.find(([v]) => v === value)?.[1];
  return F(value, name ?? `Function ${value}`, "other", name ? `ArduPilot function ${value}: ${name}.` : `ArduPilot function ${value}.`);
}

/** Motor number driven by a function (33-40, 82-85, 160-…), or null. */
export function motorOf(fn: number): number | null {
  if (fn >= 33 && fn <= 40) return fn - 32;
  if (fn >= 82 && fn <= 85) return fn - 73;
  if (fn >= 160 && fn <= 179) return fn - 147;
  return null;
}

/** The transmitter channel an output follows, and whether scaled; null when it follows none. */
export function rcOf(fn: number, servo: number): { channel: number; scaled: boolean } | null {
  if (fn >= 51 && fn <= 66) return { channel: fn - 50, scaled: false };
  if (fn >= 140 && fn <= 155) return { channel: fn - 139, scaled: true };
  if (fn === 1) return { channel: servo, scaled: false };
  return null;
}

export const passThroughFunction = (channel: number, scaled: boolean) => (scaled ? 139 + channel : 50 + channel);

/** May DO_SET_SERVO move an output with this function? (AP_ServoRelayEvents::do_set_servo: none, manual, sprayer, gripper, RC pass-through) */
export function testable(fn: number): boolean {
  return fn === 0 || fn === 1 || fn === 22 || fn === 23 || fn === 28 || (fn >= 51 && fn <= 66) || (fn >= 140 && fn <= 155);
}

/** Functions a servo (not an ESC) is plugged into: the ones a motor's output rate would harm. */
function drivesServo(fn: number): boolean {
  return fn !== -1 && motorOf(fn) === null;
}

/* ------------------------------------------------------------------ */
/* Transmitter switch options (RCn_OPTION)                             */
/* ------------------------------------------------------------------ */

export interface SwitchOption {
  value: number;
  label: string;
  what: string;
}

export const SWITCH_OPTIONS: SwitchOption[] = [
  { value: 19, label: "Payload release (gripper)", what: "Switch low opens it (releases the payload), high closes it (grabs). The middle position changes nothing." },
  { value: 29, label: "Landing gear", what: "Switch low lowers the gear, high raises it (needs LGR_ENABLE = 1)." },
  { value: 9, label: "Camera shutter", what: "Switching high takes a picture." },
  { value: 22, label: "Parachute release", what: "High releases the parachute." },
  { value: 21, label: "Parachute on/off", what: "High arms the parachute so it can release." },
];

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

export interface Board {
  /** How AERONEX knows: from the board id it reports, or a guess. */
  source: "board-id" | "likely" | "profile" | "none";
  boardId: number | null;
  /** Pixhawk 2.4.8 / Pixhawk1 class: the drawing applies. */
  pixhawk1: boolean;
  layout: OutputLayout | null;
}

const PIXHAWK1 = OUTPUT_LAYOUTS[LAYOUT_BY_PLATFORM["Pixhawk1"]];

/** The board's outputs, from the board id the flight controller reports, or else the aircraft profile. */
export function boardFor(boardId: number | null, profileBoard: string | null): Board {
  if (boardId !== null) {
    const exact = LAYOUT_BY_BOARD_ID[boardId];
    if (exact !== undefined) return { source: "board-id", boardId, pixhawk1: OUTPUT_LAYOUTS[exact] === PIXHAWK1 && boardId === 9, layout: OUTPUT_LAYOUTS[exact] };
    const likely = LAYOUT_LIKELY_BY_BOARD_ID[boardId];
    if (likely !== undefined) return { source: "likely", boardId, pixhawk1: OUTPUT_LAYOUTS[likely] === PIXHAWK1, layout: OUTPUT_LAYOUTS[likely] };
    return { source: "none", boardId, pixhawk1: false, layout: null };
  }
  if (profileBoard === "pixhawk-2.4.8") return { source: "profile", boardId: null, pixhawk1: true, layout: PIXHAWK1 };
  return { source: "none", boardId: null, pixhawk1: false, layout: null };
}

/** Where an output is on the board: MAIN OUT 1-8 then AUX OUT on a board with an IO processor. */
export function portOf(servo: number, layout: OutputLayout | null): { short: string; long: string; rail: "MAIN" | "AUX" | "OUT"; index: number } {
  if (layout?.io) {
    if (servo <= 8) return { short: `MAIN ${servo}`, long: `MAIN OUT ${servo}`, rail: "MAIN", index: servo };
    return { short: `AUX ${servo - 8}`, long: `AUX OUT ${servo - 8}`, rail: "AUX", index: servo - 8 };
  }
  return { short: `Output ${servo}`, long: `Output ${servo}`, rail: "OUT", index: servo };
}

/** Which outputs exist: the board's, or the SERVOn settings the flight controller reports. */
export function outputNumbers(params: Params, layout: OutputLayout | null): number[] {
  if (layout) return layout.servos;
  const out: number[] = [];
  for (let n = 1; n <= 32; n++) if (params[`SERVO${n}_FUNCTION`] !== undefined) out.push(n);
  return out;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export interface Output {
  servo: number;
  port: ReturnType<typeof portOf>;
  fn: number;
  min: number;
  trim: number;
  max: number;
  reversed: boolean;
  /** The outputs it shares a rate with (itself included), or null when not known. */
  group: number[] | null;
  gpio: number | null;
}

export function readOutputs(params: Params, layout: OutputLayout | null): Output[] {
  return outputNumbers(params, layout).map((servo) => {
    const i = layout ? layout.servos.indexOf(servo) : -1;
    return {
      servo,
      port: portOf(servo, layout),
      fn: params[`SERVO${servo}_FUNCTION`] ?? 0,
      min: params[`SERVO${servo}_MIN`] ?? 1100,
      trim: params[`SERVO${servo}_TRIM`] ?? 1500,
      max: params[`SERVO${servo}_MAX`] ?? 1900,
      reversed: (params[`SERVO${servo}_REVERSED`] ?? 0) === 1,
      group: layout?.groups.find((g) => g.includes(servo)) ?? null,
      gpio: i >= 0 ? layout!.gpio[i] : null,
    };
  });
}

/** Motors an ArduCopter frame class drives (FRAME_CLASS), or from the heartbeat's vehicle type. */
export function motorCount(params: Params, mavType?: number): number | null {
  const fc = params.FRAME_CLASS;
  const byClass: Record<number, number> = { 1: 4, 2: 6, 3: 8, 4: 8, 5: 6, 7: 3, 12: 12, 14: 10 };
  if (fc !== undefined) return byClass[fc] ?? null;
  const byType: Record<number, number> = { 2: 4, 13: 6, 14: 8, 15: 3, 29: 12, 35: 10 };
  return mavType !== undefined ? (byType[mavType] ?? null) : null;
}

const PROTOCOL: Record<number, string> = { 1: "OneShot", 2: "OneShot125", 3: "brushed-motor PWM", 4: "DShot150", 5: "DShot300", 6: "DShot600", 7: "DShot1200" };

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

export interface Issue {
  id: string;
  level: "danger" | "warn" | "info";
  /** The output it is about, if one. */
  servo?: number;
  title: string;
  detail: string;
  /** Settings that fix it, when there is one obvious fix. */
  fix?: Params;
}

const STICKS: [string, string, number][] = [
  ["RCMAP_ROLL", "roll", 1],
  ["RCMAP_PITCH", "pitch", 2],
  ["RCMAP_THROTTLE", "throttle", 3],
  ["RCMAP_YAW", "yaw", 4],
];

/** What a transmitter channel already does for flying: a stick or the flight-mode switch. */
export function channelUse(params: Params, channel: number): string | null {
  for (const [p, what, def] of STICKS) if ((params[p] ?? def) === channel) return `the ${what} stick`;
  if ((params.FLTMODE_CH ?? 5) === channel) return "the flight-mode switch";
  return null;
}

/**
 * Everything wrong or worth knowing about how the outputs are set up.
 * `params` is the aircraft's settings with any unsaved edits applied.
 */
export function checkOutputs(params: Params, layout: OutputLayout | null, opts: { mavType?: number; rcChannels?: number } = {}): Issue[] {
  const issues: Issue[] = [];
  const outs = readOutputs(params, layout);
  const name = (o: Output) => `${o.port.long} (SERVO${o.servo})`;

  // Motors: each the frame needs, on exactly one output.
  const need = motorCount(params, opts.mavType);
  const motorOuts = new Map<number, Output[]>();
  for (const o of outs) {
    const m = motorOf(o.fn);
    if (m !== null) motorOuts.set(m, [...(motorOuts.get(m) ?? []), o]);
  }
  if (need !== null) {
    for (let m = 1; m <= need; m++) {
      const at = motorOuts.get(m) ?? [];
      if (!at.length) issues.push({ id: `motor-missing-${m}`, level: "danger", title: `Motor ${m} has no output`, detail: `The frame has ${need} motors, but no output is set to Motor ${m}, so that motor will not spin and the aircraft cannot fly. Set the output its ESC is plugged into to Motor ${m}.` });
      if (at.length > 1) issues.push({ id: `motor-twice-${m}`, level: "warn", title: `Motor ${m} is on ${at.length} outputs`, detail: `${at.map(name).join(" and ")} both drive Motor ${m}. Only one ESC should be on each motor's output.` });
    }
    for (const [m, at] of motorOuts) if (m > need) issues.push({ id: `motor-extra-${m}`, level: "warn", servo: at[0].servo, title: `Motor ${m} is set on a ${need}-motor frame`, detail: `${at.map(name).join(", ")} ${at.length === 1 ? "is" : "are"} set to Motor ${m}, which this frame does not use. It will not spin; if a servo is plugged in there, give the output its own function.` });
  }

  // Rate groups: a servo sharing a timer with a motor gets the motor's rate or protocol.
  if (layout) {
    const proto = params.MOT_PWM_TYPE ?? 0;
    const rate = params.RC_SPEED ?? 490;
    for (const g of layout.groups) {
      const groupOuts = outs.filter((o) => g.includes(o.servo));
      const motors = groupOuts.filter((o) => motorOf(o.fn) !== null);
      if (!motors.length) continue;
      for (const o of groupOuts) {
        if (!drivesServo(o.fn)) continue;
        const with_ = motors.map((m) => m.port.short).join(" and ");
        const groupText = g.map((s) => portOf(s, layout).short).join(", ");
        if (PROTOCOL[proto]) {
          issues.push({ id: `group-${o.servo}`, level: o.fn === 0 ? "info" : "danger", servo: o.servo, title: `${o.port.long} cannot drive a servo`, detail: `It is driven together with ${with_} (${groupText} share one timer), and the motors use ${PROTOCOL[proto]}, so this output sends ${PROTOCOL[proto]} too and a servo on it will not move. Use an output whose group has no motors.` });
        } else if (rate > 50) {
          issues.push({
            id: `group-${o.servo}`,
            level: o.fn === 0 ? "info" : "warn",
            servo: o.servo,
            title: `${o.port.long} runs at ${rate} Hz`,
            detail: `${groupText} share one timer with ${with_}, so this output runs at the motors' rate (RC_SPEED = ${rate} Hz). Analog servos are made for 50 Hz and can overheat or burn out; many digital servos take up to 333 Hz. Use an output whose group has no motors${layout.io ? " (AUX OUT on a Pixhawk)" : ""}.`,
          });
        }
      }
    }
  }

  // Pass-through: channels that already fly the aircraft.
  for (const o of outs) {
    const rc = rcOf(o.fn, o.servo);
    if (!rc) continue;
    const use = channelUse(params, rc.channel);
    if (use) issues.push({ id: `rc-flying-${o.servo}`, level: "warn", servo: o.servo, title: `${o.port.long} follows channel ${rc.channel}, ${use}`, detail: `It will move whenever ${use} moves. Use a spare switch or knob channel (usually 6 to 12) for a payload.` });
    const opt = params[`RC${rc.channel}_OPTION`] ?? 0;
    if (opt) issues.push({ id: `rc-option-${o.servo}`, level: "info", servo: o.servo, title: `Channel ${rc.channel} also has a switch option`, detail: `RC${rc.channel}_OPTION = ${opt}, so the same switch also does that. Make sure that is intended.` });
    if (opts.rcChannels !== undefined && opts.rcChannels > 0 && rc.channel > opts.rcChannels) issues.push({ id: `rc-none-${o.servo}`, level: "warn", servo: o.servo, title: `The receiver sends only ${opts.rcChannels} channels`, detail: `${o.port.long} follows channel ${rc.channel}, which the receiver does not send, so the output will not move. Assign a switch to channel ${rc.channel} on the transmitter, or pick a lower channel.` });
    if (!rc.scaled && (o.min !== 1100 || o.max !== 1900 || o.trim !== 1500 || o.reversed)) issues.push({ id: `rc-limits-${o.servo}`, level: "info", servo: o.servo, title: `${o.port.long}'s limits do nothing`, detail: "An exact pass-through copies the transmitter's pulse; its lowest, centre, highest and reverse settings are ignored. Choose “scaled” to have them apply." });
  }

  // Pass-through with no transmitter signal arriving: those outputs send nothing.
  const following = outs.filter((o) => rcOf(o.fn, o.servo));
  if (following.length && opts.rcChannels === 0) {
    issues.push({ id: "rc-no-signal", level: "info", title: "No transmitter signal", detail: `${following.map((o) => o.port.short).join(", ")} ${following.length === 1 ? "follows" : "follow"} a transmitter channel, but the receiver is sending nothing, so ${following.length === 1 ? "it sends" : "they send"} no pulses. Turn the transmitter on and check the receiver is bound and plugged into RC IN.` });
  }

  // The gripper: its outputs and its settings must agree; it starts only at start-up.
  const grip = outs.filter((o) => o.fn === 28);
  const gripOn = params.GRIP_ENABLE === 1;
  const gripServo = params.GRIP_TYPE === 1;
  const gripSwitches = Array.from({ length: 16 }, (_, i) => i + 1).filter((c) => params[`RC${c}_OPTION`] === 19);
  if (grip.length && !gripOn) issues.push({ id: "grip-off", level: "warn", servo: grip[0].servo, title: "The gripper is turned off", detail: `${grip.map(name).join(", ")} ${grip.length === 1 ? "is" : "are"} set to Payload release, but GRIP_ENABLE is 0, so it will never move from a switch or a mission. Turn the gripper on, then restart the flight controller.`, fix: { GRIP_ENABLE: 1 } });
  if (gripOn && params.GRIP_TYPE !== undefined && !gripServo) issues.push({ id: "grip-type", level: "warn", title: "The gripper is not set to a servo", detail: `GRIP_TYPE is ${params.GRIP_TYPE}${params.GRIP_TYPE === 0 ? " (none)" : params.GRIP_TYPE === 2 ? " (electro-permanent magnet)" : ""}. For a servo gripper or drop mechanism it must be 1, followed by a restart.`, fix: { GRIP_TYPE: 1 } });
  if (gripOn && gripServo && !grip.length) issues.push({ id: "grip-no-output", level: "warn", title: "The gripper has no output", detail: "The gripper is on, but no output is set to Payload release, so nothing moves. Pick the output its servo is plugged into." });
  if (gripOn && params.GRIP_GRAB !== undefined && params.GRIP_GRAB === params.GRIP_RELEASE) issues.push({ id: "grip-same", level: "warn", title: "Grab and release are the same position", detail: `GRIP_GRAB and GRIP_RELEASE are both ${params.GRIP_GRAB} µs, so the gripper never moves.` });
  for (const c of gripSwitches) {
    if (!gripOn) issues.push({ id: `grip-switch-${c}`, level: "warn", title: `Channel ${c}'s switch controls a gripper that is off`, detail: `RC${c}_OPTION = 19 (Gripper), but GRIP_ENABLE is 0.` });
  }

  // Switch options on channels that fly the aircraft.
  for (let c = 1; c <= 16; c++) {
    const opt = params[`RC${c}_OPTION`] ?? 0;
    if (!opt) continue;
    const use = channelUse(params, c);
    if (use) issues.push({ id: `switch-flying-${c}`, level: "danger", title: `Channel ${c} is ${use} and a switch option`, detail: `RC${c}_OPTION = ${opt} on the channel used for ${use}: moving it would also trigger that option. Move the option to a spare channel.` });
  }

  // Relay pins: an output used as a relay pin cannot also be a servo.
  for (let r = 1; r <= 16; r++) {
    const pin = params[`RELAY${r}_PIN`];
    if (pin === undefined || pin < 0) continue;
    const o = outs.find((x) => x.gpio === pin);
    if (o && o.fn !== -1) issues.push({ id: `relay-${o.servo}`, level: "warn", servo: o.servo, title: `${o.port.long} is also relay ${r}'s pin`, detail: `RELAY${r}_PIN = ${pin} is this output's pin, but the output is set to ${functionInfo(o.fn).label}. Set RELAY${r}_PIN to -1 to use it as a servo output, or set the output to GPIO pin to use it as a relay.` });
  }

  // Limits.
  for (const o of outs) {
    if (motorOf(o.fn) !== null || o.fn === -1) continue;
    if (!(o.min < o.max)) issues.push({ id: `range-${o.servo}`, level: "warn", servo: o.servo, title: `${o.port.long}: lowest is not below highest`, detail: `SERVO${o.servo}_MIN is ${o.min} µs and _MAX is ${o.max} µs. The lowest pulse must be below the highest.` });
    else if (o.trim < o.min || o.trim > o.max) issues.push({ id: `trim-${o.servo}`, level: "warn", servo: o.servo, title: `${o.port.long}: centre is outside its range`, detail: `SERVO${o.servo}_TRIM is ${o.trim} µs, outside ${o.min}-${o.max} µs.` });
    if (o.min < 800 || o.max > 2200) issues.push({ id: `wide-${o.servo}`, level: "info", servo: o.servo, title: `${o.port.long}: pulses beyond 800-2200 µs`, detail: "Most servos are made for about 1000-2000 µs. Pushed past their end stops they strain and draw high current. Widen the range only if the servo's data says it can." });
  }

  // The safety switch holds servos still until pressed (boards with one).
  if (layout?.io && (params.BRD_SAFETY_DEFLT ?? 1) !== 0) {
    const mask = params.BRD_SAFETY_MASK ?? 0;
    const held = outs.filter((o) => (o.fn === 28 || rcOf(o.fn, o.servo) || o.fn === 0) && !(mask & (1 << (o.servo - 1))) && (o.fn !== 0 || testUseful(o)));
    if (held.length) issues.push({ id: "safety", level: "info", title: "Servos wait for the safety switch", detail: `With the safety switch flashing, ${held.map((o) => o.port.short).join(", ")} stay still. Press and hold the switch until it is solid red before testing, or add the outputs to BRD_SAFETY_MASK to let them move with the switch on.` });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

/** A Disabled output counts as in use (for the safety note) only if it has been given a range of its own. */
function testUseful(o: Output): boolean {
  return o.min !== 1100 || o.max !== 1900 || o.trim !== 1500;
}

/* ------------------------------------------------------------------ */
/* Changes                                                             */
/* ------------------------------------------------------------------ */

/**
  Settings this page writes that ArduPilot applies only after a restart:
  SERVOn_FUNCTION and MOT_PWM_TYPE (documented RebootRequired), and GRIP_ENABLE
  and GRIP_TYPE (the gripper is created once, at start-up).
*/
export function needsRestart(changed: Params, before: Params): string[] {
  return Object.keys(changed).filter((k) => (k === "GRIP_ENABLE" || k === "GRIP_TYPE" || k === "MOT_PWM_TYPE" || /^SERVO\d+_FUNCTION$/.test(k)) && changed[k] !== before[k]);
}

/** The settings that make an output a payload release (gripper), with the positions to use. */
export function gripperSettings(servo: number, params: Params, pos: { grab: number; release: number; neutral: number }): { first: Params; then: Params } {
  // GRIP_ENABLE shows the other GRIP_ settings: they can only be written once it is on.
  const first: Params = { [`SERVO${servo}_FUNCTION`]: 28 };
  if (params.GRIP_ENABLE !== 1) first.GRIP_ENABLE = 1;
  const then: Params = { GRIP_TYPE: 1, GRIP_GRAB: pos.grab, GRIP_RELEASE: pos.release, GRIP_NEUTRAL: pos.neutral };
  return { first, then };
}

/** Which transmitter channel moved the most between two readings: "flip the switch you want". */
export function movedChannel(before: number[], now: number[], threshold = 150): number | null {
  let best: number | null = null;
  let most = threshold;
  for (let i = 0; i < Math.min(before.length, now.length); i++) {
    if (!before[i] || !now[i]) continue;
    const d = Math.abs(now[i] - before[i]);
    if (d >= most) {
      most = d;
      best = i + 1;
    }
  }
  return best;
}
