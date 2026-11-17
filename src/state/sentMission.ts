import { create } from "zustand";
import { useLink } from "./linkStore";

/*
  The mission AERONEX last sent and saw read back, in the plan's own words.

  The aircraft counts mission commands: a take-off, closing a release, and a
  delivery's five steps are all commands, so its "Reached command #9" is not
  the reader's waypoint 9. Knowing what each command of the sent mission is
  lets the event lists say "Reached waypoint 2, the release" instead.
  Forgotten when the link closes: another aircraft, or another ground
  station, may hold a different mission.
*/
interface SentMission {
  /** What each mission item is, by sequence number; null when the mission on the aircraft is not known. */
  steps: string[] | null;
  set: (steps: string[]) => void;
  clear: () => void;
}

export const useSentMission = create<SentMission>((set) => ({
  steps: null,
  set: (steps) => set({ steps }),
  clear: () => set({ steps: null }),
}));

useLink.subscribe((s, was) => {
  if (was.status === "connected" && s.status !== "connected" && s.status !== "stale") useSentMission.getState().clear();
});

/**
 * An aircraft message in the plan's words: ArduCopter's "Reached command #9"
 * (or the virtual aircraft's) becomes "Reached waypoint 2, the release" when
 * the mission is known. Anything else is left as it is.
 */
export function inPlanWords(text: string, steps: string[] | null): string {
  if (!steps) return text;
  return text.replace(/^((?:Info|Notice):\s*)?Reached (?:command #|waypoint )(\d+)$/i, (all, prefix: string | undefined, n: string) => {
    const step = steps[Number(n)];
    return step ? `${prefix ?? ""}Reached ${step} (command ${n})` : all;
  });
}
