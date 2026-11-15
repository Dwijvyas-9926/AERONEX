import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type FenceZone } from "../../geo/fence";
import { fenceSync, useFence } from "../fenceStore";

const zone = (id: string): FenceZone => ({ id, shape: "polygon", role: "in", points: [{ lat: 23, lon: 72 }, { lat: 23.001, lon: 72 }, { lat: 23.001, lon: 72.001 }, { lat: 23, lon: 72.001 }] });

beforeEach(() => {
  useFence.setState({ zones: [], limits: { ...DEFAULT_LIMITS }, aircraft: null, edited: false, selected: null, past: [], future: [] });
});

describe("the fence being planned", () => {
  it("undoes and redoes each change, and a whole drag as one step", () => {
    const f = useFence.getState();
    f.addZone(zone("a"));
    f.setLimit("FENCE_ALT_MAX", 80);
    f.begin();
    for (let i = 0; i < 5; i++) useFence.getState().moveVertex("a", 0, { lat: 23 - i * 0.0001, lon: 72 }, false);
    const s = useFence.getState();
    expect(s.zones[0].shape === "polygon" && s.zones[0].points[0].lat).toBeCloseTo(22.9996, 6);
    s.undo();
    expect(useFence.getState().zones[0].shape === "polygon" && (useFence.getState().zones[0] as { points: { lat: number }[] }).points[0].lat).toBe(23);
    useFence.getState().undo();
    expect(useFence.getState().limits.FENCE_ALT_MAX).toBe(100);
    useFence.getState().redo();
    expect(useFence.getState().limits.FENCE_ALT_MAX).toBe(80);
  });

  it("keeps an area to three corners at least", () => {
    useFence.getState().addZone(zone("a"));
    useFence.getState().removeVertex("a", 0);
    useFence.getState().removeVertex("a", 0);
    const z = useFence.getState().zones[0];
    expect(z.shape === "polygon" && z.points.length).toBe(3);
  });

  it("follows the aircraft until edited, and keeps edits when it is read", () => {
    const theirs = { zones: [zone("x")], limits: { ...DEFAULT_LIMITS, FENCE_ENABLE: 1 }, at: 1, notes: [] };
    useFence.getState().adopt(theirs, true);
    expect(fenceSync(useFence.getState()).same).toBe(true);
    expect(useFence.getState().edited).toBe(false);
    useFence.getState().setLimit("FENCE_ALT_MAX", 60);
    const sync = fenceSync(useFence.getState());
    expect(sync.same).toBe(false);
    expect(sync.limitsDiffer).toEqual(["FENCE_ALT_MAX"]);
    expect(useFence.getState().edited).toBe(true);
    // Read again without taking it as the draft: the edit stays, and the difference is still known.
    useFence.getState().adopt(theirs, false);
    expect(useFence.getState().limits.FENCE_ALT_MAX).toBe(60);
    // Once sent and checked, they are the same and the draft is clean.
    useFence.getState().synced({ ...theirs, limits: { ...theirs.limits, FENCE_ALT_MAX: 60 } });
    expect(fenceSync(useFence.getState()).same).toBe(true);
    expect(useFence.getState().edited).toBe(false);
  });

  it("compares zones by what would be sent, not by their names here", () => {
    useFence.getState().addZone(zone("mine"));
    useFence.getState().synced({ zones: [zone("theirs")], limits: { ...DEFAULT_LIMITS }, at: 1, notes: [] });
    expect(fenceSync(useFence.getState()).zonesDiffer).toBe(false);
  });
});
