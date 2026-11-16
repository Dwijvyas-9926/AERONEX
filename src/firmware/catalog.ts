/*
  Which ArduPilot firmware fits a board, and fetching the latest stable
  release of it from ArduPilot's firmware server.

  Only stable releases are offered: the server's Copter/stable/<board>/
  folder always holds the latest official release, and its
  firmware-version.txt says so ("4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL").
  Anything that does not say OFFICIAL is refused.

  The server does not let web pages on other sites download from it (no
  CORS headers), so AERONEX's own server passes the request on
  (ardupilot-firmware/ → https://firmware.ardupilot.org/, set up in
  vite.config.ts for `npm run dev` and `npm run preview`). Where AERONEX is
  served without it, the page says so and links the file to download by hand.
*/
import { ApjError, parseApj, type Apj } from "./apj";
import { BOARDS, type BoardBuild } from "./boards.generated";
import { chipLimitedTo1M, type BoardInfo } from "./bootloader";

export const FIRMWARE_SERVER = "https://firmware.ardupilot.org";
const PROXY = "ardupilot-firmware/";

export type VehicleKind = "copter" | "heli";
export const VEHICLES: { id: VehicleKind; label: string; detail: string }[] = [
  { id: "copter", label: "Multicopter", detail: "Quad, hexa, octa, Y6 and other multirotors (ArduCopter)" },
  { id: "heli", label: "Helicopter", detail: "Traditional single or dual rotor helicopters (ArduCopter Heli)" },
];

/** Board ids whose bootloader accepts firmware built for another id, as uploader.py lists them. */
const COMPATIBLE: Record<number, number> = { 33: 9 };

/** What a build-name suffix means, for the list of other builds. */
export function variantNote(platform: string): string | null {
  if (/-bdshot$/i.test(platform)) return "with bi-directional DShot (ESC telemetry over the signal wire, for BLHeli32/AM32 ESCs)";
  if (/-1M(-|$)/.test(platform)) return "for chips limited to 1 MB of flash; fewer features";
  if (/SimOnHardWare/i.test(platform)) return "runs the simulator on the board, for bench testing only — it does not fly";
  if (/-ODID$/i.test(platform)) return "with Open Drone ID (Remote ID) built in";
  if (/^fmuv[23]/.test(platform)) return "older name of the Pixhawk1 builds";
  if (/solo/i.test(platform)) return "for a Cube fitted in a 3DR Solo";
  return null;
}

export interface Candidate {
  platform: string;
  build: BoardBuild;
  /** Why it is the pick, or what it is instead. */
  note: string | null;
}

export interface Recommendation {
  boardId: number;
  /** The build to install, or null when ArduPilot has none for this board id. */
  pick: Candidate | null;
  /** Other builds for the same board id, recommended one first. */
  others: Candidate[];
  /** Notes about the choice the user should see (the 1 MB question). */
  notes: string[];
  /**
    Different boards that report this same board id and bootloader USB id,
    so the bootloader cannot say which one it is: the user has to choose.
    Empty when the board is known.
  */
  choose: string[];
}

const rank = (p: string) => (variantNote(p) ? 1 : 0) * 100 + p.length;

/**
  Pick the build for a board from what its bootloader reports and the USB id
  it shows. Boards sharing a board id are told apart by USB id where they
  have their own; the Pixhawk1 family by whether its chip can use 2 MB.
*/
export function recommend(info: Pick<BoardInfo, "boardId" | "flashSize" | "chip">, usb?: { vendor?: number; product?: number }): Recommendation {
  const id = info.boardId;
  const builds = BOARDS[id] ?? BOARDS[COMPATIBLE[id]] ?? [];
  const notes: string[] = [];
  if (!builds.length) return { boardId: id, pick: null, others: [], notes, choose: [] };
  let pool = builds.filter((b) => !/SimOnHardWare/i.test(b.platform));
  // Boards sharing a board id often have bootloaders with their own USB ids (CubePilot, Holybro…): keep those that match.
  if (usb?.vendor !== undefined) {
    const own = pool.filter((b) => b.bl && b.bl[0] === usb.vendor && b.bl[1] === usb.product);
    if (own.length) pool = own;
  }
  let pick: BoardBuild | undefined;
  if (id === 9 && !(usb?.vendor === 0x2dae)) {
    // The Pixhawk1 family (Pixhawk 2.4.x and clones): 2 MB firmware only on chips that can use 2 MB.
    const limited = chipLimitedTo1M(info.chip);
    const small = info.flashSize <= 1024 * 1024;
    const p1 = pool.find((b) => b.platform === "Pixhawk1");
    const p1m = pool.find((b) => b.platform === "Pixhawk1-1M");
    if (limited === true || small) {
      pick = p1m;
      notes.push(limited ? "This board's processor is an early STM32F427 revision that can only use 1 MB of its flash (ST errata 2.1.10), so it needs the Pixhawk1-1M build." : "This board's bootloader offers 1 MB of flash, so it needs the Pixhawk1-1M build.");
    } else if (limited === false) {
      pick = p1;
      notes.push("The processor can use its full 2 MB of flash, so the full Pixhawk1 build fits.");
    } else {
      // An old bootloader that cannot report the chip revision: the 1 MB build works on every Pixhawk1.
      pick = p1m;
      notes.push("This bootloader is too old to report the processor revision, so AERONEX picks the Pixhawk1-1M build, which works on every Pixhawk1-type board. If the board then reports “2M flash - use Pixhawk1 firmware”, install the Pixhawk1 build from the other builds.");
    }
  }
  const sorted = [...pool].sort((a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform));
  // Builds that are boards in their own right, not a variant (-bdshot, -1M…) of another.
  const distinct = sorted.filter((b) => !variantNote(b.platform)).map((b) => b.platform);
  let choose: string[] = [];
  if (!pick && distinct.length > 1) {
    // Mission Planner asks too: guessing here could put another board's pin map on this one.
    choose = distinct;
    notes.push(`Board id ${id} is used by ${distinct.length} different boards, and the bootloader cannot say which one this is. Choose yours.`);
  } else if (pick && distinct.length > 1 && id === 9) {
    const rest = distinct.filter((p) => p !== "Pixhawk1");
    if (rest.length) notes.push(`Board id 9 is also used by ${rest.join(", ")}. If the board is one of those, choose it from the builds.`);
  }
  if (!choose.length) pick ??= sorted[0];
  const others = builds.filter((b) => b !== pick).sort((a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform));
  return {
    boardId: id,
    pick: pick ? { platform: pick.platform, build: pick, note: variantNote(pick.platform) } : null,
    others: others.map((b) => ({ platform: b.platform, build: b, note: variantNote(b.platform) })),
    notes,
    choose,
  };
}

/** Folder and file of the latest stable build for a board. */
export function stablePath(platform: string, vehicle: VehicleKind): { dir: string; file: string } {
  return vehicle === "heli" ? { dir: `Copter/stable/${platform}-heli/`, file: "arducopter-heli.apj" } : { dir: `Copter/stable/${platform}/`, file: "arducopter.apj" };
}

export const serverUrl = (path: string) => `${FIRMWARE_SERVER}/${path}`;

export class FirmwareSourceError extends Error {
  /** The page on the firmware server to download from by hand. */
  manualUrl: string;
  kind: "unreachable" | "missing" | "not-stable";

  constructor(message: string, manualUrl: string, kind: "unreachable" | "missing" | "not-stable") {
    super(message);
    this.manualUrl = manualUrl;
    this.kind = kind;
  }
}

/** A file every stable release has, to tell the firmware server from anything else answering. */
const PROBE = "Copter/stable/Pixhawk1/firmware-version.txt";
let base: Promise<string | null> | null = null;

/**
  Where the firmware server can be reached from this page: through AERONEX's
  own server, or directly (should it ever allow it), or null. Worked out once
  by asking for a file that is always there and checking what comes back, so
  a static host's own pages are never mistaken for it.
*/
export function firmwareBase(signal?: AbortSignal): Promise<string | null> {
  base ??= (async () => {
    const tries = [typeof document !== "undefined" ? new URL(PROXY, document.baseURI).href : null, `${FIRMWARE_SERVER}/`].filter(Boolean) as string[];
    for (const b of tries) {
      try {
        const r = await fetch(b + PROBE, { signal, cache: "no-store" });
        if (r.ok && parseFirmwareVersion(await r.text())) return b;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") throw e;
      }
    }
    return null;
  })();
  const p = base;
  // A failed attempt is tried again next time (the connection may come back).
  void p.then((b) => {
    if (b === null && base === p) base = null;
  }, () => {
    if (base === p) base = null;
  });
  return p;
}

async function get(path: string, signal?: AbortSignal): Promise<Response | null> {
  const b = await firmwareBase(signal);
  if (!b) return null;
  try {
    return await fetch(b + path, { signal, cache: "no-store" });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") throw e;
    return null;
  }
}

export interface StableRelease {
  platform: string;
  vehicle: VehicleKind;
  /** "4.6.3" */
  version: string;
  /** "ArduCopter V4.6.3" from git-version.txt, when there. */
  title: string | null;
  apj: Apj;
  url: string;
  bytes: number;
}

/** "4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL" → its parts. */
export function parseFirmwareVersion(text: string): { version: string; type: string } | null {
  const m = /^\s*(\d+\.\d+\.\d+)-(FIRMWARE_VERSION_TYPE_[A-Z0-9_]+)\s*$/.exec(text);
  return m ? { version: m[1], type: m[2] } : null;
}

/** Download the latest stable build of a board's firmware and check it. */
export async function fetchStable(platform: string, vehicle: VehicleKind, onProgress?: (got: number, total: number) => void, signal?: AbortSignal): Promise<StableRelease> {
  const { dir, file } = stablePath(platform, vehicle);
  const manual = serverUrl(dir);
  const vr = await get(dir + "firmware-version.txt", signal);
  if (!vr) throw new FirmwareSourceError("AERONEX could not reach ArduPilot's firmware server. Check the internet connection, or download the firmware by hand and choose the file.", manual, "unreachable");
  if (vr.status === 404) throw new FirmwareSourceError(`ArduPilot publishes no stable ${vehicle === "heli" ? "helicopter" : "Copter"} firmware for ${platform}.`, serverUrl("Copter/stable/"), "missing");
  if (!vr.ok) throw new FirmwareSourceError(`The firmware server answered ${vr.status}. Try again in a minute, or download the firmware by hand.`, manual, "unreachable");
  const fv = parseFirmwareVersion(await vr.text());
  if (!fv) throw new FirmwareSourceError("The firmware server's version file could not be read.", manual, "unreachable");
  if (fv.type !== "FIRMWARE_VERSION_TYPE_OFFICIAL") throw new FirmwareSourceError(`The firmware in the stable folder is marked ${fv.type.replace("FIRMWARE_VERSION_TYPE_", "").toLowerCase()}, not an official release, so AERONEX will not install it.`, manual, "not-stable");
  let title: string | null = null;
  const gv = await get(dir + "git-version.txt", signal).catch(() => null);
  if (gv?.ok) title = /APMVERSION:\s*(.+)/.exec(await gv.text())?.[1].trim() ?? null;
  const fr = await get(dir + file, signal);
  if (!fr || !fr.ok) throw new FirmwareSourceError(`The firmware file ${file} could not be downloaded.`, manual, fr?.status === 404 ? "missing" : "unreachable");
  const total = Number(fr.headers.get("content-length") ?? 0);
  let text: string;
  if (fr.body && onProgress) {
    const reader = fr.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(got, total);
    }
    text = new TextDecoder().decode(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
  } else text = await fr.text();
  let apj: Apj;
  try {
    apj = await parseApj(text);
  } catch (e) {
    throw new FirmwareSourceError(e instanceof ApjError ? e.message : "The downloaded firmware could not be read.", manual, "unreachable");
  }
  if (title && !title.includes(fv.version)) title = null;
  return { platform, vehicle, version: fv.version, title, apj, url: serverUrl(dir + file), bytes: text.length };
}

/** Problems that stop this firmware going onto this board, or null when it fits. */
export function checkFits(apj: Apj, info: BoardInfo): string | null {
  const id = COMPATIBLE[info.boardId] === apj.boardId ? apj.boardId : info.boardId;
  if (apj.boardId !== id) {
    const fw = (BOARDS[apj.boardId] ?? []).map((b) => b.platform).slice(0, 3).join(", ");
    const bd = (BOARDS[info.boardId] ?? []).map((b) => b.platform).slice(0, 3).join(", ");
    return `This firmware is for board id ${apj.boardId}${fw ? ` (${fw})` : ""}, but the board is id ${info.boardId}${bd ? ` (${bd})` : ""}. Installing it would not boot.`;
  }
  if (apj.imageSize > info.flashSize) {
    return `The firmware is ${(apj.imageSize / 1024).toFixed(0)} KB but the board has room for ${(info.flashSize / 1024).toFixed(0)} KB.${info.boardId === 9 ? " Use the Pixhawk1-1M build." : ""}`;
  }
  if (apj.extfImageSize > info.extfSize) return "The firmware has a part for external flash that this board does not have.";
  return null;
}
