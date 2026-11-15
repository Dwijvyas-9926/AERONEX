import { type FrameDesign, type Profile } from "./geometry";

/*
  Where every part of the frame sits when it is put together.

  One answer, used by the solid view on screen and by the pictures in the
  build report. Worked out separately they would drift, and a report whose
  picture disagrees with the screen it came from is worse than no picture.

  Every height comes from the design's own stack-up table. The scene's zero
  is the underside of the bottom plate, so everything in that table, which is
  measured from the underside of the arms, is lifted by the bottom plate's
  thickness on a bolted frame. Units are millimetres; profiles are drawn in
  XY and extruded along +Z, with +Y forward.
*/

/** A part lying flat: extruded up from height `z`, turned `rotation` about the centre, slid `shift` along its own X. */
export interface FlatPart {
  profile: Profile;
  z: number;
  rotation: number;
  shift: number;
}

/** A camera side plate, stood on edge across the frame at (x, y), its middle at height z. */
export interface StandingPart {
  profile: Profile;
  x: number;
  y: number;
  z: number;
}

export interface Standoff {
  x: number;
  y: number;
  z0: number;
  h: number;
  r: number;
}

export interface Assembly {
  flat: FlatPart[];
  standing: StandingPart[];
  /** Left out of the exploded view, where the gaps they would span are not real. */
  standoffs: Standoff[];
  /** Furthest any part reaches from the centre in plan, mm. */
  reach: number;
  /** Height of the tallest part, mm. */
  height: number;
  /** Height of the highest plate, mm: where the camera aims. */
  topZ: number;
}

export function assemble(d: FrameDesign, exploded: boolean): Assembly {
  const base = d.profiles.find((p) => p.id === "chassis" || p.id === "bottom-plate")!;
  const top = d.profiles.find((p) => p.id === "top-plate")!;
  const armParts = d.profiles.filter((p) => p.cantileverMm !== undefined);
  const cam = d.profiles.find((p) => p.id === "camera-plate");
  const deck = d.profiles.find((p) => p.id === "deck-plate");

  const unibody = armParts.length === 0;
  const armT = armParts[0]?.thicknessMm ?? base.thicknessMm;
  const lift = unibody ? 0 : base.thicknessMm;
  const gap = exploded ? Math.max(18, armT * 3) : 0;
  const zArm = lift + gap;
  const zTop = lift + d.stackUp.topPlateZMm + gap * 2;
  const zDeck = d.stackUp.deckZMm === null ? null : lift + d.stackUp.deckZMm + gap * 4;
  const zCamera = zTop + top.thicknessMm + gap;
  const shift = d.rootRadiusMm - d.armOverlapMm;

  const flat: FlatPart[] = [{ profile: base, z: 0, rotation: 0, shift: 0 }];
  for (const part of armParts) {
    const bearings = d.armGroups.find((g) => g.id === part.id)?.bearings ?? [];
    for (const b of bearings) flat.push({ profile: part, z: zArm, rotation: b, shift });
  }
  flat.push({ profile: top, z: zTop, rotation: 0, shift: 0 });
  if (deck && zDeck !== null) flat.push({ profile: deck, z: zDeck, rotation: 0, shift: 0 });

  /*
    The camera plates stand on the top plate. The body's midpoint sits half
    its height above that plate's top face, which puts the tab bottoms
    exactly in the slots cut for them.
  */
  const standing: StandingPart[] =
    cam && d.cameraMount
      ? [-1, 1].map((side) => ({
          profile: cam,
          x: (side * d.cameraMount!.spacingMm) / 2,
          y: d.cameraMount!.centreYMm,
          z: zCamera + d.cameraMount!.heightMm / 2,
        }))
      : [];

  // Standoffs, drawn where the plates' own holes say they go.
  const standoffs: Standoff[] = [];
  if (!exploded) {
    if (d.stackUp.topStandoffMm > 0) {
      for (const h of top.holes) standoffs.push({ x: h.c[0], y: h.c[1], z0: zTop - d.stackUp.topStandoffMm, h: d.stackUp.topStandoffMm, r: h.r * 1.8 });
    }
    if (deck && zDeck !== null) {
      for (const h of deck.holes) standoffs.push({ x: h.c[0], y: h.c[1], z0: zTop + top.thicknessMm, h: d.stackUp.deckStandoffMm, r: h.r * 1.8 });
    }
  }

  const reach = Math.max(...d.motors.map((m) => Math.hypot(m[0], m[1]))) + d.section.padWidthMm;
  const height = (zDeck ?? zTop) + (deck?.thicknessMm ?? top.thicknessMm) + (d.cameraMount?.heightMm ?? 0);
  return { flat, standing, standoffs, reach, height, topZ: zDeck ?? zTop };
}
