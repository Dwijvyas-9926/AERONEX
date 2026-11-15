import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_LIMITS, limitsDiffer, sameZones, snap, type FenceLimits, type FenceZone } from "../geo/fence";
import type { LatLon } from "../geo/geo";

/*
  The fence being planned, and the one the aircraft holds.

  The page edits a draft: the zones and the FENCE_* settings. Beside it is the
  aircraft's own fence as last read from it or sent to it, so the page can
  say whether the two are the same. A draft nobody has touched since it last
  matched the aircraft follows the aircraft; one that has been edited is
  kept, and the page offers to send it or to take the aircraft's instead.

  Kept in this browser like the plan, so a fence drawn at home is there on
  the field.
*/

export interface FenceSnapshot {
  zones: FenceZone[];
  limits: FenceLimits;
}

export interface AircraftFence extends FenceSnapshot {
  /** When it was read or sent. */
  at: number;
  /** Notes from reading it, such as a return point set aside. */
  notes: string[];
}

interface FenceState extends FenceSnapshot {
  aircraft: AircraftFence | null;
  /** The draft has been changed by hand since it last matched the aircraft. */
  edited: boolean;
  selected: string | null;
  past: FenceSnapshot[];
  future: FenceSnapshot[];

  /** Start a change that may take many small steps (a drag): one undo for all of it. */
  begin: () => void;
  setLimit: <K extends keyof FenceLimits>(k: K, v: FenceLimits[K]) => void;
  addZone: (z: FenceZone) => void;
  updateZone: (id: string, patch: Partial<FenceZone>, record?: boolean) => void;
  removeZone: (id: string) => void;
  moveVertex: (id: string, i: number, to: LatLon, record?: boolean) => void;
  insertVertex: (id: string, i: number, at: LatLon) => void;
  removeVertex: (id: string, i: number) => void;
  clearZones: () => void;
  select: (id: string | null) => void;
  /** Make the draft the aircraft's fence (read from it). */
  adopt: (f: AircraftFence, asDraft: boolean) => void;
  /** The draft has just been sent and read back the same. */
  synced: (f: AircraftFence) => void;
  /** The link to the aircraft has gone: what it holds is no longer known. */
  forgetAircraft: () => void;
  undo: () => void;
  redo: () => void;
}

const HISTORY = 60;
const snapshot = (s: FenceSnapshot): FenceSnapshot => ({ zones: s.zones, limits: s.limits });

export const useFence = create<FenceState>()(
  persist(
    (set) => {
      const edit = (change: (s: FenceState) => Partial<FenceState>, record = true) =>
        set((s) => ({ ...(record ? { past: [...s.past, snapshot(s)].slice(-HISTORY), future: [] } : {}), ...change(s), edited: true }));
      const mapZone = (id: string, f: (z: FenceZone) => FenceZone) => (s: FenceState) => ({ zones: s.zones.map((z) => (z.id === id ? f(z) : z)) });
      return {
        zones: [],
        limits: { ...DEFAULT_LIMITS },
        aircraft: null,
        edited: false,
        selected: null,
        past: [],
        future: [],

        begin: () => set((s) => ({ past: [...s.past, snapshot(s)].slice(-HISTORY), future: [] })),
        setLimit: (k, v) => edit((s) => ({ limits: { ...s.limits, [k]: v } })),
        addZone: (z) => edit((s) => ({ zones: [...s.zones, z], selected: z.id })),
        updateZone: (id, patch, record = true) => edit(mapZone(id, (z) => ({ ...z, ...patch }) as FenceZone), record),
        removeZone: (id) => edit((s) => ({ zones: s.zones.filter((z) => z.id !== id), selected: s.selected === id ? null : s.selected })),
        moveVertex: (id, i, to, record = true) =>
          edit(mapZone(id, (z) => (z.shape === "polygon" ? { ...z, points: z.points.map((p, k) => (k === i ? snap(to) : p)) } : z)), record),
        insertVertex: (id, i, at) => edit(mapZone(id, (z) => (z.shape === "polygon" ? { ...z, points: [...z.points.slice(0, i), snap(at), ...z.points.slice(i)] } : z))),
        removeVertex: (id, i) =>
          // A shape keeps three corners: fewer is not an area.
          edit(mapZone(id, (z) => (z.shape === "polygon" && z.points.length > 3 ? { ...z, points: z.points.filter((_, k) => k !== i) } : z))),
        clearZones: () => edit(() => ({ zones: [], selected: null })),
        select: (id) => set({ selected: id }),
        adopt: (f, asDraft) =>
          set((s) => ({
            aircraft: f,
            ...(asDraft ? { past: [...s.past, snapshot(s)].slice(-HISTORY), future: [], zones: f.zones, limits: f.limits, edited: false, selected: null } : {}),
          })),
        synced: (f) => set({ aircraft: f, edited: false }),
        forgetAircraft: () => set({ aircraft: null }),
        undo: () =>
          set((s) => {
            const prev = s.past[s.past.length - 1];
            if (!prev) return {};
            return { past: s.past.slice(0, -1), future: [snapshot(s), ...s.future].slice(0, HISTORY), ...prev, edited: true, selected: prev.zones.some((z) => z.id === s.selected) ? s.selected : null };
          }),
        redo: () =>
          set((s) => {
            const next = s.future[0];
            if (!next) return {};
            return { future: s.future.slice(1), past: [...s.past, snapshot(s)].slice(-HISTORY), ...next, edited: true };
          }),
      };
    },
    {
      name: "aeronex.fence.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ zones: s.zones, limits: s.limits, edited: s.edited }),
    },
  ),
);

/** How the draft stands against the aircraft. */
export function fenceSync(s: Pick<FenceState, "zones" | "limits" | "aircraft">): { known: boolean; same: boolean; zonesDiffer: boolean; limitsDiffer: (keyof FenceLimits)[] } {
  if (!s.aircraft) return { known: false, same: false, zonesDiffer: false, limitsDiffer: [] };
  const zonesDiffer = !sameZones(s.zones, s.aircraft.zones);
  const differ = limitsDiffer(s.limits, s.aircraft.limits);
  return { known: true, same: !zonesDiffer && differ.length === 0, zonesDiffer, limitsDiffer: differ };
}
