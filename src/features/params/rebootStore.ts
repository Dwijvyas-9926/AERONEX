import { create } from "zustand";

/*
  Settings written this session that ArduPilot applies only after a reboot.
  Kept outside the page so the reminder survives moving between pages, and
  cleared when the link closes (a new link may be a rebooted controller).
*/
interface RebootState {
  names: string[];
  add: (names: string[]) => void;
  clear: () => void;
}

export const useRebootNeeded = create<RebootState>((set) => ({
  names: [],
  add: (names) => set((s) => ({ names: [...new Set([...s.names, ...names])].sort() })),
  clear: () => set({ names: [] }),
}));
