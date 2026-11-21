import { useState } from "react";
import { confirmAction, notify } from "../../state/notifyStore";
import { resetAppData } from "../../state/resetApp";
import { rememberKeys, setRememberKeys } from "../../state/secretStorage";
import { isDesktop } from "../../desktop/bridge";
import { encryptionAvailable } from "../../desktop/secrets";
import { UpdatesSection } from "../../desktop/UpdateNotice";
import { OPERATOR_NAME_MAX, useOperator } from "../../state/operatorStore";
import { holdingAircraft } from "../../desktop/updates";
import { useLink } from "../../state/linkStore";
import { useFirmware } from "../../firmware/installer";
import { AI_MODELS, GRAPHICS, useSettings, type GraphicsPreset, type MotionPref, type Units } from "../../state/settingsStore";

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** The name and team from the first-run setup. Saved when a field is left. */
function OperatorSection() {
  const name = useOperator((s) => s.name);
  const team = useOperator((s) => s.team);
  const update = useOperator((s) => s.update);
  const [n, setN] = useState(name);
  const [t, setT] = useState(team);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="h3">You</h2>
      </div>
      <div className="setting">
        <div>
          <strong>Name and team</strong>
          <p>From the first-run setup. Kept on {isDesktop() ? "this computer" : "this browser"} only; AERONEX has no accounts and sends this nowhere.</p>
        </div>
        <div className="operator-fields">
          <input
            className="input"
            aria-label="Your name"
            maxLength={OPERATOR_NAME_MAX}
            value={n}
            onChange={(e) => setN(e.target.value)}
            onBlur={() => {
              update({ name: n });
              setN(useOperator.getState().name);
            }}
          />
          <input
            className="input"
            aria-label="Team or organisation"
            placeholder="Team or organisation"
            maxLength={OPERATOR_NAME_MAX}
            value={t}
            onChange={(e) => setT(e.target.value)}
            onBlur={() => update({ team: t })}
          />
        </div>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const s = useSettings();
  const [remember, setRemember] = useState(rememberKeys);
  return (
    <div className="page-pad" style={{ maxWidth: 920 }}>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>{isDesktop() ? "Saved on this computer and applied immediately." : "Saved in this browser and applied immediately."}</p>
        </div>
      </header>
      <div className="stack">
        <OperatorSection />
        <UpdatesSection />
        <section className="panel">
          <div className="panel-head">
            <h2 className="h3">Display</h2>
          </div>
          <div className="setting">
            <div>
              <strong>Motion</strong>
              <p>Reduced motion stops the hero flight, page transitions and pulsing indicators. System follows your operating system setting.</p>
            </div>
            <Segmented<MotionPref>
              label="Motion"
              value={s.motion}
              onChange={(v) => s.set("motion", v)}
              options={[
                ["system", "System"],
                ["reduced", "Reduced"],
                ["full", "Full"],
              ]}
            />
          </div>
          <div className="setting">
            <div>
              <strong>Graphics quality</strong>
              <p>{GRAPHICS[s.graphics].detail}</p>
            </div>
            <Segmented<GraphicsPreset>
              label="Graphics quality"
              value={s.graphics}
              onChange={(v) => s.set("graphics", v)}
              options={(Object.keys(GRAPHICS) as GraphicsPreset[]).map((k) => [k, GRAPHICS[k].label])}
            />
          </div>
          <div className="setting">
            <div>
              <strong>Units</strong>
              <p>Altitude and speed on the Flight Data and Connection readouts. Mission planning, the simulator, Keyboard Flight and the setup pages always work in metres and m/s, as ArduPilot does, and label every value with its unit.</p>
            </div>
            <Segmented<Units>
              label="Units"
              value={s.units}
              onChange={(v) => s.set("units", v)}
              options={[
                ["metric", "Metric"],
                ["imperial", "Imperial"],
              ]}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="h3">Assistant</h2>
          </div>
          <div className="setting">
            <div>
              <strong>Anthropic API key</strong>
              <p>Powers the assistant (the Ask button in the top bar, or Ctrl J). Sent only to Anthropic, which bills the key's account per question; AERONEX has no server. Kept for this session unless you choose to remember keys below. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.</p>
            </div>
            <div className="set-ai-key">
              <input className="input" type="password" placeholder="sk-ant-…" value={s.aiKey} onChange={(e) => s.set("aiKey", e.target.value)} />
              {s.aiKey && <button className="btn btn-ghost" onClick={() => s.set("aiKey", "")} title="Remove stored key">Clear</button>}
            </div>
          </div>
          {isDesktop() ? (
            <div className="setting">
              <div>
                <strong>Where keys are kept</strong>
                <p>
                  {encryptionAvailable()
                    ? "Encrypted by Windows for your user account, in this app's own folder. Other Windows users on this computer cannot read them."
                    : "Windows could not encrypt keys on this account, so a key you enter is kept only until AERONEX closes."}
                </p>
              </div>
            </div>
          ) : (
            <div className="setting">
              <div>
                <strong>Remember keys on this device</strong>
                <p>Off: API keys (this one and any map provider key) are kept only until this browser tab closes. On: they stay in this browser's storage until you clear them. Leave it off on a shared computer.</p>
              </div>
              <Segmented
                label="Remember keys"
                value={remember ? "on" : "off"}
                onChange={(v) => { setRememberKeys(v === "on"); setRemember(v === "on"); }}
                options={[
                  ["off", "This session"],
                  ["on", "Remember"],
                ]}
              />
            </div>
          )}
          <div className="setting">
            <div>
              <strong>Search the web</strong>
              <p>Lets the assistant look things up and read the pages it finds, for answers that depend on a firmware version, a part's specification or a local rule, with the sources shown. Anthropic bills each search on top of the answer (at most four per question). Off: it answers from what it knows and the AERONEX manual.</p>
            </div>
            <Segmented
              label="Search the web"
              value={s.aiWeb ? "on" : "off"}
              onChange={(v) => s.set("aiWeb", v === "on")}
              options={[
                ["on", "On"],
                ["off", "Off"],
              ]}
            />
          </div>
          <div className="setting">
            <div>
              <strong>Share aircraft data</strong>
              <p>Sends a snapshot of the linked aircraft with each question: firmware family, mode, arming state, health readings, a few settings, the Preflight and Doctor results, and a summary of the mission and fence. Never its position.</p>
            </div>
            <Segmented
              label="Share aircraft data"
              value={s.aiShare ? "on" : "off"}
              onChange={(v) => s.set("aiShare", v === "on")}
              options={[
                ["on", "On"],
                ["off", "Off"],
              ]}
            />
          </div>
          <div className="setting">
            <div>
              <strong>Model</strong>
              <p>Which Claude model answers. If you get a “model not available” error, pick another from the list, or type the id of any model your account has access to.</p>
            </div>
            <>
              <input className="input" list="ai-models" value={s.aiModel} onChange={(e) => s.set("aiModel", e.target.value)} style={{ maxWidth: 280 }} aria-label="AI model" />
              <datalist id="ai-models">
                {AI_MODELS.map((m) => <option key={m} value={m} />)}
              </datalist>
            </>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="h3">Stored data</h2>
          </div>
          <div className="setting">
            <div>
              <strong>Record telemetry logs</strong>
              <p>Keep a telemetry log (.tlog) of every session linked to an aircraft, real or virtual, in the Flight Logs library. It opens there and in Mission Planner, QGroundControl and MAVProxy. Kept in this browser only.</p>
            </div>
            <Segmented
              label="Record telemetry logs"
              value={s.recordTlog ? "on" : "off"}
              onChange={(v) => s.set("recordTlog", v === "on")}
              options={[
                ["on", "On"],
                ["off", "Off"],
              ]}
            />
          </div>
          <div className="setting">
            <div>
              <strong>Reset app data</strong>
              <p>
                Removes everything AERONEX keeps {isDesktop() ? "on this computer" : "in this browser"}: your name, aircraft profiles, settings, API keys, frame designs, the mission plan, imported 3D models, saved map areas and the
                flight-log library, then starts again at the welcome screen. Nothing on any flight controller is changed. Not available while a flight controller is connected.
              </p>
            </div>
            <button
              className="btn btn-danger"
              onClick={async () => {
                // Resetting reloads the app, which would drop a live link to a real aircraft.
                if (holdingAircraft(useLink.getState(), useFirmware.getState().step)) {
                  notify("warn", "Disconnect the aircraft first", "Resetting restarts AERONEX, which would end the link to the flight controller. Disconnect it, then reset.");
                  return;
                }
                const ok = await confirmAction({
                  title: "Reset all app data?",
                  body: `Your name, aircraft profiles, settings, API keys, frame designs, the mission plan, imported 3D models, saved map areas and the flight-log library stored ${isDesktop() ? "on this computer" : "in this browser"} will be deleted. This can't be undone.`,
                  confirmLabel: "Reset data",
                  tone: "danger",
                });
                if (!ok) return;
                await resetAppData();
                notify("info", "App data reset", "Reloading.");
                window.setTimeout(() => window.location.reload(), 600);
              }}
            >
              Reset data
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
