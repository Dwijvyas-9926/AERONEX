import { ArrowLeft, ArrowRight, Check, Drone, HardDrive } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BrandLockup } from "../../components/shell/BrandMark";
import { isDesktop } from "../../desktop/bridge";
import { notify } from "../../state/notifyStore";
import {
  cleanName,
  OPERATOR_NAME_MAX,
  useOperator,
} from "../../state/operatorStore";
import { hadProfilesAtStart, useProfiles } from "../../state/profileStore";
import {
  BOARD_LABELS,
  BOARD_NOTES,
  FIRMWARE_LABELS,
  FRAME_LABELS,
  type BoardId,
  type DeclaredFirmware,
  type FrameType,
} from "../../vehicle/types";

/*
  First launch: who is using this copy, and which aircraft they fly.

  Two short steps, then the app. It is a setup, not an account: the answers
  stay on this computer with everything else AERONEX keeps, and the screen
  says so. It comes back only after "Reset app data".

  A computer that used AERONEX before this screen existed already has its
  aircraft; the second step shows them and keeps them as they are.
*/

const PLACE = isDesktop() ? "this computer" : "this browser";

function Choice<T extends string>({
  name,
  value,
  options,
  onChange,
  notes,
}: {
  name: string;
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
  notes?: Record<T, string>;
}) {
  return (
    <div className="welcome-choices" role="radiogroup" aria-label={name}>
      {(Object.entries(options) as [T, string][]).map(([k, label]) => (
        <label key={k} className="welcome-choice" data-checked={value === k}>
          <input
            type="radio"
            name={name}
            value={k}
            checked={value === k}
            onChange={() => onChange(k)}
          />
          <span>
            <strong>{label}</strong>
            {notes ? <small>{notes[k]}</small> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

export function WelcomePage() {
  const finishSetup = useOperator((s) => s.finishSetup);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const updateProfile = useProfiles((s) => s.update);
  const existing = hadProfilesAtStart && profiles.length > 0;

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const [craft, setCraft] = useState("");
  const [craftError, setCraftError] = useState<string | null>(null);
  const [frame, setFrame] = useState<FrameType>("quad-x");
  const [board, setBoard] = useState<BoardId>("pixhawk-2.4.8");
  const [firmware, setFirmware] = useState<DeclaredFirmware>("ardupilot");

  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // Each step starts in its first field, or on its heading when it has none.
  useEffect(() => {
    document.title = "Welcome – AERONEX";
    const field = card.current?.querySelector<HTMLInputElement>("input.input");
    (field ?? heading.current)?.focus();
  }, [step]);

  function next(e: FormEvent) {
    e.preventDefault();
    if (!cleanName(name)) {
      setNameError(
        "Enter your name, so AERONEX can greet you and label your work.",
      );
      return;
    }
    setNameError(null);
    setStep(2);
  }

  function finish(e: FormEvent) {
    e.preventDefault();
    if (!existing) {
      const craftName = cleanName(craft);
      if (!craftName) {
        setCraftError(
          "Give the aircraft a name. Anything that tells it apart from your others.",
        );
        return;
      }
      const target = activeId ?? profiles[0]?.id;
      if (target)
        updateProfile(target, { name: craftName, frame, board, firmware });
    }
    finishSetup(name, team);
    notify(
      "success",
      `Welcome, ${cleanName(name)}`,
      "Connect your aircraft from the top bar, or open the Flight Simulator to try every page on the virtual one first.",
    );
  }

  return (
    <main className="welcome">
      <div className="welcome-card" ref={card}>
        <div className="welcome-brand">
          <BrandLockup />
        </div>
        <p className="welcome-step" aria-live="polite">
          Step {step} of 2
        </p>

        {step === 1 ? (
          <form onSubmit={next} noValidate>
            <h1 ref={heading} tabIndex={-1}>
              Welcome to AERONEX
            </h1>
            <p className="welcome-lede">
              Set up the ground station on {PLACE}. It takes a minute, and you
              can change any of it later in Settings.
            </p>
            <label className="field">
              <span>Your name</span>
              <input
                className="input"
                autoComplete="name"
                maxLength={OPERATOR_NAME_MAX}
                value={name}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "name-error" : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              {nameError ? (
                <small id="name-error" className="welcome-error">
                  {nameError}
                </small>
              ) : null}
            </label>
            <label className="field">
              <span>Team or organisation (optional)</span>
              <input
                className="input"
                autoComplete="organization"
                maxLength={OPERATOR_NAME_MAX}
                value={team}
                onChange={(e) => setTeam(e.target.value)}
              />
            </label>
            <p className="welcome-private">
              <HardDrive aria-hidden size={16} />
              <span>
                Kept on {PLACE} only. AERONEX has no accounts and sends this
                nowhere.
              </span>
            </p>
            <div className="welcome-actions">
              <button className="btn btn-primary btn-lg" type="submit">
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </form>
        ) : existing ? (
          <form onSubmit={finish}>
            <h1 ref={heading} tabIndex={-1}>
              Your aircraft
            </h1>
            <p className="welcome-lede">
              These are already on {PLACE}. They stay exactly as they are, with
              their settings, models and logs.
            </p>
            <ul className="welcome-fleet">
              {profiles.map((p) => (
                <li key={p.id}>
                  <Drone aria-hidden size={18} />
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {FRAME_LABELS[p.frame]}, {BOARD_LABELS[p.board]}
                    </small>
                  </span>
                  {p.id === activeId ? (
                    <span className="pill ok plain">Active</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="welcome-actions">
              <button
                className="btn btn-lg"
                type="button"
                onClick={() => setStep(1)}
              >
                <ArrowLeft size={16} /> Back
              </button>
              <button className="btn btn-primary btn-lg" type="submit">
                <Check size={16} /> Finish setup
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={finish} noValidate>
            <h1 ref={heading} tabIndex={-1}>
              Your first aircraft
            </h1>
            <p className="welcome-lede">
              Describe the aircraft you will fly. Add more, import its 3D model
              and fill in its mass later on the Aircraft profile page.
            </p>
            <label className="field">
              <span>Aircraft name</span>
              <input
                className="input"
                maxLength={OPERATOR_NAME_MAX}
                placeholder="For example, Survey quad"
                value={craft}
                aria-invalid={!!craftError}
                aria-describedby={craftError ? "craft-error" : undefined}
                onChange={(e) => setCraft(e.target.value)}
              />
              {craftError ? (
                <small id="craft-error" className="welcome-error">
                  {craftError}
                </small>
              ) : null}
            </label>
            <fieldset className="welcome-set">
              <legend>Frame</legend>
              <Choice
                name="Frame"
                value={frame}
                options={FRAME_LABELS}
                onChange={setFrame}
              />
            </fieldset>
            <fieldset className="welcome-set">
              <legend>Flight controller</legend>
              <Choice
                name="Flight controller"
                value={board}
                options={BOARD_LABELS}
                notes={BOARD_NOTES}
                onChange={setBoard}
              />
            </fieldset>
            <fieldset className="welcome-set">
              <legend>Firmware you plan to run</legend>
              <Choice
                name="Firmware"
                value={firmware}
                options={FIRMWARE_LABELS}
                onChange={setFirmware}
              />
              <small className="welcome-hint">
                A note for you. What the connected flight controller reports
                always decides what AERONEX does.
              </small>
            </fieldset>
            <div className="welcome-actions">
              <button
                className="btn btn-lg"
                type="button"
                onClick={() => setStep(1)}
              >
                <ArrowLeft size={16} /> Back
              </button>
              <button className="btn btn-primary btn-lg" type="submit">
                <Check size={16} /> Finish setup
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
