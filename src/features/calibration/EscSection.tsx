import { Rocket, RotateCw, TriangleAlert, X, Zap } from "lucide-react";
import { useState } from "react";
import { commandLink } from "../../services/link/commandLink";
import { useLink } from "../../state/linkStore";
import { useParams } from "../../state/paramStore";
import { ESC_CALIBRATION, ESC_TYPES } from "./ardupilot";
import { ParamNumber, ParamSelect } from "./common";
import { useRequireParams, writeParam } from "./paramWrite";
import { notify } from "../../state/notifyStore";

export function EscSection({ canSend }: { canSend: boolean }) {
  useRequireParams(["MOT_PWM_TYPE", "MOT_PWM_MIN", "MOT_PWM_MAX", "MOT_SPIN_ARM", "MOT_SPIN_MIN", "MOT_SPIN_MAX", "ESC_CALIBRATION"], canSend);
  const armed = useLink((s) => s.vehicle?.armed) ?? false;
  const escCal = useParams((s) => s.values["ESC_CALIBRATION"]);
  const virtual = useLink((s) => s.virtual);
  const volts = useLink((s) => s.telemetry.battery?.value.voltage ?? null);
  const [propsOff, setPropsOff] = useState(false);
  // Set and waiting for the power-up that runs it: 2 passes the stick through, 3 runs by itself.
  const waiting = escCal === 2 || escCal === 3;
  /*
    A flight battery on the aircraft, by its voltage: USB alone reads about
    5 V or nothing. With the ESCs already powered, the full throttle sent at
    the calibration start-up spins the motors instead of teaching the ESCs.
  */
  const batteryOn = !virtual && volts !== null && volts > 6;

  /*
    Sets the one-shot "calibrate at the next power-up" mode and stops there.
    It used to restart the flight controller as well. ArduCopter, started with
    ESC_CALIBRATION = 3, sends full throttle to every ESC for five seconds and
    then zero (Copter::esc_calibration_auto). An ESC learns its range only if
    that is the first signal it sees as it powers up; one that is already
    powered takes it as a command and runs its motor at full power. So the
    start has to be made by plugging the battery in, never from a button here.
  */
  const calibrate = async () => {
    try {
      await commandLink.setParam("ESC_CALIBRATION", 3);
      notify("success", "Calibration set for the next power-up", "Unplug USB and the battery now, then follow the steps.");
    } catch (e) {
      notify("error", "ESC calibration not set", (e as Error).message);
    }
  };

  return (
    <div className="cal-section">
      <div className="cal-sec-head">
        <div>
          <h2>ESC</h2>
          <p>Set the ESC protocol and output range, then calibrate the ESC throttle endpoints — the Mission Planner ESC setup, behind a props-off gate.</p>
        </div>
        <Zap className="cal-sec-icon" />
      </div>

      <div className="callout danger">
        <TriangleAlert />
        <span><strong>Remove all propellers before anything on this page.</strong> ESC calibration and any throttle output can spin the motors at full power without warning.</span>
      </div>
      {armed && <div className="callout warn"><X /><span>Disarm before changing motor parameters or calibrating.</span></div>}

      <section className="panel">
        <div className="panel-head"><h3>ESC type &amp; output</h3></div>
        <div className="panel-body cal-body">
          <div className="esc-grid">
            <ParamSelect name="MOT_PWM_TYPE" label="ESC type (protocol)" options={ESC_TYPES} help="Reboot after changing. DShot needs a board/output that supports it." disabled={!canSend} />
            <ParamNumber name="MOT_PWM_MIN" label="PWM min" suffix="µs" step={1} min={0} max={2000} help="0 = follow RC3 range." disabled={!canSend} />
            <ParamNumber name="MOT_PWM_MAX" label="PWM max" suffix="µs" step={1} min={0} max={2000} help="0 = follow RC3 range." disabled={!canSend} />
            <ParamNumber name="MOT_SPIN_ARM" label="Spin armed" step={0.01} min={0} max={1} help="Throttle when armed & idle (0–1). Typical 0.10." disabled={!canSend} />
            <ParamNumber name="MOT_SPIN_MIN" label="Spin min" step={0.01} min={0} max={1} help="Lowest flight throttle (0–1). Typical 0.15." disabled={!canSend} />
            <ParamNumber name="MOT_SPIN_MAX" label="Spin max" step={0.01} min={0} max={1} help="Highest throttle (0–1). Typical 0.95." disabled={!canSend} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>ESC calibration</h3>
          {waiting && <span className="pill warn plain">Set for the next power-up</span>}
        </div>
        <div className="panel-body cal-body">
          <p className="muted">
            All-at-once calibration, as ArduPilot does it: the next time the flight controller powers up it sends every ESC full throttle for five seconds and then zero, so each learns its range. An ESC only learns if that is the first
            thing it sees as it powers up, so the start is made by plugging the battery in, not from this page.
          </p>
          {batteryOn && !waiting && (
            <div className="callout warn">
              <TriangleAlert />
              <span>
                <strong>A battery is connected ({volts!.toFixed(1)} V).</strong> Set the calibration with the aircraft on USB power alone. ESCs that are already powered treat the calibration's full throttle as a command.
              </span>
            </div>
          )}
          {waiting && (
            <div className="callout danger">
              <TriangleAlert />
              <span>
                <strong>The next power-up sends full throttle to the ESCs.</strong> Do not restart the flight controller from the app{batteryOn ? `, and unplug the battery now (${volts!.toFixed(1)} V)` : ""}. Follow the steps from step 3, or
                clear the flag to cancel.
              </span>
            </div>
          )}
          <ol className="esc-steps">
            <li>Remove every propeller. Tick the box below.</li>
            <li>With the aircraft on USB power only (battery unplugged), press <strong>Set calibration for the next power-up</strong>.</li>
            <li>Unplug USB, so the flight controller and the ESCs are all off.</li>
            <li>Plug the battery in. If the aircraft has a safety switch, press it. Do not touch the throttle.</li>
            <li>Listen: a musical tone and two beeps, then a beep for each battery cell and one long beep. The range is set.</li>
            <li>Unplug the battery, wait a few seconds, and power up as usual. The calibration clears itself after the pass.</li>
          </ol>

          <ParamSelect name="ESC_CALIBRATION" label="ESC calibration mode" options={ESC_CALIBRATION} help="“Auto-calibrate at the next power-up” is set for you by the button below." disabled={!canSend} />

          {virtual && <p className="muted">The virtual aircraft has no ESCs, so there is nothing to calibrate on it. The steps are here to read through.</p>}
          <label className="esc-confirm">
            <input type="checkbox" checked={propsOff} onChange={(e) => setPropsOff(e.target.checked)} />
            <span>I have removed all propellers.</span>
          </label>

          <div className="cal-actions">
            <button className="btn btn-danger" disabled={!canSend || armed || !propsOff || waiting || virtual} title={virtual ? "The virtual aircraft has no ESCs to calibrate" : undefined} onClick={() => void calibrate()}>
              <Rocket /> Set calibration for the next power-up
            </button>
            {escCal !== undefined && escCal !== 0 && (
              <button className="btn btn-ghost" disabled={!canSend} onClick={() => writeParam("ESC_CALIBRATION", 0)}>
                <RotateCw size={15} /> Clear calibration flag
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
