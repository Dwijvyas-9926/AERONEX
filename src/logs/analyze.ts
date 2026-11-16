/*
  The log checks. Each one reads the flight model, compares what it measured
  with a published threshold (ArduPilot's own wiki and source, cited per
  check), and says what it found in plain words, with the time to look at.

  Every check reports, including the ones that passed and the ones that could
  not run because the log does not hold the data, so a clean report means
  "checked and fine", never "not looked at".

  Most checks only look at the parts of the log where the aircraft was flying
  (from the autopilot's own land detector where it was logged), with the first
  second after take-off and the last two before touchdown left out: take-off
  and touchdown jolt the sensors in ways that say nothing about the aircraft.
*/
import { errMeaning, FAILSAFE_REASONS, MODE_REASON } from "./ardupilot";
import { valueAt, type Flight, type Span } from "./model";

export type Severity = "fail" | "warn" | "info" | "pass";
export type Area = "Log" | "Flight" | "Control" | "Motors" | "Vibration" | "Compass" | "GPS" | "EKF" | "Battery" | "Board power" | "Processor" | "Failsafes" | "Setup";

export interface Finding {
  id: string;
  area: Area;
  severity: Exclude<Severity, "pass">;
  title: string;
  /** What was measured and against what. */
  detail: string;
  /** What to do about it. */
  advice?: string;
  /** Seconds since log start where it shows best. */
  at?: number;
  span?: [number, number];
  /** Chart preset that shows it. */
  chart?: ChartPreset;
  /** Where the threshold comes from. */
  source?: string;
}

export interface CheckResult {
  id: string;
  area: Area;
  title: string;
  status: Severity | "skipped";
  /** One line: what was measured, or why it was skipped. */
  note: string;
}

export type ChartPreset = "attitude" | "altitude" | "vibration" | "clipping" | "motors" | "battery" | "compass" | "gps" | "ekf" | "power" | "load";

export interface Summary {
  vehicle: Flight["vehicle"];
  firmware: string | null;
  startUtc: number | null;
  logDuration: number;
  armedTime: number;
  flightTime: number;
  flights: number;
  /** Metres flown along the ground while flying. */
  distance: number | null;
  maxAltRel: number | null;
  maxSpeed: number | null;
  maxFromHome: number | null;
  usedMah: number | null;
  minVolt: number | null;
  cells: number | null;
  modes: { name: string; seconds: number }[];
}

export interface Analysis {
  summary: Summary;
  findings: Finding[];
  checks: CheckResult[];
  verdict: "fail" | "warn" | "pass";
}

export const SOURCES = {
  logs: "https://ardupilot.org/copter/docs/common-diagnosing-problems-using-logs.html",
  vibration: "https://ardupilot.org/copter/docs/common-measuring-vibration.html",
  compass: "https://ardupilot.org/copter/docs/common-compass-setup-advanced.html",
  ekf: "https://ardupilot.org/copter/docs/ekf-inav-failsafe.html",
  battery: "https://ardupilot.org/copter/docs/failsafe-battery.html",
  radio: "https://ardupilot.org/copter/docs/radio-failsafe.html",
  crash: "https://ardupilot.org/copter/docs/crash_check.html",
  notch: "https://ardupilot.org/copter/docs/common-imu-notch-filtering.html",
  tuning: "https://ardupilot.org/copter/docs/tuning-process-instructions.html",
  arming: "https://ardupilot.org/copter/docs/common-prearm-safety-checks.html",
  power: "https://ardupilot.org/copter/docs/common-powering-the-pixhawk.html",
  thrustLoss: "https://ardupilot.org/copter/docs/thrust_loss_and_yaw_imbalance.html",
} as const;

/* ───────────── helpers ───────────── */

/** The flying spans with take-off and touchdown trimmed off. */
function settled(f: Flight): Span[] {
  return f.flying.map((s) => ({ from: s.from + 1, to: s.open ? s.to : s.to - 2, open: s.open })).filter((s) => s.to - s.from > 0.5);
}

const inSpans = (spans: Span[], t: number) => spans.some((s) => t >= s.from && t <= s.to);

/** Indices of samples inside the spans. */
function within(t: Float64Array, spans: Span[]): number[] {
  const out: number[] = [];
  if (!spans.length) return out;
  for (let i = 0; i < t.length; i++) if (inSpans(spans, t[i])) out.push(i);
  return out;
}

function quantile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function maxAt(t: Float64Array, v: ArrayLike<number>, idx: number[]): { v: number; t: number } {
  let best = -Infinity;
  let at = NaN;
  for (const i of idx) {
    if (v[i] > best) {
      best = v[i];
      at = t[i];
    }
  }
  return { v: best, t: at };
}

function minAt(t: Float64Array, v: ArrayLike<number>, idx: number[]): { v: number; t: number } {
  let best = Infinity;
  let at = NaN;
  for (const i of idx) {
    if (Number.isFinite(v[i]) && v[i] < best) {
      best = v[i];
      at = t[i];
    }
  }
  return { v: best, t: at };
}

/**
  The longest run where cond holds, in seconds, with where it starts and
  ends. Gaps longer than maxGap between samples end a run; with `tolerate`,
  moments shorter than that where cond does not hold do not (an aircraft
  tumbling passes through level now and then).
*/
function longestRun(t: Float64Array, idx: number[], cond: (i: number) => boolean, maxGap = 1, tolerate = 0): { secs: number; from: number; to: number } {
  let best = { secs: 0, from: NaN, to: NaN };
  let from = NaN;
  let lastTrue = NaN;
  let prevT = NaN;
  for (const i of idx) {
    const ti = t[i];
    // A gap in the samples ends any run.
    if (Number.isFinite(prevT) && ti - prevT > maxGap) from = NaN;
    prevT = ti;
    if (cond(i)) {
      if (!Number.isFinite(from)) from = ti;
      lastTrue = ti;
      if (lastTrue - from > best.secs) best = { secs: lastTrue - from, from, to: lastTrue };
    } else if (Number.isFinite(from) && ti - lastTrue > tolerate) {
      from = NaN;
    }
  }
  return best;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
export const clock = (s: number) => {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

export const haversine = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dla = (la2 - la1) * r;
  const dlo = (lo2 - lo1) * r;
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

/** The output channels that drive motors, from SERVOn_FUNCTION (33..40 motors 1-8, 82..85 motors 9-12). */
export function motorChannels(f: Flight): number[] {
  const out: { ch: number; motor: number }[] = [];
  for (let k = 1; k <= 32; k++) {
    const fn = f.params.get(`SERVO${k}_FUNCTION`)?.last;
    if (fn === undefined) continue;
    if (fn >= 33 && fn <= 40) out.push({ ch: k - 1, motor: fn - 32 });
    else if (fn >= 82 && fn <= 85) out.push({ ch: k - 1, motor: fn - 73 });
  }
  if (out.length) return out.sort((a, b) => a.motor - b.motor).map((m) => m.ch);
  const n = f.motors ?? (f.out && f.out.ch.length >= 4 ? 4 : 0);
  return Array.from({ length: Math.min(n, f.out?.ch.length ?? 0) }, (_, i) => i);
}

/** Battery cells: from MOT_BAT_VOLT_MAX when set, else from the voltage at the start of the log. */
export function cellCount(f: Flight): { cells: number; from: "parameter" | "estimate" } | null {
  const vmax = f.params.get("MOT_BAT_VOLT_MAX")?.last;
  if (vmax && vmax > 3) return { cells: Math.max(1, Math.round(vmax / 4.2)), from: "parameter" };
  const b = f.bat[0];
  if (!b) return null;
  for (let i = 0; i < b.volt.length; i++) {
    const v = b.volt[i];
    // At rest a LiPo or Li-ion cell is at most 4.35 V (high-voltage LiPo): the fewest cells that fit.
    if (Number.isFinite(v) && v > 2.5) return { cells: Math.max(1, Math.ceil(v / 4.35 - 1e-9)), from: "estimate" };
  }
  return null;
}

/* ───────────── the checks ───────────── */

interface Ctx {
  f: Flight;
  flying: Span[];
  settled: Span[];
  armed: Span[];
  findings: Finding[];
  checks: CheckResult[];
}

type CheckFn = (c: Ctx) => void;

function result(c: Ctx, id: string, area: Area, title: string, status: CheckResult["status"], note: string) {
  c.checks.push({ id, area, title, status, note });
}

/** Status of a check from the findings it added. */
function statusOf(found: Finding[]): Severity {
  if (found.some((x) => x.severity === "fail")) return "fail";
  if (found.some((x) => x.severity === "warn")) return "warn";
  if (found.some((x) => x.severity === "info")) return "info";
  return "pass";
}

function run(c: Ctx, id: string, area: Area, title: string, body: (add: (x: Omit<Finding, "area">) => void) => string | { skip: string }) {
  const found: Finding[] = [];
  const add = (x: Omit<Finding, "area">) => found.push({ area, ...x });
  let out: string | { skip: string };
  try {
    out = body(add);
  } catch (e) {
    out = { skip: `could not run: ${e instanceof Error ? e.message : String(e)}` };
  }
  c.findings.push(...found);
  if (typeof out === "object") result(c, id, area, title, "skipped", out.skip);
  else result(c, id, area, title, statusOf(found), out);
}

/** The file itself: unreadable bytes, a cut-off end. */
const integrity: CheckFn = (c) =>
  run(c, "log.integrity", "Log", "File readable", (add) => {
    const s = c.f.raw.stats;
    if (s.skipped > 0) {
      add({
        id: "log.corrupt",
        severity: s.skipped > 1024 || s.corruptSpans > 3 ? "warn" : "info",
        title: `${s.skipped.toLocaleString()} unreadable bytes in ${s.corruptSpans} place${s.corruptSpans === 1 ? "" : "s"}`,
        detail: "Those bytes were stepped over; the messages around them may be missing. This happens when power is lost while the card is being written, or with a failing SD card.",
        advice: "If it recurs, replace the SD card with a good-quality one and check board power.",
      });
    }
    if (s.truncated) add({ id: "log.truncated", severity: "info", title: "The file ends part-way through a message", detail: "The last message was cut short. Logs often end this way when the autopilot is switched off or the download stops; everything before it reads normally." });
    if (s.unknownTypes > 0) add({ id: "log.unknown", severity: "info", title: `${s.unknownTypes} message type${s.unknownTypes === 1 ? "" : "s"} could not be read`, detail: c.f.kind === "bin" ? "They were used without a format description, so their contents are unknown." : "They are not in the MAVLink dialect AERONEX knows." });
    if (!c.f.raw.stats.messages) return { skip: "no messages could be read" };
    return `${s.messages.toLocaleString()} messages read${s.skipped ? `, ${s.skipped} bytes skipped` : ", none skipped"}`;
  });

/** Did the log stop while flying (power loss, crash, or the card or link stopping)? */
const logEnd: CheckFn = (c) =>
  run(c, "flight.end", "Flight", "Log ends on the ground", (add) => {
    const f = c.f;
    if (!f.flying.length) return f.armed.length ? "armed but never left the ground" : { skip: "the aircraft never flew in this log" };
    const last = f.flying[f.flying.length - 1];
    if (!last.open) return `down and disarmed or landed at ${clock(last.to)}`;
    const rel = f.pos ? f.pos.rel[f.pos.rel.length - 1] : NaN;
    const relTxt = Number.isFinite(rel) ? ` at ${fmt(rel)} m above home` : "";
    // Still: near home's height, not climbing or sinking, not moving. Then it was down, just never disarmed.
    const climb = f.ctl ? f.ctl.climb[f.ctl.climb.length - 1] : NaN;
    const g = f.gps[0];
    const speed = g ? g.speed[g.speed.length - 1] : NaN;
    // ArduPilot's log analyser (TestBrownout) counts a log ending armed within 3 m of home's height as on the ground.
    const down = Number.isFinite(rel) && Math.abs(rel) < 3 && !(Math.abs(climb) > 0.5) && !(speed > 1);
    if (down) {
      add({
        id: "flight.end.armed",
        severity: "warn",
        title: "The log ends with the motors still armed",
        detail: `The aircraft was down${relTxt} and still, but it never disarmed and the autopilot never registered a landing. That happens when the battery is unplugged with the motors armed, or after a tip-over that the land detector cannot recognise.`,
        advice: "Always disarm before unplugging the battery. If it tipped over, see the attitude and motor charts just before.",
        at: Math.max(0, f.duration - 5),
        chart: "attitude",
      });
      return `ended armed on the ground${relTxt}`;
    }
    if (f.kind === "bin") {
      add({
        id: "flight.end.airborne",
        severity: "fail",
        title: "The log stops while the aircraft was still flying",
        detail: `Recording ends at ${clock(f.duration)}${relTxt}, with no landing or disarm. An on-board log stopping in the air means the autopilot lost power (a brownout) or was hit hard enough to stop.`,
        advice: "Check the last seconds of board voltage, battery voltage and current; check the power module, its connector and wiring, and the battery.",
        at: Math.max(0, f.duration - 5),
        chart: f.power ? "power" : "battery",
        source: SOURCES.logs,
      });
    } else {
      add({
        id: "flight.end.airborne",
        severity: "warn",
        title: "Telemetry stops while the aircraft was still flying",
        detail: `The recording ends at ${clock(f.duration)}${relTxt}. A .tlog is what reached the ground station, so this can be the radio link dropping or the recording being stopped, as well as the aircraft losing power.`,
        advice: "Open the on-board .bin log of the same flight to see what the aircraft did after this.",
        at: Math.max(0, f.duration - 5),
      });
    }
    return `ended in the air${relTxt}`;
  });

/** Crashes the autopilot detected, thrust loss, and attitude lost. */
const crash: CheckFn = (c) =>
  run(c, "flight.crash", "Flight", "No crash or loss of control", (add) => {
    const f = c.f;
    for (const it of f.timeline) {
      if (it.kind === "error" && Math.floor(it.code / 1000) === 12 && it.code % 1000 > 0) {
        add({ id: "flight.crash.detected", severity: "fail", title: it.code % 1000 === 1 ? "The autopilot detected a crash and disarmed" : "The autopilot detected a loss of control", detail: `At ${clock(it.t)}. ArduPilot's crash check fires when the aircraft is more than 30° off the angle it wants, for 2 seconds, while barely moving.`, at: it.t, chart: "attitude", source: SOURCES.crash });
      }
      if (it.kind === "error" && Math.floor(it.code / 1000) === 25 && it.code % 1000 > 0) {
        add({ id: "flight.thrustloss", severity: "fail", title: "Thrust loss: full throttle and still descending", detail: `At ${clock(it.t)} the motors were near full output while the aircraft was level and sinking — a motor, propeller or ESC failing, or too little thrust for the weight.`, advice: "Inspect motors, propellers and ESCs; check the take-off weight against the motors' thrust.", at: it.t, chart: "motors", source: SOURCES.thrustLoss });
      }
      if (it.kind === "message" && /crash|thrust loss|yaw imbalance/i.test(it.text) && !/^SIM /.test(it.text)) {
        const loss = /thrust loss/i.test(it.text);
        const yaw = /yaw imbalance/i.test(it.text);
        add({ id: loss ? "flight.thrustloss" : yaw ? "motors.yawimbalance" : "flight.crash.msg", severity: yaw ? "warn" : "fail", title: `Autopilot reported: “${it.text}”`, detail: yaw ? "One motor is working harder than the others to hold yaw: a twisted motor mount, a bent arm or a failing motor." : `At ${clock(it.t)}.`, at: it.t, chart: "motors", source: SOURCES.thrustLoss });
      }
    }
    // Upside down or on its side at the end of the log.
    if (f.att && f.att.t.length) {
      const n = f.att.t.length - 1;
      const lean = Math.max(Math.abs(f.att.roll[n]), Math.abs(f.att.pitch[n]));
      if (lean > 60) add({ id: "flight.end.attitude", severity: "fail", title: `The log ends with the aircraft tilted ${fmt(lean, 0)}°`, detail: "It finished on its side or upside down, which happens after a crash or tip-over on landing.", at: Math.max(0, f.att.t[n] - 5), chart: "attitude" });
    }
    return f.flying.length ? "no crash reported" : "never flew";
  });

const NO_TRACKING_MODES = new Set([1, 13, 14, 18, 28]);

/** Desired vs actual roll and pitch. A sustained gap is a failing motor, a broken arm, or bad tuning. */
const tracking: CheckFn = (c) =>
  run(c, "control.attitude", "Control", "Attitude follows the controller", (add) => {
    const a = c.f.att;
    if (!a) return { skip: "no attitude in this log" };
    if (!a.desRoll.some(Number.isFinite)) return { skip: "no desired attitude in this log" };
    const modeAt = (t: number) => {
      let m = NaN;
      for (const x of c.f.modes) if (x.t <= t) m = x.mode;
      return m;
    };
    const idx = within(a.t, c.settled).filter((i) => Number.isFinite(a.desRoll[i]) && !NO_TRACKING_MODES.has(modeAt(a.t[i])));
    if (idx.length < 10) return { skip: "not enough flying time with a desired attitude" };
    const err = new Float64Array(a.t.length);
    for (const i of idx) err[i] = Math.max(Math.abs(a.desRoll[i] - a.roll[i]), Math.abs(a.desPitch[i] - a.pitch[i]));
    const p95 = quantile(idx.map((i) => err[i]), 0.95);
    const gap = c.f.kind === "tlog" ? 1.5 : 0.5;
    const lost = longestRun(a.t, idx, (i) => err[i] > 30, gap, 0.5);
    const off = longestRun(a.t, idx, (i) => err[i] > 10, gap, 0.25);
    const worst = maxAt(a.t, err, idx);
    if (lost.secs >= 1) {
      add({ id: "control.attitude.lost", severity: "fail", title: `Attitude control lost at ${clock(lost.from)}`, detail: `For ${fmt(lost.secs)} s from ${clock(lost.from)} the aircraft was more than 30° away from the angle the autopilot asked for (largest gap ${fmt(worst.v, 0)}°). A motor, ESC or propeller stopping, or a frame failure, looks like this.`, advice: "Look at the motor outputs at that moment: a motor at full output while the aircraft still falls to its side is the one that failed.", at: lost.from, span: [lost.from, lost.to], chart: "attitude", source: SOURCES.logs });
    } else if (off.secs >= 1) {
      add({ id: "control.attitude.off", severity: "warn", title: `Roll or pitch strayed more than 10° from the target for ${fmt(off.secs)} s`, detail: `Starting ${clock(off.from)}. Largest gap ${fmt(worst.v)}°. Strong wind, a heavy or off-centre payload, or soft tuning cause this.`, advice: "If it was not windy, re-tune (AutoTune) and check the centre of gravity.", at: off.from, span: [off.from, off.to], chart: "attitude", source: SOURCES.tuning });
    } else if (p95 > 5) {
      add({ id: "control.attitude.loose", severity: "info", title: "Attitude tracking is loose", detail: `95% of the time roll and pitch were within ${fmt(p95)}° of the target (a well-tuned copter stays within about 2–3°).`, advice: "Consider AutoTune once vibration and the frame are in order.", chart: "attitude", source: SOURCES.tuning });
    }
    return `95% of the time within ${fmt(p95)}° of the target; largest gap ${fmt(worst.v)}°`;
  });

/** Motor outputs: saturation, one motor working much harder, hover throttle. */
const motors: CheckFn = (c) =>
  run(c, "motors.outputs", "Motors", "Motor outputs balanced, with headroom", (add) => {
    const f = c.f;
    if (!f.out) return { skip: "no motor outputs in this log" };
    const chans = motorChannels(f);
    if (chans.length < 2) return { skip: "could not tell which outputs drive motors" };
    const idx = within(f.out.t, c.settled);
    if (idx.length < 10) return { skip: "not enough flying time" };
    const pmin = f.params.get("MOT_PWM_MIN")?.last || 1000;
    const pmax = f.params.get("MOT_PWM_MAX")?.last || 2000;
    const range = pmax - pmin;
    const means = chans.map((ch) => idx.reduce((s, i) => s + f.out!.ch[ch][i], 0) / idx.length);
    const hi = Math.max(...means);
    const lo = Math.min(...means);
    const hiMotor = means.indexOf(hi) + 1;
    const loMotor = means.indexOf(lo) + 1;

    // Saturation: any motor at (or within 2% of) full output.
    const top = pmax - 0.02 * range;
    const sat = chans.map((ch) => longestRun(f.out!.t, idx, (i) => f.out!.ch[ch][i] >= top, 0.5));
    const worst = sat.reduce((a, b, k) => (b.secs > a.s.secs ? { s: b, k } : a), { s: sat[0], k: 0 });
    let satTotal = 0;
    for (const ch of chans) {
      let n = 0;
      for (const i of idx) if (f.out.ch[ch][i] >= top) n++;
      satTotal = Math.max(satTotal, n / idx.length);
    }
    if (worst.s.secs >= 2) {
      add({ id: "motors.saturated", severity: "fail", title: `Motor ${worst.k + 1} at full output for ${fmt(worst.s.secs)} s`, detail: `From ${clock(worst.s.from)}: with a motor pinned at its maximum the autopilot has no control left on that side. This is a failing motor or ESC on the opposite side, a broken propeller, or too much weight.`, advice: "Check the motor opposite it, its propeller and ESC; check the all-up weight.", at: worst.s.from, span: [worst.s.from, worst.s.to], chart: "motors", source: SOURCES.thrustLoss });
    } else if (satTotal > 0.05) {
      add({ id: "motors.saturated.often", severity: "warn", title: `Motors hit full output ${fmt(satTotal * 100, 0)}% of the flight`, detail: "Brief moments at maximum mean little headroom for gusts or manoeuvres.", advice: "Lighter payload, larger propellers or more powerful motors.", chart: "motors", source: SOURCES.thrustLoss });
    }

    // ArduPilot's log analyser (TestMotorBalance): averages more than 75 µs apart warn, more than 150 µs fail.
    const diff = hi - lo;
    if (diff > 150) {
      add({ id: "motors.imbalance", severity: "fail", title: `Motor ${hiMotor} works much harder than motor ${loMotor}`, detail: `Their average outputs in flight differ by ${fmt(diff, 0)} µs (ArduPilot's log analyser fails more than 150). The aircraft is fighting to stay level or hold its heading: a centre of gravity off to one side, a twisted motor mount or bent arm, or a weak motor, ESC or propeller.`, advice: `Balance the payload over the centre; check that motor ${hiMotor} and its arm are straight, its propeller is the right one and undamaged.`, chart: "motors", source: SOURCES.thrustLoss });
    } else if (diff > 75) {
      add({ id: "motors.imbalance", severity: "warn", title: `Motor ${hiMotor} works harder than motor ${loMotor}`, detail: `Their average outputs in flight differ by ${fmt(diff, 0)} µs (ArduPilot's log analyser warns above 75). Common with an off-centre battery or a slightly twisted arm.`, advice: "Centre the battery and payload; check the motor mounts are square.", chart: "motors", source: SOURCES.thrustLoss });
    }

    // Hover throttle: how much of the motors' thrust it takes to hover.
    const thh = f.ctl ? quantile(within(f.ctl.t, c.settled).map((i) => f.ctl!.thrHover[i]), 0.5) : NaN;
    const hov = Number.isFinite(thh) ? thh : f.params.get("MOT_THST_HOVER")?.last;
    if (hov !== undefined && Number.isFinite(hov) && hov > 0) {
      if (hov > 0.75) add({ id: "motors.hover.high", severity: "warn", title: `Hovering takes ${fmt(hov * 100, 0)}% throttle`, detail: "Above about 70% there is little thrust left to climb, fight wind or recover. ArduPilot's default assumption is 35%.", advice: "Reduce weight or fit more thrust.", chart: "motors" });
      else if (hov < 0.15) add({ id: "motors.hover.low", severity: "info", title: `Hovering takes only ${fmt(hov * 100, 0)}% throttle`, detail: "A very overpowered aircraft is hard to control smoothly at the bottom of the throttle range.", advice: "Consider smaller propellers or lower voltage, or raise MOT_SPIN_MIN carefully." });
    }
    return `average outputs ${means.map((x) => fmt(x, 0)).join(", ")} µs (${fmt(diff, 0)} apart)${Number.isFinite(hov ?? NaN) ? `; hover throttle ${fmt((hov as number) * 100, 0)}%` : ""}`;
  });

/** Vibration and accelerometer clipping per IMU. */
const vibration: CheckFn = (c) =>
  run(c, "vibe", "Vibration", "Vibration within limits", (add) => {
    const f = c.f;
    if (!f.vibe.length) return { skip: "no vibration data in this log" };
    const notes: string[] = [];
    for (const v of f.vibe) {
      const idx = within(v.t, c.settled);
      if (idx.length < 5) continue;
      const label = f.vibe.length > 1 ? `IMU ${v.imu + 1}` : "";
      if (v.x.some(Number.isFinite)) {
        const per = (["x", "y", "z"] as const).map((k) => ({ k, p95: quantile(idx.map((i) => v[k][i]), 0.95), max: maxAt(v.t, v[k], idx) }));
        const w = per.reduce((a, b) => (b.p95 > a.p95 ? b : a));
        notes.push(`${label ? label + ": " : ""}${fmt(w.p95)} m/s² (${w.k.toUpperCase()}, 95th percentile)`);
        if (w.p95 > 60) add({ id: `vibe.high.${v.imu}`, severity: "fail", title: `${label ? label + " " : ""}vibration is far too high: ${fmt(w.p95, 0)} m/s²`, detail: `Above 60 m/s² ArduPilot nearly always has trouble holding position and altitude, and can lose it entirely. Peak ${fmt(w.max.v, 0)} m/s² at ${clock(w.max.t)}.`, advice: "Balance or replace propellers, check motor bearings, and soft-mount the flight controller.", at: w.max.t, chart: "vibration", source: SOURCES.vibration });
        else if (w.p95 > 30) add({ id: `vibe.high.${v.imu}`, severity: "warn", title: `${label ? label + " " : ""}vibration is high: ${fmt(w.p95, 0)} m/s²`, detail: `Above 30 m/s² altitude and position hold can suffer. Peak ${fmt(w.max.v, 0)} m/s² at ${clock(w.max.t)}.`, advice: "Balance propellers, tighten the frame, and soft-mount the flight controller.", at: w.max.t, chart: "vibration", source: SOURCES.vibration });
      }
      // Clipping: the accelerometer hit the end of its range. Counted since boot.
      let first = NaN;
      let lastC = NaN;
      for (const i of idx) {
        if (!Number.isFinite(v.clip[i])) continue;
        if (!Number.isFinite(first)) first = v.clip[i];
        lastC = v.clip[i];
      }
      const added = lastC - first;
      if (Number.isFinite(added) && added > 0) {
        const hit = idx.find((i) => v.clip[i] > first);
        const at = hit === undefined ? NaN : v.t[hit];
        add({ id: `vibe.clip.${v.imu}`, severity: added >= 100 ? "fail" : "warn", title: `${label ? label + " " : ""}accelerometer clipped ${added.toLocaleString()} time${added === 1 ? "" : "s"} in flight`, detail: `Clipping means the vibration went past what the sensor can measure, so the autopilot's idea of acceleration was wrong at those moments. It should stay at zero; ${added >= 100 ? "this many points to a serious vibration problem" : "a few can come from a bump, but more is a vibration problem"}.`, advice: "Fix the vibration source: propellers, motors, loose parts, and the flight controller mount.", at: Number.isFinite(at) ? at : undefined, chart: "clipping", source: SOURCES.vibration });
        notes.push(`${label ? label + " " : ""}${added} clips`);
      }
    }
    if (!notes.length) return { skip: "not enough flying time" };
    return notes.join("; ");
  });

/**
  Magnetic field strength, and how much it changes while armed. The Earth's
  field has the same strength whichever way the aircraft points, so a change
  in it is interference (current in power wires, motor magnets) or a bad
  calibration. Thresholds are ArduPilot's own log analyser's (LogAnalyzer
  TestCompass, used by Mission Planner's auto analysis): field length 120–550,
  a change of more than 25% a warning, more than 35% a failure. Measured
  between the 2nd and 98th percentiles rather than the extremes, so a single
  bad sample does not decide it.
*/
const compass: CheckFn = (c) =>
  run(c, "compass", "Compass", "Compass field steady", (add) => {
    const f = c.f;
    if (!f.mag.length) return { skip: "no compass data in this log" };
    const notes: string[] = [];
    for (const m of f.mag) {
      const use = f.params.get(m.instance === 0 ? "COMPASS_USE" : `COMPASS_USE${m.instance + 1}`)?.last;
      const inUse = use === undefined || use !== 0;
      const sev = (s: "fail" | "warn") => (inUse ? s : "info");
      const note = inUse ? "" : " This compass is not used for navigation (COMPASS_USE is 0).";
      // While armed: the motors running, on the ground and in the air. All-zero samples are a sensor not reporting.
      const idx = within(m.t, c.armed).filter((i) => m.x[i] || m.y[i] || m.z[i]);
      if (idx.length < 10) continue;
      const len = idx.map((i) => Math.hypot(m.x[i], m.y[i], m.z[i]));
      const lo = quantile(len, 0.02);
      const hi = quantile(len, 0.98);
      const label = f.mag.length > 1 ? `Compass ${m.instance + 1}` : "Compass";
      const change = lo > 0 ? ((hi - lo) / lo) * 100 : NaN;
      // When the field is strongest relative to the quietest moment: where to look.
      const peak = maxAt(m.t, Float64Array.from(m.t, (_, i) => Math.hypot(m.x[i], m.y[i], m.z[i])), idx);
      if (change > 35) add({ id: `compass.change.${m.instance}`, severity: sev("fail"), title: `${label} field strength changes ${fmt(change, 0)}% in flight`, detail: `From ${fmt(lo, 0)} to ${fmt(hi, 0)} mGauss while armed. The Earth's field does not change as the aircraft turns, so this is interference from power wiring or the motors, or a poor calibration. ArduPilot's log analyser fails a change over 35%.${note}`, advice: "Move the compass (on the GPS mast) away from power wires and the battery, twist the battery leads together, recalibrate, and run compass/motor calibration (compassmot).", at: peak.t, chart: "compass", source: SOURCES.compass });
      else if (change > 25) add({ id: `compass.change.${m.instance}`, severity: sev("warn"), title: `${label} field strength changes ${fmt(change, 0)}% in flight`, detail: `From ${fmt(lo, 0)} to ${fmt(hi, 0)} mGauss while armed. ArduPilot's log analyser warns above 25%: heading may drift when throttle changes.${note}`, advice: "Raise the compass away from power wiring and run compass/motor calibration (compassmot).", at: peak.t, chart: "compass", source: SOURCES.compass });
      if (lo < 120 || hi > 550) add({ id: `compass.length.${m.instance}`, severity: sev("warn"), title: `${label} field strength ${lo < 120 ? `drops to ${fmt(lo, 0)}` : `reaches ${fmt(hi, 0)}`} mGauss`, detail: `A calibrated compass measures the Earth's field at 120–550 mGauss. Outside that range it is uncalibrated, faulty, or next to something magnetic.${note}`, advice: "Recalibrate away from metal and electronics; move the compass away from power wires and the battery.", at: peak.t, chart: "compass", source: SOURCES.logs });
      notes.push(`${label}: ${fmt(lo, 0)}–${fmt(hi, 0)} mGauss, ${fmt(change, 0)}% change`);
    }
    for (const it of f.timeline) {
      if (it.kind === "error" && Math.floor(it.code / 1000) === 3 && it.code % 1000 > 0) add({ id: "compass.error", severity: "fail", title: it.text, detail: `At ${clock(it.t)}.`, at: it.t, chart: "compass" });
    }
    if (!notes.length) return { skip: "no compass data while armed" };
    return notes.join("; ");
  });

/** Satellites, HDOP, fix lost, glitches. */
const gpsCheck: CheckFn = (c) =>
  run(c, "gps", "GPS", "GPS fix good", (add) => {
    const f = c.f;
    if (!f.gps.length) return { skip: "no GPS in this log" };
    const notes: string[] = [];
    for (const g of f.gps) {
      const idx = within(g.t, c.flying);
      if (idx.length < 3) continue;
      const label = f.gps.length > 1 ? `GPS ${g.instance + 1}` : "GPS";
      if (!g.status.some((s) => s >= 2)) {
        if (g.instance === 0) add({ id: `gps.none.${g.instance}`, severity: "warn", title: `${label} never had a fix`, detail: "Flights without GPS can only use modes that do not need position (Stabilize, AltHold)." });
        continue;
      }
      const noFix = longestRun(g.t, idx, (i) => g.status[i] < 3, 2);
      if (noFix.secs > 0) add({ id: `gps.lost.${g.instance}`, severity: g.instance === 0 ? "fail" : "warn", title: `${label} lost its 3D fix in flight for ${fmt(noFix.secs)} s`, detail: `From ${clock(noFix.from)}. Without a fix, modes that hold position cannot work and the EKF falls back to dead reckoning.`, advice: "Check the GPS antenna's view of the sky, its cable, and interference from video transmitters or USB 3 devices.", at: noFix.from, span: [noFix.from, noFix.to], chart: "gps" });
      const sats = minAt(g.t, g.sats, idx);
      const hd = quantile(idx.map((i) => g.hdop[i]), 0.95);
      if (Number.isFinite(sats.v)) {
        if (sats.v < 6) add({ id: `gps.sats.${g.instance}`, severity: "fail", title: `${label} dropped to ${sats.v} satellites`, detail: `At ${clock(sats.t)}. Six is the minimum for a usable position; twelve or more is good.`, at: sats.t, chart: "gps", source: SOURCES.logs });
        else if (sats.v < 10) add({ id: `gps.sats.${g.instance}`, severity: "warn", title: `${label} had as few as ${sats.v} satellites`, detail: `At ${clock(sats.t)}. ArduPilot's guidance: twelve or more is good; fewer makes the position less reliable.`, at: sats.t, chart: "gps", source: SOURCES.logs });
      }
      if (Number.isFinite(hd)) {
        if (hd > 2) add({ id: `gps.hdop.${g.instance}`, severity: "warn", title: `${label} HDOP was poor: ${fmt(hd, 2)}`, detail: "95% of the flight it was at or below this. Under 1.5 is very good; above 2.0 the position is poor.", chart: "gps", source: SOURCES.logs });
      }
      notes.push(`${label}: at least ${Number.isFinite(sats.v) ? sats.v : "—"} satellites, HDOP ${fmt(hd, 2)} (95th percentile)`);
    }
    for (const it of f.timeline) {
      if ((it.kind === "error" && it.code === 11002) || (it.kind === "event" && it.code === 19)) add({ id: `gps.glitch.${it.t}`, severity: "fail", title: it.kind === "error" ? "GPS glitch" : "GPS lost", detail: `At ${clock(it.t)} the EKF rejected the GPS position as inconsistent with the other sensors.`, advice: "Check the GPS's view of the sky and interference near the receiver.", at: it.t, chart: "gps", source: SOURCES.logs });
    }
    if (!notes.length) return { skip: "no GPS data while flying" };
    return notes.join("; ");
  });

/** EKF innovation test ratios, failsafes, lane switches. */
const ekfCheck: CheckFn = (c) =>
  run(c, "ekf", "EKF", "Position estimate consistent", (add) => {
    const f = c.f;
    const e = f.ekf;
    for (const it of f.timeline) {
      const sub = Math.floor(it.code / 1000);
      const code = it.code % 1000;
      if (it.kind !== "error") continue;
      if ((sub === 16 || sub === 17) && code > 0) add({ id: `ekf.err.${sub}.${it.t}`, severity: "fail", title: sub === 17 ? "EKF failsafe triggered" : "EKF variance too high", detail: `At ${clock(it.t)}. The autopilot stopped trusting its own position estimate${sub === 17 ? " and switched to a failsafe mode" : ""}.`, advice: "Look at which test ratio rose first: velocity or position points to GPS, magnetometer to the compass.", at: it.t, chart: "ekf", source: SOURCES.ekf });
    }
    if (!e) return { skip: "no EKF status in this log" };
    const idx = within(e.t, c.flying);
    if (idx.length < 5) return { skip: "not enough flying time" };
    const thresh = f.params.get("FS_EKF_THRESH")?.last || 0.8;
    const names = { vel: "velocity", posH: "horizontal position", posV: "height", mag: "compass" } as const;
    const peaks: string[] = [];
    let worst = { k: "", v: 0 };
    for (const k of ["vel", "posH", "posV", "mag"] as const) {
      const s = e[k];
      const top = maxAt(e.t, s, idx);
      const over = longestRun(e.t, idx, (i) => s[i] >= 1, 1.5);
      const high = longestRun(e.t, idx, (i) => s[i] >= thresh, 1.5);
      if (top.v > worst.v) worst = { k, v: top.v };
      peaks.push(`${names[k]} ${fmt(top.v, 2)}`);
      if (over.secs >= 1) add({ id: `ekf.${k}.reject`, severity: "fail", title: `EKF ${names[k]} check failed for ${fmt(over.secs)} s`, detail: `From ${clock(over.from)} the ${names[k]} test ratio was above 1, so the EKF was rejecting that sensor.`, advice: k === "mag" ? "Compass interference or bad calibration." : k === "posV" ? "Barometer disturbed by prop wash or vibration, or a bad GPS height." : "GPS glitches or high vibration.", at: over.from, span: [over.from, over.to], chart: "ekf", source: SOURCES.ekf });
      else if (high.secs >= 1) add({ id: `ekf.${k}.high`, severity: "warn", title: `EKF ${names[k]} test ratio above the failsafe level (${fmt(thresh, 1)}) for ${fmt(high.secs)} s`, detail: `From ${clock(high.from)}. Below 0.5 is normal; held above ${fmt(thresh, 1)} with another one the EKF failsafe triggers.`, at: high.from, chart: "ekf", source: SOURCES.ekf });
    }
    const switches = f.timeline.filter((it) => it.kind === "error" && Math.floor(it.code / 1000) === 24 && inSpans(c.flying, it.t));
    if (switches.length) add({ id: "ekf.lane", severity: "warn", title: `The autopilot switched EKF lanes ${switches.length} time${switches.length === 1 ? "" : "s"} in flight`, detail: "It changes lanes when the one in use looks worse than another, usually because one IMU or compass disagrees with the others.", at: switches[0].t, chart: "ekf", source: SOURCES.ekf });
    return `largest test ratios: ${peaks.join(", ")}`;
  });

/** Battery voltage under load, capacity used, current sensor. */
const battery: CheckFn = (c) =>
  run(c, "battery", "Battery", "Battery healthy", (add) => {
    const f = c.f;
    const b = f.bat[0];
    if (!b || !b.volt.some(Number.isFinite)) return { skip: "no battery monitor in this log" };
    const idx = within(b.t, c.flying);
    const cells = cellCount(f);
    const notes: string[] = [];
    const all = Array.from({ length: b.t.length }, (_, i) => i);
    const minV = minAt(b.t, b.volt, idx.length ? idx : all);
    if (Number.isFinite(minV.v)) notes.push(`lowest ${fmt(minV.v, 2)} V${cells ? ` (${fmt(minV.v / cells.cells, 2)} V a cell, ${cells.cells}S${cells.from === "estimate" ? " estimated" : ""})` : ""}`);
    if (cells && idx.length && Number.isFinite(minV.v)) {
      const per = minV.v / cells.cells;
      const est = cells.from === "estimate" ? ` The cell count (${cells.cells}) is estimated from the starting voltage; set MOT_BAT_VOLT_MAX for a sure count.` : "";
      // Held for a second, not a momentary dip on a hard punch of throttle.
      const n = cells.cells;
      const under = (lim: number) => longestRun(b.t, idx, (i) => b.volt[i] / n < lim, 2);
      const crit = under(3.3);
      const low = under(3.5);
      if (crit.secs >= 1) add({ id: "battery.low", severity: "fail", title: `Battery fell to ${fmt(per, 2)} V a cell`, detail: `Below 3.3 V a cell for ${fmt(crit.secs)} s from ${clock(crit.from)}, lowest ${fmt(minV.v, 2)} V at ${clock(minV.t)}. Below about 3.3 V a cell under load a LiPo is close to empty and can be damaged; the aircraft may not have the power to land.${est}`, advice: "Land earlier: set BATT_LOW_VOLT and BATT_CRT_VOLT with failsafe actions, or use a larger battery.", at: minV.t, chart: "battery", source: SOURCES.battery });
      else if (low.secs >= 1) add({ id: "battery.low", severity: "warn", title: `Battery got down to ${fmt(per, 2)} V a cell`, detail: `Below 3.5 V a cell for ${fmt(low.secs)} s from ${clock(low.from)}, lowest ${fmt(minV.v, 2)} V. That is near the end of a LiPo's useful charge.${est}`, advice: "Plan shorter flights or a larger battery; check the low-battery failsafe is set.", at: minV.t, chart: "battery", source: SOURCES.battery });
      // Sag: the drop from just before take-off to the lowest point in the first minute of flight.
      const first = f.flying[0];
      const rest = valueAt(b.t, b.volt, first.from - 0.5);
      const early = idx.filter((i) => b.t[i] < first.from + 60);
      const lowEarly = minAt(b.t, b.volt, early);
      const sag = (rest - lowEarly.v) / cells.cells;
      if (Number.isFinite(sag) && sag > 0.5) add({ id: "battery.sag", severity: "warn", title: `Battery voltage sags ${fmt(sag, 2)} V a cell under load`, detail: `From ${fmt(rest, 2)} V before take-off to ${fmt(lowEarly.v, 2)} V in the first minute. A healthy battery sized for the aircraft sags by less than about 0.3–0.5 V a cell.`, advice: "The battery is ageing, too small for the current, or its connector or wiring has high resistance.", at: lowEarly.t, chart: "battery" });
    }
    const usedEnd = (() => {
      for (let i = b.used.length - 1; i >= 0; i--) if (Number.isFinite(b.used[i])) return b.used[i];
      return NaN;
    })();
    const cap = f.params.get("BATT_CAPACITY")?.last;
    if (Number.isFinite(usedEnd) && usedEnd > 0) {
      notes.push(`${fmt(usedEnd, 0)} mAh used${cap ? ` of ${fmt(cap, 0)}` : ""}`);
      if (cap && cap > 0) {
        const share = usedEnd / cap;
        if (share > 0.9) add({ id: "battery.capacity", severity: "fail", title: `${fmt(share * 100, 0)}% of the battery's capacity used`, detail: `${fmt(usedEnd, 0)} of ${fmt(cap, 0)} mAh (BATT_CAPACITY). Landing with less than 10% left wears the battery and leaves nothing for a go-around.`, advice: "Land with 20–30% left; set BATT_LOW_MAH with a failsafe action.", chart: "battery", source: SOURCES.battery });
        else if (share > 0.8) add({ id: "battery.capacity", severity: "warn", title: `${fmt(share * 100, 0)}% of the battery's capacity used`, detail: `${fmt(usedEnd, 0)} of ${fmt(cap, 0)} mAh. Aim to land with 20–30% left.`, chart: "battery", source: SOURCES.battery });
      }
    }
    const hasCurr = b.curr.some((v) => Number.isFinite(v) && v > 0.05);
    if (!hasCurr && f.armed.length) add({ id: "battery.nocurrent", severity: "info", title: "No battery current measured", detail: "The battery monitor reports voltage only, so mAh used and the capacity failsafe (BATT_LOW_MAH) cannot work.", advice: "Use a power module with a current sensor and set BATT_MONITOR to match it." });
    return notes.join("; ") || "battery readings present";
  });

/** Flight controller supply voltage. */
const boardPower: CheckFn = (c) =>
  run(c, "power", "Board power", "Flight controller supply steady", (add) => {
    const p = c.f.power;
    if (!p || !p.vcc.some((v) => v > 0)) return { skip: c.f.kind === "bin" ? "no POWR messages in this log (SITL and some boards do not log them)" : "no POWER_STATUS in this telemetry" };
    const idx = within(p.t, c.armed);
    const use = idx.length ? idx : Array.from({ length: p.t.length }, (_, i) => i);
    const lo = minAt(p.t, p.vcc, use);
    const hi = maxAt(p.t, p.vcc, use);
    if (lo.v < 4.3 || hi.v > 5.8) add({ id: "power.vcc.range", severity: "fail", title: `Board voltage went ${lo.v < 4.3 ? `down to ${fmt(lo.v, 2)}` : `up to ${fmt(hi.v, 2)}`} V`, detail: "A Pixhawk-class board needs 4.3–5.8 V (the range its pre-arm check allows); outside it the board can reset in the air or its sensors misbehave.", advice: "Check the power module and its 5 V output; never power servos or LEDs from the flight controller's rail.", at: lo.v < 4.3 ? lo.t : hi.t, chart: "power", source: SOURCES.power });
    else if (lo.v < 4.6) add({ id: "power.vcc.low", severity: "warn", title: `Board voltage dipped to ${fmt(lo.v, 2)} V`, detail: "ArduPilot's log analyser flags a board supply below 4.6 V: close to the point where the board resets.", advice: "Check the power module's 5 V output and what else draws from the board's rail.", at: lo.t, chart: "power", source: SOURCES.power });
    const swing = hi.v - lo.v;
    // ArduPilot's log analyser (TestVCC) warns when it moves by more than 0.3 V.
    if (swing > 0.3) add({ id: "power.vcc.swing", severity: "warn", title: `Board voltage varied by ${fmt(swing, 2)} V`, detail: `From ${fmt(lo.v, 2)} to ${fmt(hi.v, 2)} V while armed. A steady supply moves by about 0.1–0.15 V; ArduPilot's log analyser warns above 0.3 V. A weak power module, or servos loading the board's rail, cause this.`, at: lo.t, chart: "power", source: SOURCES.logs });
    let flags = 0;
    for (const i of use) flags |= p.flags[i];
    if (flags & (8 | 16)) add({ id: "power.overcurrent", severity: "fail", title: "Peripheral power over-current", detail: "The board reported its peripheral (5 V to accessories) supply drawing too much current.", advice: "Disconnect accessories one at a time to find the one drawing too much; power them separately.", chart: "power" });
    return `${fmt(lo.v, 2)}–${fmt(hi.v, 2)} V while armed`;
  });

/** Main-loop load, slow loops, dropped log data. */
const processor: CheckFn = (c) =>
  run(c, "cpu", "Processor", "Processor keeping up", (add) => {
    const L = c.f.load;
    const notes: string[] = [];
    if (L && L.load.some((v) => v > 0)) {
      const idx = within(L.t, c.armed);
      const use = idx.length ? idx : Array.from({ length: L.t.length }, (_, i) => i);
      const top = maxAt(L.t, L.load, use);
      notes.push(`load up to ${fmt(top.v, 0)}%`);
      if (top.v > 90) add({ id: "cpu.load", severity: "warn", title: `Processor load reached ${fmt(top.v, 0)}%`, detail: "Near full load the main loop can run late, which degrades control.", advice: "Turn off features you do not use, lower SCHED_LOOP_RATE, or log less (LOG_BITMASK).", at: top.t, chart: "load" });
    }
    if (L) {
      const idx = within(L.t, c.armed);
      const use = idx.length ? idx : Array.from({ length: L.t.length }, (_, i) => i);
      // ArduPilot's log analyser (TestPerformance): a reporting period with more than 6% of its loops late warns; more than 10%, or more than six such periods, fails.
      let worstShare = 0;
      let worstAt = NaN;
      let lateRows = 0;
      for (const i of use) {
        if (!(L.loops[i] > 0) || !Number.isFinite(L.slow[i])) continue;
        const share = (L.slow[i] / L.loops[i]) * 100;
        if (share > 6) lateRows++;
        if (share > worstShare) {
          worstShare = share;
          worstAt = L.t[i];
        }
      }
      if (use.some((i) => L.loops[i] > 0)) {
        notes.push(`at worst ${fmt(worstShare, 1)}% of loops late`);
        if (worstShare > 10 || lateRows > 6) add({ id: "cpu.slow", severity: "fail", title: `Main loops ran late: up to ${fmt(worstShare, 0)}% of them`, detail: `${lateRows} reporting period${lateRows === 1 ? "" : "s"} had more than 6% of loops late. Late loops make control less precise.`, advice: "Turn off features you do not use, log less (LOG_BITMASK), or lower SCHED_LOOP_RATE; a slow SD card can also cause it.", at: worstAt, chart: "load", source: SOURCES.logs });
        else if (worstShare > 6) add({ id: "cpu.slow", severity: "warn", title: `Up to ${fmt(worstShare, 0)}% of main loops ran late`, detail: "ArduPilot's log analyser warns above 6% in a reporting period.", at: worstAt, chart: "load", source: SOURCES.logs });
      }
    }
    for (const it of c.f.timeline) if (it.kind === "error" && Math.floor(it.code / 1000) === 19 && it.code % 1000 > 0) add({ id: "cpu.watchdog", severity: "fail", title: "CPU load watchdog triggered", detail: `At ${clock(it.t)} the main loop fell behind badly.`, at: it.t });
    const dsf = c.f.raw.tables.get("DSF");
    if (dsf) {
      const i = dsf.fields.indexOf("Dp");
      const dp = i >= 0 ? (dsf.cols[i] as Float32Array) : null;
      if (dp && dp.length) {
        const dropped = dp[dp.length - 1];
        // Dp counts since boot in 4.x.
        if (dropped > 0) add({ id: "log.dropped", severity: dropped > 100 ? "warn" : "info", title: `${dropped.toLocaleString()} log messages were dropped`, detail: "The autopilot produced data faster than the SD card took it, so the log has small gaps.", advice: "Use a faster SD card (class 10 / U1 or better) or log less." });
        notes.push(`${dropped} log messages dropped`);
      }
    }
    if (!notes.length) return { skip: "no processor statistics in this log" };
    return notes.join("; ");
  });

/** Failsafes, error codes, modes changed by the autopilot itself. */
const failsafes: CheckFn = (c) =>
  run(c, "failsafes", "Failsafes", "No failsafes or errors", (add) => {
    const f = c.f;
    const seen = new Set<number>();
    const handled = new Set([3, 11, 12, 16, 17, 19, 24, 25]);
    let n = 0;
    for (const it of f.timeline) {
      if (it.kind !== "error") continue;
      const sub = Math.floor(it.code / 1000);
      const code = it.code % 1000;
      if (handled.has(sub)) continue;
      const m = errMeaning(sub, code);
      if (m.tone === "ok" || m.tone === "note") continue;
      n++;
      if (seen.has(it.code)) continue;
      seen.add(it.code);
      add({ id: `err.${it.code}`, severity: m.tone === "bad" ? "fail" : "warn", title: m.text, detail: `At ${clock(it.t)}${countOf(f, it.code) > 1 ? `, ${countOf(f, it.code)} times in all` : ""}.`, advice: adviceFor(sub), at: it.t, source: sub === 5 ? SOURCES.radio : sub === 6 ? SOURCES.battery : SOURCES.logs });
    }
    for (const m of f.modes) {
      if (m.reason === null || !FAILSAFE_REASONS.has(m.reason)) continue;
      add({ id: `mode.failsafe.${m.t}`, severity: "fail", title: `Switched to ${m.name} by ${MODE_REASON[m.reason]}`, detail: `At ${clock(m.t)} the autopilot changed mode itself because of a failsafe.`, at: m.t, source: m.reason === 3 ? SOURCES.radio : m.reason === 4 ? SOURCES.battery : m.reason === 6 ? SOURCES.ekf : SOURCES.logs });
    }
    // In a .tlog there are no ERR codes: failsafe announcements come as messages.
    if (f.kind === "tlog") {
      // "PreArm: …" lines are pre-arm checks refusing to arm, not failsafes in flight. One finding per text.
      for (const it of f.timeline) {
        if (it.kind === "message" && /failsafe/i.test(it.text) && !/cleared|resolved|\boff\b|disabled|^PreArm/i.test(it.text)) add({ id: `msg.failsafe.${it.text}`, severity: "fail", title: `Autopilot reported: “${it.text}”`, detail: `At ${clock(it.t)}.`, at: it.t });
      }
    }
    for (const it of f.timeline) if (it.kind === "event" && it.code === 54) add({ id: `ev.estop.${it.t}`, severity: "warn", title: "Motors emergency-stopped", detail: `At ${clock(it.t)} the emergency stop switch was used.`, at: it.t });
    return n ? `${n} error report${n === 1 ? "" : "s"}` : "none reported";
  });

function countOf(f: Flight, code: number) {
  let n = 0;
  for (const it of f.timeline) if (it.kind === "error" && it.code === code) n++;
  return n;
}

function adviceFor(sub: number): string | undefined {
  switch (sub) {
    case 2:
    case 5:
      return "Check the receiver's power and wiring, antenna placement, and the range of the radio link.";
    case 6:
      return "The battery reached a failsafe threshold: land sooner, or use a larger battery.";
    case 8:
      return "The ground station link timed out; check telemetry radio range and antennas.";
    case 9:
      return "The aircraft crossed the geofence; check the fence and the mission stay inside it.";
    case 10:
      return "That mode needs a good position estimate: wait for GPS lock before switching to it.";
    case 18:
      return "Cover the barometer with open-cell foam out of prop wash and light.";
    case 29:
      return "High vibration made the autopilot switch to vibration-resistant altitude control; fix the vibration.";
    case 31:
      return "The position estimate was dead-reckoning without GPS for too long.";
    default:
      return undefined;
  }
}

/** Altitude held as asked. */
const altitude: CheckFn = (c) =>
  run(c, "control.altitude", "Control", "Altitude follows the target", (add) => {
    const ct = c.f.ctl;
    if (!ct || !ct.altTarget.some(Number.isFinite)) return { skip: c.f.kind === "tlog" ? "telemetry does not include the altitude target" : "no altitude target in this log" };
    const holdModes = new Set([2, 3, 4, 5, 6, 7, 9, 16, 17, 21, 23, 24, 27]);
    const modeAt = (t: number) => {
      let m = NaN;
      for (const x of c.f.modes) if (x.t <= t) m = x.mode;
      return m;
    };
    const idx = within(ct.t, c.settled).filter((i) => holdModes.has(modeAt(ct.t[i])) && Number.isFinite(ct.altTarget[i]) && Number.isFinite(ct.alt[i]));
    if (idx.length < 10) return { skip: "not enough time in altitude-holding modes" };
    const err = idx.map((i) => Math.abs(ct.altTarget[i] - ct.alt[i]));
    const p95 = quantile(err, 0.95);
    const run2 = longestRun(ct.t, idx, (i) => Math.abs(ct.altTarget[i] - ct.alt[i]) > 3, 0.5);
    if (run2.secs >= 3) add({ id: "control.altitude.off", severity: "warn", title: `Altitude was more than 3 m from the target for ${fmt(run2.secs)} s`, detail: `From ${clock(run2.from)}. Running out of thrust, high vibration, or a disturbed barometer cause this.`, at: run2.from, span: [run2.from, run2.to], chart: "altitude", source: SOURCES.logs });
    return `95% of the time within ${fmt(p95, 2)} m of the target`;
  });

/** Settings that leave the aircraft unprotected, read at the end of the log. */
const setup: CheckFn = (c) =>
  run(c, "setup", "Setup", "Safety settings", (add) => {
    const f = c.f;
    const p = (n: string) => f.params.get(n)?.last;
    if (!f.params.size) return { skip: "no parameters in this log" };
    if (f.params.size < 100 && f.kind === "tlog") return { skip: "the telemetry holds only some parameters; open the .bin for the full set" };
    const notes: string[] = [];
    const skip = p("ARMING_SKIPCHK");
    const chk = p("ARMING_CHECK");
    if (skip !== undefined && skip !== 0) add({ id: "setup.arming", severity: "warn", title: "Some pre-arm checks are switched off", detail: `ARMING_SKIPCHK is ${skip}. The skipped checks are the ones that stop a take-off with a fault.`, advice: "Set ARMING_SKIPCHK to 0 and fix what the checks report.", source: SOURCES.arming });
    else if (skip === undefined && chk !== undefined && chk !== 1) add({ id: "setup.arming", severity: "warn", title: chk === 0 ? "Pre-arm checks are switched off" : "Some pre-arm checks are switched off", detail: `ARMING_CHECK is ${chk} (1 runs them all).`, advice: "Set ARMING_CHECK to 1 and fix what the checks report.", source: SOURCES.arming });
    if (p("FS_THR_ENABLE") === 0) add({ id: "setup.radiofs", severity: "warn", title: "Radio failsafe is off", detail: "FS_THR_ENABLE is 0: if the radio link is lost the aircraft will carry on with the last stick input.", advice: "Set FS_THR_ENABLE to 1 (RTL) and test it on the ground with props off.", source: SOURCES.radio });
    const mon = p("BATT_MONITOR");
    if (mon !== undefined && mon > 0) {
      const lowV = p("BATT_LOW_VOLT") ?? 0;
      const lowMah = p("BATT_LOW_MAH") ?? 0;
      const act = p("BATT_FS_LOW_ACT") ?? 0;
      if (act === 0) add({ id: "setup.battfs", severity: "warn", title: "Low battery does nothing", detail: `BATT_FS_LOW_ACT is 0, so reaching ${lowV ? `${lowV} V` : lowMah ? `${lowMah} mAh` : "the low threshold"} only warns.`, advice: "Set BATT_FS_LOW_ACT to 2 (RTL) or 1 (Land).", source: SOURCES.battery });
      else if (!lowV && !lowMah) add({ id: "setup.battfs", severity: "warn", title: "No low-battery threshold set", detail: "BATT_LOW_VOLT and BATT_LOW_MAH are both 0, so the low-battery failsafe can never trigger.", advice: "Set BATT_LOW_VOLT (about 3.5 V a cell for LiPo) or BATT_LOW_MAH.", source: SOURCES.battery });
    } else if (mon === 0) add({ id: "setup.nomonitor", severity: "info", title: "No battery monitor configured", detail: "BATT_MONITOR is 0: the autopilot cannot see the battery, so no battery failsafe.", source: SOURCES.battery });
    if (p("INS_HNTCH_ENABLE") === 0 && f.vehicle === "copter") add({ id: "setup.notch", severity: "info", title: "Harmonic notch filter is off", detail: "The notch filter removes motor-noise from the gyros and usually improves flight noticeably on any copter.", advice: "Set up the harmonic notch (throttle- or ESC-based) after a test hover.", source: SOURCES.notch });
    if (p("FENCE_ENABLE") === 0) notes.push("geofence off");
    const changedArmed = [...f.params.values()].filter((x) => x.changes.some((ch) => inSpans(c.armed, ch.t)) && !/^(STAT_|MOT_THST_HOVER$|INS_ACC.*OFFS|COMPASS_.*OFS|AHRS_TRIM|ATC_.*_FF$|EK3_.*|SIM_)/.test(x.name));
    if (changedArmed.length) add({ id: "setup.changed", severity: "info", title: `${changedArmed.length} setting${changedArmed.length === 1 ? "" : "s"} changed while armed`, detail: changedArmed.slice(0, 8).map((x) => `${x.name} ${x.value} → ${x.last}`).join(", ") + (changedArmed.length > 8 ? "…" : "") });
    return notes.length ? notes.join("; ") : "checked";
  });

/* ───────────── summary ───────────── */

function summarise(f: Flight, flying: Span[]): Summary {
  const flightTime = flying.reduce((s, x) => s + (x.to - x.from), 0);
  const armedTime = f.armed.reduce((s, x) => s + (x.to - x.from), 0);
  let distance: number | null = null;
  let maxFromHome: number | null = null;
  let maxAltRel: number | null = null;
  if (f.pos) {
    const idx = within(f.pos.t, flying);
    if (idx.length) {
      distance = 0;
      for (let k = 1; k < idx.length; k++) {
        const a = idx[k - 1];
        const b = idx[k];
        const d = haversine(f.pos.lat[a], f.pos.lng[a], f.pos.lat[b], f.pos.lng[b]);
        // Steps longer than 50 m between samples are jumps (a reset or glitch), not distance flown.
        if (d < 50) distance += d;
      }
      const top = maxAt(f.pos.t, f.pos.rel, idx);
      maxAltRel = Number.isFinite(top.v) ? top.v : null;
      if (f.home) {
        let m = 0;
        for (const i of idx) m = Math.max(m, haversine(f.home.lat, f.home.lng, f.pos.lat[i], f.pos.lng[i]));
        maxFromHome = m;
      }
    }
  }
  let maxSpeed: number | null = null;
  const g = f.gps[0];
  if (g) {
    const idx = within(g.t, flying).filter((i) => g.status[i] >= 3);
    if (idx.length) maxSpeed = maxAt(g.t, g.speed, idx).v;
  }
  const b = f.bat[0];
  let usedMah: number | null = null;
  let minVolt: number | null = null;
  if (b) {
    for (let i = b.used.length - 1; i >= 0; i--) {
      if (Number.isFinite(b.used[i])) {
        usedMah = b.used[i];
        break;
      }
    }
    const idx = within(b.t, flying);
    const m = minAt(b.t, b.volt, idx.length ? idx : Array.from({ length: b.t.length }, (_, i) => i));
    minVolt = Number.isFinite(m.v) ? m.v : null;
  }
  const modeTime = new Map<string, number>();
  for (let k = 0; k < f.modes.length; k++) {
    const from = f.modes[k].t;
    const to = k + 1 < f.modes.length ? f.modes[k + 1].t : f.duration;
    // Time in each mode while flying.
    let s = 0;
    for (const sp of flying) s += Math.max(0, Math.min(to, sp.to) - Math.max(from, sp.from));
    if (s > 0) modeTime.set(f.modes[k].name, (modeTime.get(f.modes[k].name) ?? 0) + s);
  }
  return {
    vehicle: f.vehicle,
    firmware: f.firmware,
    startUtc: f.startUtc,
    logDuration: f.duration,
    armedTime,
    flightTime,
    flights: flying.length,
    distance,
    maxAltRel,
    maxSpeed: maxSpeed !== null && Number.isFinite(maxSpeed) ? maxSpeed : null,
    maxFromHome,
    usedMah: usedMah !== null && usedMah > 0 ? usedMah : null,
    minVolt,
    cells: cellCount(f)?.cells ?? null,
    modes: [...modeTime].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds),
  };
}

/* ───────────── entry ───────────── */

const CHECKS: CheckFn[] = [integrity, logEnd, crash, tracking, motors, vibration, compass, gpsCheck, ekfCheck, battery, boardPower, processor, failsafes, altitude, setup];

const RANK: Record<Severity, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

export function analyze(f: Flight): Analysis {
  const c: Ctx = { f, flying: f.flying, settled: settled(f), armed: f.armed, findings: [], checks: [] };
  for (const check of CHECKS) check(c);
  // One finding per id: the first (earliest) wins.
  const seen = new Set<string>();
  const findings = c.findings.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.at ?? Infinity) - (b.at ?? Infinity));
  const verdict = findings.some((x) => x.severity === "fail") ? "fail" : findings.some((x) => x.severity === "warn") ? "warn" : "pass";
  return { summary: summarise(f, f.flying), findings, checks: c.checks, verdict };
}
