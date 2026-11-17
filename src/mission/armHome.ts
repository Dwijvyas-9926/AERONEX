import type { DeliveryAt } from "./payload";

/*
  Where the aircraft will arm, against where the plan says home is.

  ArduCopter moves home to wherever it arms (AP_Arming_Copter::arm_checks,
  unless home is locked). Every height in a mission counts from home, and a
  return to launch flies back to it. A plan drawn from one home and flown
  from another is the same shape lifted or lowered by the difference in the
  ground between the two, and its return goes to the new place.

  The common way to get there: land at the last waypoint, then fly the
  mission again from where it landed.
*/
export interface ArmAwayInput {
  /** The aircraft is armed: home has already been set for this flight. */
  armed: boolean;
  /** Where the aircraft sits, in metres north and east of the plan's home; null when not known. */
  at: { n: number; e: number } | null;
  /** Height of the ground above the plan's home where the aircraft sits, when known. */
  groundThere: number | null;
  /**
   * The aircraft's own height above its home, when its home is the plan's
   * home: on the ground, the step between the two. Used when the ground is
   * not known.
   */
  reported: number | null;
  deliveries: DeliveryAt[];
  /** Words for how to put it back: differs for the virtual aircraft. */
  putBack: string;
}

export interface ArmAwayFinding {
  sev: "bad" | "warn" | "note";
  text: string;
}

/** Farther than this from home and it is no longer the same place. */
export const AWAY_M = 5;

const m = (x: number) => `${Math.abs(x) < 10 ? +Math.abs(x).toFixed(1) : Math.round(Math.abs(x))} m`;

/** The step in height, above the plan's home, from home to where it will arm; null when not known. */
export function armShift(inp: Pick<ArmAwayInput, "groundThere" | "reported">): number | null {
  if (inp.groundThere !== null) return inp.groundThere;
  return inp.reported;
}

export function armAwayFindings(inp: ArmAwayInput): ArmAwayFinding[] {
  if (inp.armed || !inp.at) return [];
  const away = Math.hypot(inp.at.n, inp.at.e);
  if (away <= AWAY_M) return [];
  const shift = armShift(inp);
  const level = shift !== null && Math.abs(shift) < 0.5;
  const where = shift === null ? "" : level ? ", on ground level with it" : `, on ground ${m(shift)} ${shift > 0 ? "higher" : "lower"}`;
  const lead = `The aircraft is ${m(away)} from home${where}. It sets home where it arms, so this plan's heights will count from there and Return to launch will come back there.`;
  if (!inp.deliveries.length) {
    if (level) return [{ sev: "note", text: `${lead} ${inp.putBack}` }];
    const why = shift === null ? " How much higher or lower is not known: load the ground heights." : shift > 0 ? ` Every waypoint will be ${m(shift)} higher above sea level than drawn.` : ` Every waypoint will be ${m(shift)} lower than drawn, closer to the ground.`;
    return [{ sev: "warn", text: `${lead}${why} ${inp.putBack}` }];
  }
  if (shift === null) {
    return [{ sev: "bad", text: `${lead} How much higher or lower is not known, so the delivery heights cannot be trusted: load the ground heights. ${inp.putBack}` }];
  }
  if (level) return [{ sev: "warn", text: `${lead} The ground there is level with home, so the delivery heights still hold. ${inp.putBack}` }];
  const parts: string[] = [];
  let worst: "bad" | "warn" = "warn";
  for (const x of inp.deliveries) {
    const d = x.delivery;
    const agl = d.heightM + shift;
    if (d.method === "drop") {
      if (agl <= 0.5) {
        worst = "bad";
        parts.push(`waypoint ${x.wp} would let go ${agl <= 0 ? "in the ground" : `${m(agl)} above the ground`}, not ${m(d.heightM)}`);
      } else {
        if (Math.abs(shift) >= 1) worst = "bad";
        parts.push(`waypoint ${x.wp} would let go ${m(agl)} above the ground, not ${m(d.heightM)}`);
      }
    } else {
      // Lowering feels for the ground, so the height it lets go at holds; where it starts does not.
      if (agl <= d.hangM) {
        worst = "bad";
        parts.push(`waypoint ${x.wp} would start lowering ${agl <= 0 ? "in the ground" : `only ${m(agl)} above it, with the load already down`}`);
      } else if (d.giveUpM > 0 && agl - d.hangM > d.giveUpM) {
        worst = "bad";
        parts.push(`waypoint ${x.wp} would start lowering ${m(agl)} above the ground and give up after ${m(d.giveUpM)}, before the load touches`);
      } else parts.push(`waypoint ${x.wp} would start lowering ${m(agl)} above the ground, not ${m(d.heightM)}; it still lets go at touchdown`);
    }
  }
  return [{ sev: worst, text: `${lead} Of the deliveries, ${parts.join("; ")}. ${inp.putBack}` }];
}
