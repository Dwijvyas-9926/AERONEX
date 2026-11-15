/*
  Frame Studio — what colour each part is drawn in.

  Kept out of the 3D component on purpose. That module pulls in three.js and
  is loaded lazily, so the page cannot import a palette from it without
  dragging a megabyte of renderer along to draw four swatches in a legend.

  Colour says which part it is; the material shows in the finish instead —
  metalness and roughness, which is where a material actually reads. Carrying
  both on colour was tried and failed at both jobs: carbon is a near-black
  #3a352f, so a carbon frame rendered as a silhouette, and four parts sharing
  one shade cannot tell a reader which piece is which.

  The hues are picked to stay apart on the light ground the solid view uses,
  and to differ in lightness as well as hue so they survive being looked at
  by someone who does not separate red from green.
*/

export interface PartLook {
  color: string;
  label: string;
}

export const PART_LOOK: Record<string, PartLook> = {
  "bottom-plate": { color: "#3f6b86", label: "Bottom plate" },
  chassis: { color: "#3f6b86", label: "Chassis" },
  arm: { color: "#c08436", label: "Arms" },
  "top-plate": { color: "#7d5a86", label: "Top plate" },
  "deck-plate": { color: "#a8554e", label: "Battery deck" },
  "camera-plate": { color: "#4f8257", label: "Camera mount" },
};

const FALLBACK: PartLook = { color: "#8a6a4e", label: "Part" };

/**
 * The palette entry for a part id.
 *
 * Every arm variant shares the arm colour: a dead cat has "arm-long" and
 * "arm-short", and coding them differently would say they are different kinds
 * of thing when they are the same part at two lengths.
 */
export function lookForPart(id: string): PartLook {
  if (id.startsWith("arm")) return PART_LOOK.arm;
  return PART_LOOK[id] ?? { ...FALLBACK, label: id };
}

/*
  Colour says which part it is; finish says what it is made of.

  These were both carried by colour once — every part took the material's own
  shade — and it failed at both jobs. Carbon is a near-black #3a352f, and on
  the dark background this view used to have, a carbon frame was a silhouette
  with no readable detail at all. Worse, the one thing a reader most needs
  from an exploded assembly is which piece is which, and four parts in one
  colour cannot say that.

  So the palette below identifies the part, and the material comes through in
  metalness and roughness, which is where it actually shows: aluminium stays
  bright and specular, plywood and nylon stay flat, acrylic stays glassy.
*/
/** Surface finish by material. Colour is the part's; this is the material's. */
export const MATERIAL_FINISH: Record<string, { metalness: number; roughness: number }> = {
  "cf-plate": { metalness: 0.25, roughness: 0.38 },
  g10: { metalness: 0.05, roughness: 0.6 },
  "alu-6061": { metalness: 0.85, roughness: 0.3 },
  "ply-birch": { metalness: 0, roughness: 0.9 },
  acrylic: { metalness: 0.05, roughness: 0.12 },
  "pa-cf": { metalness: 0.04, roughness: 0.85 },
  "pa12-cf": { metalness: 0.04, roughness: 0.85 },
  petg: { metalness: 0.04, roughness: 0.5 },
  pla: { metalness: 0, roughness: 0.75 },
};
export const FALLBACK_FINISH = { metalness: 0.05, roughness: 0.65 };

/** The studio's lights and ground, shared with the build report's renders. */
export const STUDIO = {
  background: "#ece7dd",
  ambient: 0.85,
  ambientColor: "#fff6e8",
  key: 1.35,
  keyColor: "#fffaf0",
  fill: 0.5,
  fillColor: "#cfd8e4",
  standoff: "#b9b4aa",
};
