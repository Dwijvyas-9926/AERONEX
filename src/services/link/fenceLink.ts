import { compareFence, limitsDiffer, limitsFrom, LIMIT_NAMES, wireToZones, zonesToWire, type FenceLimits } from "../../geo/fence";
import { useParams } from "../../state/paramStore";
import type { AircraftFence, FenceSnapshot } from "../../state/fenceStore";
import { commandLink } from "./commandLink";

/*
  Moving a whole fence to and from the aircraft: the zones, which travel as
  their own list, and the FENCE_* settings, which are parameters.

  Sending is ordered so the aircraft never holds a half-made fence that is
  switched on:

  1. If the fence is being turned off, that goes first.
  2. The zones go up, and are read back and compared item by item.
  3. The other settings are written, each one confirmed by the aircraft
     echoing the value back.
  4. If the fence is being turned on, that goes last, once everything it
     will enforce is in place and checked.

  Anything that fails stops the sequence there and says which step, so what
  the aircraft holds is never a guess.
*/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for ArduPilot's fence loader (run at 10 Hz) to act on a new fence a few times over. */
const SETTLE_MS = 600;

/** The fence settings as the aircraft holds them, reading any not yet here. */
async function readLimits(): Promise<{ limits: FenceLimits; missing: string[] }> {
  const have = () => useParams.getState().values;
  let missing = LIMIT_NAMES.filter((k) => !Number.isFinite(have()[k]));
  if (missing.length) {
    await commandLink.requestParams([...missing]);
    for (let i = 0; i < 25 && missing.length; i++) {
      await sleep(200);
      missing = LIMIT_NAMES.filter((k) => !Number.isFinite(have()[k]));
    }
  }
  return { limits: limitsFrom(have()), missing };
}

/** Read the aircraft's fence: its zones and its settings. */
export async function readFence(): Promise<AircraftFence> {
  const items = await commandLink.downloadFence();
  const { zones, notes } = wireToZones(items);
  const { limits, missing } = await readLimits();
  if (missing.length) notes.push(`The aircraft did not report ${missing.join(", ")}; ${missing.length === 1 ? "it is" : "they are"} shown at ArduPilot's default.`);
  return { zones, limits, at: Date.now(), notes };
}


/**
 * Send the draft and check the aircraft holds it. Resolves with the fence
 * as read back; rejects with the step that failed.
 */
export async function sendFence(draft: FenceSnapshot, progress?: (step: string) => void): Promise<AircraftFence> {
  const say = (s: string) => progress?.(s);
  const now = () => limitsFrom(useParams.getState().values);
  const write = async (name: keyof FenceLimits, value: number) => {
    try {
      await commandLink.setParam(name, value);
    } catch (e) {
      throw new Error(`${name} could not be set to ${value}: ${(e as Error).message}`);
    }
  };

  // 1. Off first, when it is being turned off.
  if (draft.limits.FENCE_ENABLE < 1 && now().FENCE_ENABLE >= 1) {
    say("Turning the fence off");
    await write("FENCE_ENABLE", draft.limits.FENCE_ENABLE);
  }

  // 2. The zones, read back to be sure.
  const items = zonesToWire(draft.zones);
  /*
    A firmware trap, found against ArduCopter itself (4.6, and 4.7 built for
    SITL, which keep the old FENCE_POINT protocol): a fence of only one or two
    circles is stored with FENCE_TOTAL 0, and if FENCE_TOTAL was anything else
    the old protocol's housekeeping (AC_PolyFence_loader::update) takes the
    change for a request to clear the fence, and wipes it a moment after it
    was accepted. Clearing first makes FENCE_TOTAL 0 beforehand, so nothing
    changes and nothing is wiped.
  */
  if (items.length > 0 && items.length < 3) {
    say("Clearing the old zones first");
    await commandLink.uploadFence([]);
    await sleep(SETTLE_MS);
  }
  say(items.length ? `Sending ${draft.zones.length} ${draft.zones.length === 1 ? "zone" : "zones"}` : "Clearing the zones");
  let sendError: Error | null = null;
  await commandLink.uploadFence(items).catch((e: Error) => {
    // Over a poor link the aircraft's "got it" can be the message lost. A refusal is final; silence is not.
    if (!/stopped answering/.test(e.message)) throw e;
    sendError = e;
  });
  // Read back after the firmware has had time to act on what it stored: a check made at once can pass
  // and the fence still be gone a tenth of a second later (above).
  await sleep(SETTLE_MS);
  say("Reading the zones back");
  const got = await commandLink.downloadFence().catch((e: Error) => {
    throw sendError ?? e;
  });
  const differs = compareFence(items, got);
  if (differs) throw sendError ?? new Error(`The zones were sent, but the aircraft does not hold what was sent. ${differs} Send again, and do not fly until the fence reads back the same.`);

  // 3. The settings, except switching on.
  const toWrite = limitsDiffer(draft.limits, now()).filter((k) => k !== "FENCE_ENABLE");
  for (const k of toWrite) {
    say(`Setting ${k}`);
    await write(k, draft.limits[k]);
  }

  // 4. On last, once all it enforces is in place.
  if (draft.limits.FENCE_ENABLE >= 1 && now().FENCE_ENABLE < 1) {
    say("Turning the fence on");
    await write("FENCE_ENABLE", draft.limits.FENCE_ENABLE);
  }

  const held = now();
  const off = limitsDiffer(draft.limits, held);
  if (off.length) throw new Error(`The aircraft reports ${off.map((k) => `${k} ${held[k]}`).join(", ")}, not what was sent. Send again.`);
  return { zones: wireToZones(got).zones, limits: held, at: Date.now(), notes: [] };
}
