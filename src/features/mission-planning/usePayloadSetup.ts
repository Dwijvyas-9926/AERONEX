import { useMemo } from "react";
import { withOlderNames } from "../../mavlink/paramNames";
import { releaseOptions, type ReleaseOption } from "../../mission/payload";
import { boardFor, checkOutputs, portOf } from "../../servo/model";
import { linkManager, rememberedParams } from "../../services/link/linkManager";
import { useLink } from "../../state/linkStore";
import { useParams } from "../../state/paramStore";
import { useActiveProfile } from "../../state/profileStore";
import { useRebootNeeded } from "../params/rebootStore";

/*
  What the aircraft has to let a payload go with, for the planner.

  The release is the aircraft's: its gripper and the outputs it leaves free,
  as the Servo Outputs page set them up. With an aircraft linked and its
  settings read, those are its own; otherwise the settings last read from an
  aircraft, said to be so; with none, nothing can be checked.
*/
export interface PayloadSetup {
  /** The aircraft's settings, with the older names added; null when none are known. */
  aircraft: Record<string, number> | null;
  /** Where they came from, in words. */
  source: string;
  /** Read from the aircraft linked now. */
  live: boolean;
  options: ReleaseOption[];
  port: (servo: number) => string;
  restartPending: string[];
  /** What the Servo Outputs check says about an output, as titles. */
  outputIssues: (servo: number) => string[];
}

export function usePayloadSetup(): PayloadSetup {
  const status = useLink((s) => s.status);
  const virtual = useLink((s) => s.virtual);
  const vehicle = useLink((s) => s.vehicle);
  const autopilot = useLink((s) => s.telemetry.autopilot);
  const values = useParams((s) => s.values);
  const count = useParams((s) => s.count);
  const received = useParams((s) => s.received);
  const profile = useActiveProfile();
  const restartPending = useRebootNeeded((s) => s.names);
  const linked = status === "connected";
  const complete = linked && count !== null && count > 0 && received >= count;

  return useMemo(() => {
    const board = boardFor(autopilot?.value.boardId ?? (virtual ? 9 : null), profile?.board ?? null);
    const layout = board.layout ?? boardFor(null, "pixhawk-2.4.8").layout;
    const port = (servo: number) => portOf(servo, layout).long;
    let aircraft: Record<string, number> | null = null;
    let source = "no aircraft's settings";
    let live = false;
    if (linked && virtual && linkManager.sim) {
      // The virtual aircraft's settings are at hand, whether or not they have been downloaded; `values` changing is the sign they may have changed.
      aircraft = { ...linkManager.sim.ap.params };
      source = "the virtual aircraft's settings";
      live = true;
    } else if (complete && values.SERVO1_FUNCTION !== undefined) {
      aircraft = withOlderNames(values);
      source = "your aircraft's settings";
      live = true;
    } else {
      const saved = rememberedParams();
      if (saved && saved.values.SERVO1_FUNCTION !== undefined) {
        aircraft = withOlderNames(saved.values);
        source = `the settings read from your aircraft on ${new Date(saved.at).toLocaleDateString()}`;
      }
    }
    const issues = aircraft ? checkOutputs(aircraft, layout, { mavType: vehicle?.type }) : [];
    const outputIssues = (servo: number) => issues.filter((i) => i.servo === servo && i.level !== "info").map((i) => i.title);
    return { aircraft, source, live, options: releaseOptions(aircraft, port, live ? restartPending : []), port, restartPending: live ? restartPending : [], outputIssues };
  }, [autopilot?.value.boardId, linked, virtual, profile?.board, complete, values, vehicle?.type, restartPending]);
}
