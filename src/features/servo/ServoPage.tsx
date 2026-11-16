/*
  Servo Outputs: what each output pin of the flight controller does, set up
  by task rather than by parameter number. Choose an output on the drawing of
  the board, say what is plugged into it (a payload release, a channel from
  the transmitter, something a mission moves, a camera…), set its range, and
  test it. Every change is held until saved, every save is confirmed by the
  aircraft, and the checks say before saving what ArduPilot would do with it.
*/
import { CircleAlert, CircleCheck, Info, Lock, Package, Power, Radio, RotateCcw, Save, Send, SlidersHorizontal, TriangleAlert, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ConnectPrompt } from "../../components/ui/ConnectPrompt";
import { commandLink } from "../../services/link/commandLink";
import { gripper, saveChanges, testOutput } from "../../servo/actions";
import {
  boardFor,
  channelUse,
  checkOutputs,
  FUNCTIONS,
  functionInfo,
  motorOf,
  movedChannel,
  needsRestart,
  passThroughFunction,
  rcOf,
  readOutputs,
  SWITCH_OPTIONS,
  testable,
  type Issue,
  type Output,
  type Params,
} from "../../servo/model";
import { useLink } from "../../state/linkStore";
import { confirmAction, notify } from "../../state/notifyStore";
import { useParams } from "../../state/paramStore";
import { useActiveProfile } from "../../state/profileStore";
import { useRebootNeeded } from "../params/rebootStore";
import { useParamMeta } from "../params/useParamMeta";
import { BoardDiagram } from "./BoardDiagram";
import { CATEGORY_LABEL, categoryOf } from "./labels";
import "./servo.css";

const PROTOCOL: Record<number, string> = { 1: "OneShot", 2: "OneShot125", 3: "Brushed", 4: "DShot150", 5: "DShot300", 6: "DShot600", 7: "DShot1200" };
const GRIP_DEFAULTS = { GRIP_GRAB: 1900, GRIP_RELEASE: 1100, GRIP_NEUTRAL: 1500 };

/** A stock quad on a Pixhawk 2.4.8, shown before anything is connected. */
function previewParams(): Params {
  const p: Params = { FRAME_CLASS: 1, RC_SPEED: 490, SERVO_RATE: 50, MOT_PWM_TYPE: 0 };
  for (let n = 1; n <= 14; n++) Object.assign(p, { [`SERVO${n}_FUNCTION`]: n <= 4 ? 32 + n : 0, [`SERVO${n}_MIN`]: 1100, [`SERVO${n}_TRIM`]: 1500, [`SERVO${n}_MAX`]: 1900, [`SERVO${n}_REVERSED`]: 0 });
  return p;
}

export function ServoPage() {
  const status = useLink((s) => s.status);
  const virtual = useLink((s) => s.virtual);
  const vehicle = useLink((s) => s.vehicle);
  const servoTele = useLink((s) => s.telemetry.servo);
  const rcTele = useLink((s) => s.telemetry.rc);
  const autopilot = useLink((s) => s.telemetry.autopilot);
  const values = useParams((s) => s.values);
  const list = useParams((s) => s.list);
  const profile = useActiveProfile();
  const { meta } = useParamMeta();
  const restartNames = useRebootNeeded((s) => s.names);

  const linked = (status === "connected" || status === "stale") && !!vehicle;
  const ready = linked && values.SERVO1_FUNCTION !== undefined;

  useEffect(() => {
    if (linked) void commandLink.ensureParamList();
  }, [linked]);

  const board = boardFor(autopilot?.value.boardId ?? (virtual ? 9 : null), profile?.board ?? null);
  const shownBoard = ready ? board : boardFor(null, "pixhawk-2.4.8");
  const [edits, setEdits] = useState<Params>({});
  const preview = useMemo(() => previewParams(), []);
  const base = ready ? values : preview;
  const merged = useMemo(() => ({ ...base, ...edits }), [base, edits]);
  const outputs = useMemo(() => readOutputs(merged, shownBoard.layout), [merged, shownBoard.layout]);
  const issues = useMemo(() => (ready ? checkOutputs(merged, shownBoard.layout, { mavType: vehicle?.type, rcChannels: rcTele?.value.count }) : []), [ready, merged, shownBoard.layout, vehicle?.type, rcTele?.value.count]);
  const flagged = useMemo(() => new Set(issues.filter((i) => i.level !== "info" && i.servo).map((i) => i.servo!)), [issues]);
  const firmwareNames = meta?.params.SERVO1_FUNCTION?.v;

  // Start on the first output a payload would go on: the first that is not a motor (AUX OUT 1 on a stock Pixhawk quad).
  const [selected, setSelected] = useState<number | null>(null);
  const sel = outputs.find((o) => o.servo === selected) ?? outputs.find((o) => motorOf(o.fn) === null && (!shownBoard.layout?.io || o.servo > 8)) ?? outputs[0] ?? null;

  // Cleared with the rest of the telemetry when the link closes.
  const pwm = servoTele?.value.pwm ?? [];
  const rates = (g: number[]) => {
    const motorsIn = g.some((s) => motorOf(merged[`SERVO${s}_FUNCTION`] ?? 0) !== null);
    if (!motorsIn) return `${merged.SERVO_RATE ?? 50} Hz`;
    const proto = PROTOCOL[merged.MOT_PWM_TYPE ?? 0];
    return proto ? `${proto} with motors` : `${merged.RC_SPEED ?? 490} Hz with motors`;
  };

  const set = (changes: Params) =>
    setEdits((e) => {
      const n = { ...e, ...changes };
      // An edit back to the saved value is no edit.
      for (const k of Object.keys(changes)) if (values[k] !== undefined && values[k] === n[k]) delete n[k];
      return n;
    });
  const count = Object.keys(edits).length;
  const [saving, setSaving] = useState<string | null>(null);

  const save = async () => {
    if (!count) return;
    const bad = Object.entries(edits).filter(([, v]) => !Number.isFinite(v));
    if (bad.length) return notify("error", "Not saved", `${bad.map(([k]) => k).join(", ")} is not a number.`);
    const danger = issues.filter((i) => i.level === "danger");
    if (danger.length) {
      const ok = await confirmAction({
        title: "Save with a problem?",
        body: `${danger.map((d) => d.title).join(". ")}. Saving anyway writes the settings as they are.`,
        confirmLabel: "Save anyway",
        tone: "danger",
      });
      if (!ok) return;
    }
    const armed = !!vehicle?.armed;
    if (armed) {
      const ok = await confirmAction({
        title: "Save to an armed aircraft?",
        body: "The aircraft is armed. Output changes take effect as they are written, in flight too: a motor's output changed now stops that motor. Save only if you are ready to take over on the radio.",
        confirmLabel: "Save while armed",
        tone: "danger",
      });
      if (!ok) return;
    }
    const before = { ...values };
    try {
      setSaving("Writing…");
      const written = await saveChanges(edits, armed, setSaving);
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !written.includes(k))));
      const restart = needsRestart(Object.fromEntries(written.map((k) => [k, edits[k]])), before);
      notify("success", `${written.length} ${written.length === 1 ? "setting" : "settings"} saved`, restart.length ? "Restart the flight controller for the output changes to take full effect." : undefined);
    } catch (e) {
      notify("error", "Not all saved", (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const restart = async () => {
    if (vehicle?.armed) return notify("error", "Disarm first", "The flight controller cannot be restarted while armed.");
    const ok = await confirmAction({
      title: "Restart the flight controller?",
      body: virtual
        ? "The virtual aircraft re-reads its start-up settings (the gripper) and stays connected."
        : "It restarts and the link drops for a few seconds. Over USB the port closes: press Connect again once it is back. Keep the propellers off.",
      confirmLabel: "Restart",
    });
    if (!ok) return;
    await commandLink.reboot();
    useRebootNeeded.getState().clear();
    notify("info", virtual ? "Restarted" : "Restarting", virtual ? undefined : "Connect again when the flight controller is back.");
  };
  const ourRestart = restartNames.filter((n) => /^SERVO\d+_FUNCTION$|^GRIP_(ENABLE|TYPE)$|^MOT_PWM_TYPE$/.test(n));

  return (
    <div className="page-pad sv">
      <header className="page-head">
        <div>
          <h1>Servo Outputs</h1>
          <p>Choose what each output pin on the flight controller does: drive a motor, release a payload, follow a switch on your transmitter, or move when a mission says. Test each one here. AERONEX checks the setup the way ArduPilot will use it.</p>
        </div>
      </header>

      {!linked && (
        <ConnectPrompt
          title="Connect the flight controller to set up its outputs"
          items={[
            { icon: Package, title: "Payload release", detail: "Set up a gripper or drop servo, test it, and put it on a transmitter switch." },
            { icon: Radio, title: "Transmitter channels", detail: "Make any output follow any channel of your transmitter." },
            { icon: SlidersHorizontal, title: "Live outputs", detail: "See the pulse on every pin as the aircraft sends it." },
          ]}
        >
          Below is a stock quadcopter on a Pixhawk 2.4.8, to show where things go.
        </ConnectPrompt>
      )}
      {linked && !ready && (
        <div className="callout info" role="status">
          <Info size={16} />
          <span>Reading the outputs' settings from the flight controller{list === "downloading" ? "…" : ". If this does not finish, open Parameters and press Refresh."}</span>
        </div>
      )}

      {linked && vehicle?.firmware !== "ardupilot" && (
        <div className="callout warn">
          <TriangleAlert size={16} />
          <span>This page sets up ArduPilot's outputs. The linked flight controller reports {vehicle?.firmwareLabel}.</span>
        </div>
      )}

      {ourRestart.length > 0 && (
        <div className="callout warn sv-restart">
          <Power size={16} />
          <span>
            <strong>Restart to apply.</strong> {ourRestart.join(", ")} {ourRestart.length === 1 ? "takes" : "take"} full effect only after the flight controller restarts{ourRestart.some((n) => n.startsWith("GRIP")) ? ": the gripper does not move at all until then" : ""}.
          </span>
          <button className="btn btn-sm" disabled={!linked || !!vehicle?.armed || count > 0} title={count > 0 ? "Save or discard the changes first" : undefined} onClick={() => void restart()}>
            Restart now
          </button>
        </div>
      )}

      {count > 0 && (
        <div className="pid-actionbar sv-savebar" role="region" aria-label="Unsaved changes">
          <span className="pid-count">
            <strong>
              {count} unsaved {count === 1 ? "change" : "changes"}
            </strong>{" "}
            · {Object.keys(edits).slice(0, 6).join(", ")}
            {count > 6 ? "…" : ""}
          </span>
          <div className="pid-actionbar-btns">
            <button className="btn btn-ghost" disabled={!!saving} onClick={() => setEdits({})}>
              <RotateCcw size={15} /> Discard
            </button>
            <button className="btn btn-primary" disabled={!!saving || !ready} onClick={() => void save()}>
              <Save size={15} /> {saving ?? "Save to flight controller"}
            </button>
          </div>
        </div>
      )}

      <section className="panel sv-board-panel">
        <div className="panel-head">
          <h3>{shownBoard.pixhawk1 ? "Pixhawk 2.4.8" : board.boardId !== null ? `Board id ${board.boardId}` : "Outputs"}</h3>
          <span className="sv-board-src">
            {!ready
              ? "Preview"
              : board.source === "board-id"
                ? "Identified from the board"
                : board.source === "likely"
                  ? virtual
                    ? "Virtual aircraft, laid out like a Pixhawk 2.4.8"
                    : "Pixhawk 1 class, from the board id"
                  : board.source === "profile"
                    ? "From the aircraft profile"
                    : "Board not identified: outputs in ArduPilot's order"}
          </span>
        </div>
        <div className="sv-board-wrap">
          <BoardDiagram outputs={outputs} pwm={pwm} pixhawk1={shownBoard.pixhawk1} rateText={rates} selected={sel?.servo ?? null} onSelect={setSelected} flagged={flagged} firmwareNames={firmwareNames} />
        </div>
        <div className="sv-legend" aria-label="Legend">
          {(["motor", "payload", "rc", "off", "camera", "other"] as const).map((c) => (
            <span key={c} className={`sv-key sv-cat-${c}`}>
              <i /> {CATEGORY_LABEL[c]}
            </span>
          ))}
          <span className="sv-key-bracket">
            <i /> Outputs sharing one rate; blue when shared with motors
          </span>
          <span className="sv-note">
            <CircleAlert size={13} /> The + pins are not powered by the Pixhawk. Feed 5–6 V into the rail from a BEC or an ESC's BEC to run servos, and never more than the servos are rated for.
          </span>
        </div>
      </section>

      <div className="sv-layout">
        <OutputsList outputs={outputs} pwm={pwm} selected={sel?.servo ?? null} onSelect={setSelected} flagged={flagged} edits={edits} names={firmwareNames} />
        {sel && <Editor key={sel.servo} o={sel} merged={merged} saved={values} edits={edits} set={set} ready={ready} pwm={pwm[sel.servo - 1]} names={firmwareNames} issues={issues.filter((i) => i.servo === sel.servo)} armed={!!vehicle?.armed} rcCount={rcTele?.value.count ?? 0} />}
      </div>

      {ready && <Switches merged={merged} saved={values} set={set} />}
      {ready && <Checks issues={issues} onSelect={setSelected} onFix={set} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OutputsList({ outputs, pwm, selected, onSelect, flagged, edits, names }: { outputs: Output[]; pwm: number[]; selected: number | null; onSelect: (n: number) => void; flagged: Set<number>; edits: Params; names?: [number, string][] }) {
  return (
    <section className="panel sv-list" aria-label="Outputs">
      <div className="panel-head">
        <h3>Outputs</h3>
      </div>
      <ul>
        {outputs.map((o) => {
          const changed = Object.keys(edits).some((k) => k.startsWith(`SERVO${o.servo}_`));
          return (
            <li key={o.servo}>
              <button className={`sv-row ${selected === o.servo ? "on" : ""}`} onClick={() => onSelect(o.servo)} aria-pressed={selected === o.servo}>
                <span className={`sv-dot sv-cat-${categoryOf(o.fn)}`} aria-hidden />
                <span className="sv-row-port">{o.port.short}</span>
                <span className="sv-row-fn">
                  {functionInfo(o.fn, names).label}
                  {changed && <em className="pid-mod">unsaved</em>}
                </span>
                <span className="sv-row-pwm num">{pwm[o.servo - 1] ? `${pwm[o.servo - 1]}` : "—"}</span>
                {flagged.has(o.servo) && <TriangleAlert size={14} className="sv-row-flag" aria-label="Has a warning" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */

type Kind = "none" | "payload" | "rc" | "other";

function kindOf(fn: number): Kind {
  if (fn === 0) return "none";
  if (fn === 28) return "payload";
  if (fn === 1 || (fn >= 51 && fn <= 66) || (fn >= 140 && fn <= 155)) return "rc";
  return "other";
}

interface EditorProps {
  o: Output;
  merged: Params;
  saved: Params;
  edits: Params;
  set: (c: Params) => void;
  ready: boolean;
  pwm: number | undefined;
  names?: [number, string][];
  issues: Issue[];
  armed: boolean;
  rcCount: number;
}

function Editor(props: EditorProps) {
  const { o, merged, saved, set, ready, pwm, names, issues } = props;
  const n = o.servo;
  const motor = motorOf(o.fn);
  const savedFn = saved[`SERVO${n}_FUNCTION`];
  const [unlock, setUnlock] = useState(false);
  const locked = motor !== null && !unlock;
  const kind = kindOf(o.fn);
  const info = functionInfo(o.fn, names);
  const rc = rcOf(o.fn, n);

  const choose = (k: Kind) => {
    if (k === kind) return;
    if (k === "none") set({ [`SERVO${n}_FUNCTION`]: 0 });
    if (k === "payload")
      set({
        [`SERVO${n}_FUNCTION`]: 28,
        GRIP_ENABLE: 1,
        GRIP_TYPE: 1,
        GRIP_GRAB: merged.GRIP_GRAB ?? GRIP_DEFAULTS.GRIP_GRAB,
        GRIP_RELEASE: merged.GRIP_RELEASE ?? GRIP_DEFAULTS.GRIP_RELEASE,
        GRIP_NEUTRAL: merged.GRIP_NEUTRAL ?? GRIP_DEFAULTS.GRIP_NEUTRAL,
      });
    if (k === "rc") set({ [`SERVO${n}_FUNCTION`]: passThroughFunction(firstSpare(merged), false) });
    if (k === "other") set({ [`SERVO${n}_FUNCTION`]: 10 });
  };

  return (
    <section className="panel sv-editor" aria-label={`${o.port.long} settings`}>
      <div className="panel-head sv-editor-head">
        <div>
          <h3>
            {o.port.long} <span className="muted">SERVO{n}</span>
          </h3>
          <p className="sv-editor-now">
            <span className={`sv-dot sv-cat-${categoryOf(o.fn)}`} aria-hidden /> {info.label}
          </p>
        </div>
        <Pulse pwm={pwm} min={o.min} max={o.max} />
      </div>
      <div className="panel-body">
        {issues.filter((i) => i.level !== "info").map((i) => (
          <div key={i.id} className={`callout ${i.level === "danger" ? "danger" : "warn"} sv-issue`}>
            <TriangleAlert size={16} />
            <span>
              <strong>{i.title}.</strong> {i.detail}
            </span>
          </div>
        ))}

        {locked ? (
          <div className="sv-locked">
            <Lock size={16} />
            <div>
              <strong>This output drives Motor {motor}.</strong> Its ESC is plugged in here. Changing it stops that motor, so change it only if the ESC is on another output. Test the motors on the Calibration page.
              <div className="sv-locked-actions">
                <Link className="btn btn-sm" to="/calibration">
                  Motor test
                </Link>
                <button className="btn btn-sm btn-ghost" onClick={() => setUnlock(true)}>
                  Change this output
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="sv-kinds">
              <legend>What is plugged in here?</legend>
              <KindCard k="payload" kind={kind} choose={choose} title="Payload release" text="A gripper or drop servo: release from a switch, a button or a mission." icon={<Package size={18} />} />
              <KindCard k="rc" kind={kind} choose={choose} title="A transmitter channel" text="The output follows a switch or knob on your transmitter." icon={<Radio size={18} />} />
              <KindCard k="none" kind={kind} choose={choose} title="Mission or button" text="Moves only when a mission or a button here sends it a position. Also the setting for nothing plugged in." icon={<Send size={18} />} />
              <KindCard k="other" kind={kind} choose={choose} title="Something else" text="Camera shutter, gimbal, landing gear, parachute, a motor, or any ArduPilot function." icon={<Wand2 size={18} />} />
            </fieldset>

            {kind === "payload" && <PayloadSetup {...props} />}
            {kind === "rc" && rc && <RcSetup {...props} rc={rc} />}
            {kind === "other" && <OtherSetup {...props} />}
            {kind === "none" && <p className="sv-what">{functionInfo(0).what} AERONEX's mission planner does not add servo steps yet; missions made in Mission Planner or QGroundControl can (DO_SET_SERVO).</p>}

            {motor === null && !(rc && !rc.scaled) && kind !== "payload" && o.fn !== -1 && <Range {...props} />}
            {rc && !rc.scaled && <p className="sv-what">An exact pass-through copies the transmitter's pulse; this output's lowest, centre, highest and reverse settings do nothing. Choose “scaled” to use them.</p>}
          </>
        )}

        {motor === null && o.fn !== -1 && <Test o={o} savedFn={savedFn} ready={ready} edits={props.edits} armed={props.armed} />}
      </div>
    </section>
  );
}

/** The lowest channel that neither flies the aircraft nor has a switch option: usually 6. */
function firstSpare(p: Params): number {
  for (let c = 6; c <= 16; c++) if (!channelUse(p, c) && !p[`RC${c}_OPTION`]) return c;
  return 6;
}

function KindCard({ k, kind, choose, title, text, icon }: { k: Kind; kind: Kind; choose: (k: Kind) => void; title: string; text: string; icon: React.ReactNode }) {
  return (
    <label className={`sv-kind ${kind === k ? "on" : ""}`}>
      <input type="radio" name="sv-kind" checked={kind === k} onChange={() => choose(k)} />
      <span className="sv-kind-icon" aria-hidden>
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </label>
  );
}

function Pulse({ pwm, min, max }: { pwm: number | undefined; min: number; max: number }) {
  const lo = Math.min(800, min);
  const hi = Math.max(2200, max);
  const pct = pwm ? ((pwm - lo) / (hi - lo)) * 100 : 0;
  return (
    <div className="sv-pulse" aria-label={pwm ? `Output now ${pwm} microseconds` : "No pulses"}>
      <span className="num">{pwm ? `${pwm} µs` : pwm === 0 ? "No pulses" : "—"}</span>
      <span className="sv-pulse-bar">
        <i className="sv-pulse-range" style={{ left: `${((min - lo) / (hi - lo)) * 100}%`, width: `${((max - min) / (hi - lo)) * 100}%` }} />
        {pwm ? <i className="sv-pulse-now" style={{ left: `${Math.max(0, Math.min(100, pct))}%` }} /> : null}
      </span>
    </div>
  );
}

function NumberField({ label, value, onChange, min = 500, max = 2500, unit = "µs", hint }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; unit?: string; hint?: string }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : String(value);
  return (
    <label className="sv-field">
      <span>{label}</span>
      <span className="sv-field-input">
        <input
          className="input num"
          inputMode="numeric"
          value={shown}
          onFocus={() => {
            setText(String(value));
            setFocused(true);
          }}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onChange(Math.round(v));
          }}
        />
        <em>{unit}</em>
      </span>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Range({ o, set }: EditorProps) {
  const n = o.servo;
  return (
    <div className="sv-range">
      <h4>Range</h4>
      <div className="sv-fields">
        <NumberField label="Lowest" value={o.min} min={500} max={2200} onChange={(v) => set({ [`SERVO${n}_MIN`]: v })} />
        <NumberField label="Centre" value={o.trim} min={500} max={2500} onChange={(v) => set({ [`SERVO${n}_TRIM`]: v })} />
        <NumberField label="Highest" value={o.max} min={800} max={2500} onChange={(v) => set({ [`SERVO${n}_MAX`]: v })} />
        <label className="sv-check">
          <input type="checkbox" checked={o.reversed} onChange={(e) => set({ [`SERVO${n}_REVERSED`]: e.target.checked ? 1 : 0 })} /> Reversed
        </label>
      </div>
    </div>
  );
}

/** Move the output to a pulse width now (DO_SET_SERVO). */
function Test({ o, savedFn, ready, edits, armed }: { o: Output; savedFn: number | undefined; ready: boolean; edits: Params; armed: boolean }) {
  const [v, setV] = useState(o.trim);
  const [busy, setBusy] = useState(false);
  const pendingFn = edits[`SERVO${o.servo}_FUNCTION`] !== undefined;
  const can = ready && savedFn !== undefined && testable(savedFn) && !pendingFn;
  const why = !ready
    ? "Connect to test."
    : pendingFn
      ? "Save the new function first: the flight controller tests what it has, not what is on screen."
      : savedFn !== undefined && !testable(savedFn)
        ? `ArduPilot moves an output only when nothing else drives it: set to Mission or button, Payload release or a transmitter channel. ${functionInfo(savedFn).label} drives this one itself.`
        : null;
  const send = async (pwm: number) => {
    if (armed) {
      const ok = await confirmAction({ title: "Move an output on an armed aircraft?", body: `${o.port.long} moves to ${pwm} µs now. If it releases a payload, it drops.`, confirmLabel: "Move it", tone: "danger" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await testOutput(o.servo, pwm);
    } catch (e) {
      notify("error", "Not moved", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sv-test">
      <h4>Test</h4>
      {why && <p className="sv-what">{why}</p>}
      <div className="sv-test-row">
        <input type="range" min={800} max={2200} step={10} value={v} disabled={!can} onChange={(e) => setV(Number(e.target.value))} aria-label="Test position" />
        <span className="num sv-test-v">{v} µs</span>
        <button className="btn btn-sm btn-primary" disabled={!can || busy} onClick={() => void send(v)}>
          Move to {v}
        </button>
      </div>
      <div className="sv-test-quick">
        {[
          ["Lowest", o.min],
          ["Centre", o.trim],
          ["Highest", o.max],
        ].map(([label, pwm]) => (
          <button key={label} className="btn btn-sm" disabled={!can || busy} onClick={() => void send(pwm as number)}>
            {label} <span className="num">{pwm}</span>
          </button>
        ))}
      </div>
      <p className="sv-hint">Moves stay until another command, a mission step or the transmitter moves the output. On a Pixhawk the safety switch must be solid red for anything to move.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PayloadSetup({ o, merged, saved, edits, set, ready, armed }: EditorProps) {
  const pos = { grab: merged.GRIP_GRAB ?? GRIP_DEFAULTS.GRIP_GRAB, release: merged.GRIP_RELEASE ?? GRIP_DEFAULTS.GRIP_RELEASE, neutral: merged.GRIP_NEUTRAL ?? GRIP_DEFAULTS.GRIP_NEUTRAL };
  const switchCh = Array.from({ length: 16 }, (_, i) => i + 1).find((c) => merged[`RC${c}_OPTION`] === 19) ?? null;
  const savedOk = saved[`SERVO${o.servo}_FUNCTION`] === 28 && saved.GRIP_ENABLE === 1 && saved.GRIP_TYPE === 1;
  const pending = ["GRIP_ENABLE", "GRIP_TYPE", "GRIP_GRAB", "GRIP_RELEASE", "GRIP_NEUTRAL", `SERVO${o.servo}_FUNCTION`].some((k) => edits[k] !== undefined);
  const restartWaiting = useRebootNeeded((s) => s.names.some((n) => n === "GRIP_ENABLE" || n === "GRIP_TYPE" || n === `SERVO${o.servo}_FUNCTION`));
  const [busy, setBusy] = useState(false);
  const act = async (a: "release" | "grab") => {
    if (armed) {
      const ok = await confirmAction({ title: a === "release" ? "Release the payload in flight?" : "Close the gripper?", body: a === "release" ? "The payload drops now. Make sure nothing and no one is below." : "The gripper closes now.", confirmLabel: a === "release" ? "Release" : "Close", tone: "danger" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await gripper(a, { servo: o.servo, pwm: a === "release" ? saved.GRIP_RELEASE : saved.GRIP_GRAB });
      notify("success", a === "release" ? "Released" : "Closed", `${o.port.long} is at ${a === "release" ? saved.GRIP_RELEASE : saved.GRIP_GRAB} µs.`);
    } catch (e) {
      notify("error", a === "release" ? "Not released" : "Not closed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sv-payload">
      <h4>Payload release</h4>
      <p className="sv-what">ArduPilot's gripper drives this output: it opens to release and closes to hold. Set each position with the test slider below, then type it here.</p>
      <div className="sv-fields">
        <NumberField label="Closed (holding)" value={pos.grab} min={1000} max={2000} onChange={(v) => set({ GRIP_GRAB: v })} hint="GRIP_GRAB" />
        <NumberField label="Open (released)" value={pos.release} min={1000} max={2000} onChange={(v) => set({ GRIP_RELEASE: v })} hint="GRIP_RELEASE" />
        <NumberField label="Resting" value={pos.neutral} min={1000} max={2000} onChange={(v) => set({ GRIP_NEUTRAL: v })} hint="GRIP_NEUTRAL" />
        <NumberField label="Close again after" value={merged.GRIP_AUTOCLOSE ?? 0} min={0} max={255} unit="s" onChange={(v) => set({ GRIP_AUTOCLOSE: v })} hint="0 = stays open" />
      </div>

      <div className="sv-sub">
        <h5>From the transmitter</h5>
        <ChannelPicker
          value={switchCh}
          merged={merged}
          allowFlying={false}
          onPick={(c) => {
            const changes: Params = {};
            if (switchCh !== null) changes[`RC${switchCh}_OPTION`] = 0;
            if (c !== null) changes[`RC${c}_OPTION`] = 19;
            set(changes);
          }}
          noneLabel="No switch"
        />
        <p className="sv-hint">Switch low opens it (releases the payload) and high closes it. The middle position changes nothing.</p>
      </div>

      <div className="sv-sub">
        <h5>From AERONEX</h5>
        <div className="sv-test-quick">
          <button className="btn btn-sm btn-primary" disabled={!ready || !savedOk || pending || busy} onClick={() => void act("release")}>
            Release payload
          </button>
          <button className="btn btn-sm" disabled={!ready || !savedOk || pending || busy} onClick={() => void act("grab")}>
            Close gripper
          </button>
        </div>
        <p className="sv-hint">
          {pending
            ? "Save first, then restart the flight controller: it starts the gripper only at start-up."
            : restartWaiting
              ? "Restart the flight controller before testing: until then ArduPilot accepts the command and nothing moves. AERONEX checks the output really moved."
              : "AERONEX checks the output reached the position, not only that the command was accepted."}
        </p>
      </div>
      <div className="sv-sub">
        <h5>In a mission</h5>
        <p className="sv-hint">A DO_GRIPPER step releases (0) or grabs (1) in AUTO. AERONEX's mission planner does not add payload steps yet; Mission Planner and QGroundControl can.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RcSetup({ o, merged, set, rc, rcCount }: EditorProps & { rc: { channel: number; scaled: boolean } }) {
  const n = o.servo;
  const live = useLink((s) => s.telemetry.rc?.value.channels[rc.channel - 1]);
  return (
    <div className="sv-rcsetup">
      <h4>Transmitter channel</h4>
      <ChannelPicker value={rc.channel} merged={merged} allowFlying onPick={(c) => c !== null && set({ [`SERVO${n}_FUNCTION`]: passThroughFunction(c, rc.scaled) })} />
      <label className="sv-check sv-scaled">
        <input type="checkbox" checked={rc.scaled} onChange={(e) => set({ [`SERVO${n}_FUNCTION`]: passThroughFunction(rc.channel, e.target.checked) })} /> Scaled: map the channel's range onto this output's lowest, centre and highest
      </label>
      <p className="sv-what">
        Channel {rc.channel} {live ? <>is at <strong className="num">{live} µs</strong></> : "is not being received"}
        {rcCount && rc.channel > rcCount ? ` (the receiver sends ${rcCount} channels)` : ""}. {rc.scaled ? functionInfo(passThroughFunction(rc.channel, true)).what : functionInfo(passThroughFunction(rc.channel, false)).what}
      </p>
    </div>
  );
}

/** Pick a transmitter channel, with what each already does and where it is now; or detect one by moving it. */
function ChannelPicker({ value, merged, onPick, allowFlying, noneLabel }: { value: number | null; merged: Params; onPick: (c: number | null) => void; allowFlying: boolean; noneLabel?: string }) {
  const channels = useLink((s) => s.telemetry.rc?.value.channels ?? []);
  const [detecting, setDetecting] = useState(false);
  // Read through refs: the page re-renders with every telemetry update, and the baseline must not move with it.
  const latest = useRef({ merged, onPick, allowFlying });
  useEffect(() => {
    latest.current = { merged, onPick, allowFlying };
  });
  useEffect(() => {
    if (!detecting) return;
    const base = useLink.getState().telemetry.rc?.value.channels ?? [];
    const end = Date.now() + 10000;
    const t = setInterval(() => {
      const now = useLink.getState().telemetry.rc?.value.channels ?? [];
      const { merged: m, onPick: pick, allowFlying: any } = latest.current;
      const c = movedChannel(base, now);
      if (c !== null && (any || !channelUse(m, c))) {
        pick(c);
        setDetecting(false);
        notify("success", `Channel ${c}`, "That is the switch you moved.");
      } else if (c !== null) {
        setDetecting(false);
        notify("warn", `Channel ${c} flies the aircraft`, `It is ${channelUse(m, c)}. Use a spare switch for a payload.`);
      } else if (Date.now() > end) {
        setDetecting(false);
        notify("warn", "No switch moved", "Nothing moved on the transmitter in 10 seconds. Is it on, and bound to the receiver?");
      }
    }, 150);
    return () => clearInterval(t);
  }, [detecting]);
  return (
    <div className="sv-picker">
      <select className="input" value={value ?? ""} onChange={(e) => onPick(e.target.value === "" ? null : Number(e.target.value))} aria-label="Transmitter channel">
        {noneLabel && <option value="">{noneLabel}</option>}
        {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => {
          const use = channelUse(merged, c);
          const opt = merged[`RC${c}_OPTION`];
          const optName = opt ? (SWITCH_OPTIONS.find((s) => s.value === opt)?.label ?? `option ${opt}`) : null;
          return (
            <option key={c} value={c} disabled={!allowFlying && !!use}>
              Channel {c}
              {use ? ` — ${use}` : optName && c !== value ? ` — ${optName}` : ""}
              {channels[c - 1] ? `  (${channels[c - 1]} µs)` : ""}
            </option>
          );
        })}
      </select>
      <button className={`btn btn-sm ${detecting ? "btn-primary" : ""}`} disabled={!channels.length} onClick={() => setDetecting((d) => !d)} title={channels.length ? undefined : "No transmitter channels are being received"}>
        {detecting ? "Flip the switch now…" : "Find it: flip the switch"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OtherSetup({ o, set, names, merged }: EditorProps) {
  const n = o.servo;
  const info = functionInfo(o.fn, names);
  const listed = new Set(FUNCTIONS.map((f) => f.value));
  const extra = (names ?? []).filter(([v]) => !listed.has(v));
  const groups: [string, number[]][] = [
    ["Payload and gear", [29, 27, 22, 23, 88]],
    ["Camera and gimbal", [10, 7, 8, 6]],
    ["Motors", [33, 34, 35, 36, 37, 38, 39, 40, 82, 83, 84, 85]],
    ["Fixed signals and pins", [134, 135, 136, 138, 120, -1]],
    ["Lua scripts", Array.from({ length: 16 }, (_, i) => 94 + i)],
  ];
  const needs: Record<number, string> = { 29: "LGR_ENABLE", 27: "CHUTE_ENABLED", 22: "SPRAY_ENABLE", 23: "SPRAY_ENABLE", 88: "WINCH_TYPE", 10: "CAM1_TYPE", 7: "MNT1_TYPE", 8: "MNT1_TYPE", 6: "MNT1_TYPE" };
  const need = needs[o.fn];
  return (
    <div className="sv-other">
      <label className="sv-field sv-field-wide">
        <span>Function</span>
        <select className="input" value={o.fn} onChange={(e) => set({ [`SERVO${n}_FUNCTION`]: Number(e.target.value) })}>
          {groups.map(([label, vals]) => (
            <optgroup key={label} label={label}>
              {vals.map((v) => (
                <option key={v} value={v}>
                  {functionInfo(v, names).label}
                </option>
              ))}
            </optgroup>
          ))}
          {extra.length > 0 && (
            <optgroup label="Other ArduPilot functions">
              {extra.map(([v, label]) => (
                <option key={v} value={v}>
                  {label} ({v})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <p className="sv-what">{info.what}</p>
      {need && merged[need] !== undefined && !merged[need] && (
        <p className="sv-hint">
          <CircleAlert size={13} /> {need} is 0 on this aircraft: set it on the Parameters page, or this output will not move.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Switches({ merged, saved, set }: { merged: Params; saved: Params; set: (c: Params) => void }) {
  const channels = useLink((s) => s.telemetry.rc?.value.channels ?? []);
  const known = new Map(SWITCH_OPTIONS.map((s) => [s.value, s]));
  const [ch, setCh] = useState<number | null>(null);
  const [opt, setOpt] = useState<number>(19);
  const used = Array.from({ length: 16 }, (_, i) => i + 1).filter((c) => known.has(merged[`RC${c}_OPTION`] ?? 0));
  return (
    <section className="panel sv-switches">
      <div className="panel-head">
        <h3>
          <Radio size={16} /> Transmitter switches
        </h3>
      </div>
      <div className="panel-body">
        <p className="sv-what">A switch on the transmitter can release the payload, raise the gear, take a picture or fire the parachute, by giving its channel an option (RCn_OPTION). Flight-mode and other options are on the Calibration and Parameters pages.</p>
        {used.length > 0 && (
          <ul className="sv-switch-list">
            {used.map((c) => {
              const o = known.get(merged[`RC${c}_OPTION`])!;
              return (
                <li key={c}>
                  <span className="sv-switch-ch">Channel {c}</span>
                  <span className="sv-switch-opt">
                    {o.label}
                    {saved[`RC${c}_OPTION`] !== merged[`RC${c}_OPTION`] && <em className="pid-mod">unsaved</em>}
                  </span>
                  <SwitchPos v={channels[c - 1]} />
                  <button className="btn btn-sm btn-ghost" onClick={() => set({ [`RC${c}_OPTION`]: 0 })}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="sv-switch-add">
          <select className="input" value={opt} onChange={(e) => setOpt(Number(e.target.value))} aria-label="What the switch does">
            {SWITCH_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="muted">on</span>
          <ChannelPicker value={ch} merged={merged} allowFlying={false} onPick={setCh} noneLabel="Choose a channel" />
          <button className="btn btn-sm btn-primary" disabled={ch === null} onClick={() => ch !== null && (set({ [`RC${ch}_OPTION`]: opt }), setCh(null))}>
            Add
          </button>
        </div>
        <p className="sv-hint">{known.get(opt)?.what}</p>
      </div>
    </section>
  );
}

function SwitchPos({ v }: { v: number | undefined }) {
  if (!v) return <span className="sv-switch-pos muted">—</span>;
  // ArduPilot's switch positions: low below 1300 µs, high above 1700 µs.
  const pos = v < 1300 ? "low" : v > 1700 ? "high" : "middle";
  return (
    <span className="sv-switch-pos">
      <span className="num">{v}</span> {pos}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function Checks({ issues, onSelect, onFix }: { issues: Issue[]; onSelect: (n: number) => void; onFix: (c: Params) => void }) {
  return (
    <section className="panel sv-checks" aria-label="Checks">
      <div className="panel-head">
        <h3>Checks</h3>
        <span className="sv-board-src">{issues.length ? `${issues.length} to look at` : "Nothing to fix"}</span>
      </div>
      <div className="panel-body">
        {!issues.length && (
          <p className="sv-ok">
            <CircleCheck size={16} /> Every output, the gripper and the switches are set up consistently.
          </p>
        )}
        <ul className="sv-issue-list">
          {issues.map((i) => (
            <li key={i.id} className={`sv-issue-${i.level}`}>
              {i.level === "info" ? <Info size={15} /> : <TriangleAlert size={15} />}
              <div>
                <strong>{i.title}</strong>
                <p>{i.detail}</p>
                <div className="sv-issue-actions">
                  {i.servo && (
                    <button className="btn btn-sm btn-ghost" onClick={() => onSelect(i.servo!)}>
                      Show the output
                    </button>
                  )}
                  {i.fix && (
                    <button className="btn btn-sm" onClick={() => onFix(i.fix!)}>
                      Fix: {Object.entries(i.fix).map(([k, v]) => `${k} = ${v}`).join(", ")}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

