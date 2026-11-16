/*
  What the Servo Outputs page does to the aircraft: write settings (each
  confirmed by the aircraft echoing it), set up a payload release in the
  order ArduPilot needs, and move an output or the gripper to test it.
*/
import { MAV_RESULT, commandLink } from "../services/link/commandLink";
import { useLink } from "../state/linkStore";
import { useParams } from "../state/paramStore";
import { useRebootNeeded } from "../features/params/rebootStore";
import { gripperSettings, needsRestart, type Params } from "./model";

/** Write settings one by one, each confirmed by the aircraft. Returns the names written; throws on the first refusal. */
export async function writeSettings(changes: Params, armedOk = false): Promise<string[]> {
  const before = { ...useParams.getState().values };
  const written: string[] = [];
  for (const [name, value] of Object.entries(changes)) {
    await commandLink.setParam(name, value, 4000, armedOk);
    written.push(name);
  }
  const restart = needsRestart(changes, before);
  if (restart.length) useRebootNeeded.getState().add(restart);
  return written;
}

/**
 * Save the page's changes. Settings the aircraft does not list yet (the
 * gripper's, which appear only once GRIP_ENABLE is on) are written second,
 * after the first batch has made them appear. Returns the names written.
 */
export async function saveChanges(changes: Params, armedOk = false, onStep?: (text: string) => void): Promise<string[]> {
  const values = useParams.getState().values;
  const now = Object.fromEntries(Object.entries(changes).filter(([k]) => k in values));
  const later = Object.fromEntries(Object.entries(changes).filter(([k]) => !(k in values)));
  onStep?.("Writing…");
  const written = await writeSettings(now, armedOk);
  const names = Object.keys(later);
  if (!names.length) return written;
  onStep?.("Reading the settings that just appeared…");
  await commandLink.requestParams(names);
  await until(() => names.every((n) => n in useParams.getState().values), 6000);
  const missing = names.filter((n) => !(n in useParams.getState().values));
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist on this flight controller${missing.some((n) => n.startsWith("GRIP_")) ? " (the gripper must be turned on first, and this firmware may be built without it)" : ""}. The rest was saved.`);
  onStep?.("Writing…");
  return [...written, ...(await writeSettings(later, armedOk))];
}

const until = async (test: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

/**
 * Make an output a payload release (servo gripper), as ArduPilot's gripper
 * setup lays it down: the output's function and GRIP_ENABLE first; once
 * enabled the other GRIP_ settings appear, and are read and then written;
 * GRIP_ENABLE and GRIP_TYPE take effect at the next restart.
 */
export async function setupGripper(servo: number, pos: { grab: number; release: number; neutral: number }, onStep?: (text: string) => void): Promise<void> {
  const { first, then } = gripperSettings(servo, useParams.getState().values, pos);
  onStep?.("Turning the gripper on…");
  await writeSettings(first);
  onStep?.("Reading the gripper's settings…");
  const names = Object.keys(then);
  await commandLink.requestParams(names);
  const appeared = await until(() => names.every((n) => n in useParams.getState().values), 6000);
  if (!appeared) throw new Error("The gripper's settings (GRIP_TYPE and the positions) did not appear after turning it on. This firmware may be built without gripper support.");
  onStep?.("Setting the positions…");
  await writeSettings(then);
}

const lastEventId = () => useLink.getState().events.at(-1)?.id ?? 0;

/** Move an output to a pulse width, for testing. Resolves with nothing, or throws the aircraft's reason. */
export async function testOutput(servo: number, pwm: number): Promise<void> {
  const since = lastEventId();
  const r = await commandLink.setServo(servo, pwm);
  if (r === 0) return;
  // ArduPilot says why in a status text ("ServoRelayEvent: Channel n is already in use").
  let said: string | undefined;
  for (let i = 0; i < 10 && !said; i++) {
    await new Promise((res) => setTimeout(res, 100));
    said = useLink.getState().events.find((e) => e.id > since && /already in use|ServoRelayEvent/i.test(e.text))?.text;
  }
  throw new Error(said ? `The flight controller says: ${said.replace(/^[A-Za-z]+: /, "")}` : `The flight controller answered ${MAV_RESULT[r] ?? r}.`);
}

/** Has an output reached a pulse width (within 2 µs), by the outputs the aircraft reports? */
async function reaches(servo: number, pwm: number, ms: number): Promise<boolean> {
  const from = Date.now();
  return until(() => {
    const s = useLink.getState().telemetry.servo;
    return !!s && s.at > from && Math.abs((s.value.pwm[servo - 1] ?? 0) - pwm) <= 2;
  }, ms);
}

/**
 * Open or close the gripper, and check that it moved.
 *
 * ArduPilot accepts DO_GRIPPER whenever GRIP_ENABLE is 1, even before the
 * restart that actually starts the gripper, and then does nothing
 * (AP_Gripper::enabled() is only the setting). So "accepted" is not taken
 * for "moved": the gripper's output must be reported at the position.
 */
export async function gripper(action: "release" | "grab", check?: { servo: number; pwm: number }): Promise<void> {
  const r = await commandLink.gripper(action);
  if (r !== 0) {
    throw new Error(r === 4 ? "The flight controller has no gripper turned on (GRIP_ENABLE is 0)." : `The flight controller answered ${MAV_RESULT[r] ?? r}.`);
  }
  if (!check) return;
  if (await reaches(check.servo, check.pwm, 2500)) return;
  const now = useLink.getState().telemetry.servo?.value.pwm[check.servo - 1];
  throw new Error(
    `The flight controller accepted the command, but output ${check.servo} did not move to ${check.pwm} µs${now !== undefined ? ` (it is at ${now} µs)` : ""}. ` +
      "Restart the flight controller if you have just turned the gripper on: it starts the gripper only at start-up. On a board with a safety switch, press it until it is solid red.",
  );
}
