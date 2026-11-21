import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The first-run setup: the operator's name, kept on this computer, and the
  starter aircraft that a new install no longer names after the team that
  built AERONEX.
*/

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memStorage());
});
describe("operator", () => {
  it("is not set up until the welcome screen is finished, then remembers the name", async () => {
    const { useOperator } = await import("../operatorStore");
    expect(useOperator.getState().setupAt).toBeNull();
    useOperator.getState().finishSetup("  Dwij   Vyas ", " Team  Avion ");
    expect(useOperator.getState()).toMatchObject({
      name: "Dwij Vyas",
      team: "Team Avion",
    });
    expect(useOperator.getState().setupAt).not.toBeNull();
    expect(
      JSON.parse(localStorage.getItem("aeronex.operator.v1")!).state.name,
    ).toBe("Dwij Vyas");
  });

  it("never lets the name be emptied from Settings, but the team can be", async () => {
    const { useOperator } = await import("../operatorStore");
    useOperator.getState().finishSetup("Dwij", "Avion");
    useOperator.getState().update({ name: "   ", team: "" });
    expect(useOperator.getState()).toMatchObject({ name: "Dwij", team: "" });
  });

  it("caps names at 48 characters", async () => {
    const { cleanName } = await import("../operatorStore");
    expect(cleanName("x".repeat(80))).toHaveLength(48);
  });
});

describe("the starter aircraft", () => {
  it("a new install starts with a neutral name and knows it is new", async () => {
    const { useProfiles, hadProfilesAtStart, SEED_NAME } =
      await import("../profileStore");
    expect(SEED_NAME).toBe("My aircraft");
    expect(useProfiles.getState().profiles.map((p) => p.name)).toEqual([
      "My aircraft",
    ]);
    expect(hadProfilesAtStart).toBe(false);
  });

  it("a computer that already had aircraft keeps them, and is recognised", async () => {
    localStorage.setItem(
      "avion.profiles.v1",
      JSON.stringify({
        state: {
          profiles: [
            {
              id: "a",
              name: "Avion",
              frame: "quad-x",
              firmware: "ardupilot",
              board: "pixhawk-2.4.8",
              massGrams: 2400,
              diagonalMm: 550,
              notes: "",
              model: { source: "default" },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          activeId: "a",
        },
        version: 1,
      }),
    );
    const { useProfiles, hadProfilesAtStart } = await import("../profileStore");
    expect(hadProfilesAtStart).toBe(true);
    expect(useProfiles.getState().profiles.map((p) => p.name)).toEqual([
      "Avion",
    ]);
  });
});
