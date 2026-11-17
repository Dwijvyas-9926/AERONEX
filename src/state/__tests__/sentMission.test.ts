import { describe, expect, it } from "vitest";
import { inPlanWords } from "../sentMission";
import { planSteps, planToMission, type PlanPoint } from "../simStore";
import { newDelivery } from "../../mission/payload";

const HOME = { lat: 23.0225, lon: 72.5714, altMsl: 53 };

describe("aircraft messages in the plan's words", () => {
  // Three waypoints, a drop at the second: twelve mission commands.
  const points: PlanPoint[] = [
    { id: "a", n: 100, e: 0, alt: 30, holdS: 0 },
    { id: "b", n: 150, e: 80, alt: 30, holdS: 0, delivery: newDelivery("drop", { kind: "gripper" }) },
    { id: "c", n: 50, e: 120, alt: 30, holdS: 0 },
  ];
  const steps = planSteps(points, "land");
  const mission = planToMission(HOME, 20, points, "land");

  it("names each command the aircraft reaches by the waypoint it belongs to", () => {
    expect(mission).toHaveLength(steps.length);
    expect(inPlanWords("Reached command #3", steps)).toBe("Reached waypoint 1 (command 3)");
    expect(inPlanWords("Info: Reached command #5", steps)).toBe("Info: Reached waypoint 2, down to the release height (command 5)");
    expect(inPlanWords("Reached command #9", steps)).toBe("Reached waypoint 3 (command 9)");
  });

  it("leaves everything else, and an unknown mission, as it is", () => {
    expect(inPlanWords("Reached command #3", null)).toBe("Reached command #3");
    expect(inPlanWords("Reached command #40", steps)).toBe("Reached command #40");
    expect(inPlanWords("Gripper Released", steps)).toBe("Gripper Released");
  });
});
