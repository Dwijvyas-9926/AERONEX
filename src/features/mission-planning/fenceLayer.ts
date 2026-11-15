import type { FenceZone, ZoneRole } from "../../geo/fence";
import type { LatLon } from "../../geo/geo";

/*
  What a map needs to draw the fence and let it be edited, the same for the
  real map and the practice field. The page owns the fence; the maps only
  report what the pointer did.
*/

/** A zone being drawn: the corners placed so far, or a circle's centre. */
export interface FenceDrawing {
  shape: "polygon" | "circle";
  role: ZoneRole;
  points: LatLon[];
}

export type DragPhase = "start" | "move" | "end";

export interface FenceLayer {
  zones: FenceZone[];
  selected: string | null;
  /** Zones with a problem: drawn dashed. */
  bad: string[];
  drawing: FenceDrawing | null;
  /** The Fence tab is open: zones can be picked and their handles dragged. */
  editing: boolean;
  onSelect?: (id: string | null) => void;
  onVertex?: (id: string, i: number, to: LatLon, phase: DragPhase) => void;
  /** Add a corner before corner i, at the middle of the edge that ends there. */
  onInsert?: (id: string, i: number, at: LatLon) => void;
  onRemoveVertex?: (id: string, i: number) => void;
  onCentre?: (id: string, to: LatLon, phase: DragPhase) => void;
  onRadius?: (id: string, radiusM: number, phase: DragPhase) => void;
  /** The first corner of the shape being drawn was clicked: close it. */
  onClose?: () => void;
}

export const ZONE_COLOR = { in: "#2f7d4f", out: "#c0392b" } as const;
