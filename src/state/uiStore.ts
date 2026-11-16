import { create } from "zustand";

/* Which of the app-wide overlays is open. Only one at a time. */
export type Overlay = "help" | "search" | "assistant";

interface UiState {
  overlay: Overlay | null;
  open: (o: Overlay) => void;
  toggle: (o: Overlay) => void;
  close: () => void;
}

export const useUi = create<UiState>((set) => ({
  overlay: null,
  open: (overlay) => set({ overlay }),
  toggle: (o) => set((s) => ({ overlay: s.overlay === o ? null : o })),
  close: () => set({ overlay: null }),
}));
