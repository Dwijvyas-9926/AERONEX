/*
  ArduPilot firmware files (.apj): JSON with the firmware image compressed
  (zlib) and base64-encoded, and the facts the uploader checks: which board
  it is for (board_id) and how big it is (image_size). Written by ArduPilot's
  build (Tools/ardupilotwaf/chibios.py) and read the same way as its
  uploader.py does. Some boards also carry an image for external flash.
*/

export interface Apj {
  boardId: number;
  boardRevision: number;
  /** The image, padded with 0xFF to a whole number of 4-byte words. */
  image: Uint8Array;
  imageSize: number;
  extfImage: Uint8Array | null;
  extfImageSize: number;
  /** The board name it was built for ("Pixhawk1"), when the file says. */
  summary: string | null;
  description: string | null;
  gitIdentity: string | null;
  buildTime: number | null;
  /** "0x1209/0x5740" pairs, when the file says. */
  usbIds: string[];
  signed: boolean;
}

export class ApjError extends Error {}

function base64Bytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** zlib (RFC 1950) inflate, with the browser's own decompressor. */
async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([z as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function padTo4(b: Uint8Array): Uint8Array {
  if (b.length % 4 === 0) return b;
  const out = new Uint8Array(b.length + (4 - (b.length % 4))).fill(0xff);
  out.set(b);
  return out;
}

export async function parseApj(text: string): Promise<Apj> {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    throw new ApjError("This is not an ArduPilot firmware file (.apj): it is not JSON. Use the .apj file, not .hex or .bin.");
  }
  if (typeof d !== "object" || d === null || typeof d.image !== "string" || typeof d.board_id !== "number") {
    throw new ApjError("This file has no firmware image or board id: it is not an ArduPilot .apj firmware file.");
  }
  if (d.magic !== undefined && d.magic !== "APJFWv1") throw new ApjError(`Unknown firmware file format "${String(d.magic)}".`);
  let raw: Uint8Array;
  try {
    raw = await inflate(base64Bytes(d.image));
  } catch {
    throw new ApjError("The firmware image in this file is damaged and could not be unpacked.");
  }
  const imageSize = typeof d.image_size === "number" ? d.image_size : raw.length;
  if (raw.length !== imageSize) throw new ApjError(`The firmware image is ${raw.length} bytes but the file says ${imageSize}: the file is damaged.`);
  let extf: Uint8Array | null = null;
  const extfSize = typeof d.extf_image_size === "number" ? d.extf_image_size : 0;
  if (typeof d.extf_image === "string" && d.extf_image) {
    try {
      const e = await inflate(base64Bytes(d.extf_image));
      if (e.length) extf = padTo4(e);
    } catch {
      throw new ApjError("The external-flash image in this file is damaged and could not be unpacked.");
    }
  }
  if (extfSize > 0 && (!extf || extf.length < extfSize)) throw new ApjError("The external-flash image is shorter than the file says: the file is damaged.");
  return {
    boardId: d.board_id,
    boardRevision: typeof d.board_revision === "number" ? d.board_revision : 0,
    image: padTo4(raw),
    imageSize,
    extfImage: extf,
    extfImageSize: extfSize,
    summary: typeof d.summary === "string" ? d.summary : null,
    description: typeof d.description === "string" ? d.description : null,
    gitIdentity: typeof d.git_identity === "string" ? d.git_identity : null,
    buildTime: typeof d.build_time === "number" ? d.build_time : null,
    usbIds: Array.isArray(d.USBID) ? d.USBID.map(String) : typeof d.USBID === "string" ? [d.USBID] : [],
    signed: d.signed_firmware === true,
  };
}
