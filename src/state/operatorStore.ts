import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/*
  Who uses this copy of AERONEX: the name given in the first-run setup, and
  an optional team. Kept on this computer only, with everything else the app
  stores; there are no accounts and nothing is sent anywhere.

  `setupAt` is null until the welcome screen has been completed, which is
  what makes it appear on first launch, and again after "Reset app data".
*/
export interface OperatorState {
  name: string;
  team: string;
  setupAt: number | null;
  finishSetup: (name: string, team: string) => void;
  update: (patch: { name?: string; team?: string }) => void;
}

export const OPERATOR_NAME_MAX = 48;

export const cleanName = (s: string) =>
  s.replace(/\s+/g, " ").trim().slice(0, OPERATOR_NAME_MAX);

export const useOperator = create<OperatorState>()(
  persist(
    (set) => ({
      name: "",
      team: "",
      setupAt: null,
      finishSetup: (name, team) =>
        set({
          name: cleanName(name),
          team: cleanName(team),
          setupAt: Date.now(),
        }),
      update: (patch) =>
        set((s) => ({
          name:
            patch.name !== undefined ? cleanName(patch.name) || s.name : s.name,
          team: patch.team !== undefined ? cleanName(patch.team) : s.team,
        })),
    }),
    {
      name: "aeronex.operator.v1",
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);
