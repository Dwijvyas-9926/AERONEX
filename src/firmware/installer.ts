/*
  The firmware installer: finds the board's bootloader over USB, works out
  which ArduPilot build fits it, downloads the latest stable release, and
  writes it: erase, program, verify, restart. The steps and their checks
  are ArduPilot's own (uploader.py); the board never runs anything that was
  not verified byte for byte by its own CRC.

  Getting to the bootloader:
  - A board running ArduPilot and linked to AERONEX is told to restart and
    stay in its bootloader (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, param 1 = 3),
    which then waits indefinitely.
  - Any other board answers in its bootloader for a few seconds after it is
    plugged in. The browser only lets a page open a port the user has picked,
    so the first time the user picks it from Chrome's list as it appears;
    after that AERONEX has permission and opens it the moment it is plugged in.
  - A board picked while running its firmware is sent the same restart
    command over the port, and the bootloader picked or caught after it.
*/
import { useParams } from "../state/paramStore";
import { create } from "zustand";
import { encode } from "../mavlink/encode";
import { commandLink } from "../services/link/commandLink";
import { linkManager } from "../services/link/linkManager";
import { useLink } from "../state/linkStore";
import { ApjError, parseApj, type Apj } from "./apj";
import { BOARDS, USB_VENDORS } from "./boards.generated";
import { Bootloader, BootloaderError, type BoardInfo, type Phase } from "./bootloader";
import { checkFits, fetchStable, FirmwareSourceError, recommend, stablePath, serverUrl, type Recommendation, type StableRelease, type VehicleKind } from "./catalog";
import { SerialByteLink } from "./serialLink";

export type Step = "start" | "waiting" | "board" | "installing" | "done";

export interface InstallError {
  title: string;
  detail: string;
  /** Somewhere to download the firmware by hand. */
  manualUrl?: string;
}

export interface Installed {
  platform: string;
  version: string | null;
  title: string | null;
  seconds: number;
  bytes: number;
}

interface FirmwareState {
  step: Step;
  vehicle: VehicleKind;
  /** What is happening, in a sentence. */
  status: string;
  waitingFor: "plug" | "reboot" | null;
  error: InstallError | null;
  portLabel: string | null;
  usb: { vendor?: number; product?: number } | null;
  info: BoardInfo | null;
  rec: Recommendation | null;
  platform: string | null;
  source: "stable" | "file";
  release: StableRelease | null;
  file: { name: string; apj: Apj } | null;
  download: { got: number; total: number } | null;
  /** Why the chosen firmware cannot go on this board, or null. */
  problem: string | null;
  progress: { phase: Phase; share: number } | null;
  installed: Installed | null;
}

const initial = (vehicle: VehicleKind = "copter"): FirmwareState => ({
  step: "start",
  vehicle,
  status: "",
  waitingFor: null,
  error: null,
  portLabel: null,
  usb: null,
  info: null,
  rec: null,
  platform: null,
  source: "stable",
  release: null,
  file: null,
  download: null,
  problem: null,
  progress: null,
  installed: null,
});

export const useFirmware = create<FirmwareState>(() => initial());
const set = (p: Partial<FirmwareState>) => useFirmware.setState(p);
const get = () => useFirmware.getState();

let link: SerialByteLink | null = null;
let bl: Bootloader | null = null;
let waitCancel: (() => void) | null = null;
let fetchAbort: AbortController | null = null;

const hasSerial = () => typeof navigator !== "undefined" && "serial" in navigator;

/** The USB ids Chrome's port list is limited to: every vendor ArduPilot boards use. */
const FILTERS = USB_VENDORS.map((usbVendorId) => ({ usbVendorId }));

const usbKey = (v?: number, p?: number) => `${v ?? -1}:${p ?? -1}`;
/** USB ids of flight controllers (firmware or bootloader), from ArduPilot's board definitions and the old PX4 ones. */
const FC_USB = new Set<string>([usbKey(0x26ac, 0x0010), usbKey(0x26ac, 0x0011), usbKey(0x26ac, 0x0012), usbKey(0x26ac, 0x0013), usbKey(0x0483, 0x5740)]);
/** USB ids that only a bootloader uses. */
const BL_USB = new Set<string>([usbKey(0x26ac, 0x0010), usbKey(0x26ac, 0x0011), usbKey(0x26ac, 0x0012), usbKey(0x26ac, 0x0013)]);
for (const builds of Object.values(BOARDS))
  for (const b of builds) {
    FC_USB.add(usbKey(...b.app));
    if (b.bl) {
      FC_USB.add(usbKey(...b.bl));
      BL_USB.add(usbKey(...b.bl));
    }
  }

/** A flight controller's USB port, running its firmware or its bootloader. */
export function isFlightControllerPort(info: SerialPortInfo) {
  return FC_USB.has(usbKey(info.usbVendorId, info.usbProductId));
}
function isBootloaderPort(info: SerialPortInfo) {
  return BL_USB.has(usbKey(info.usbVendorId, info.usbProductId));
}

async function closeLink() {
  const l = link;
  link = null;
  bl = null;
  await l?.close().catch(() => undefined);
}

function fail(title: string, detail: string, manualUrl?: string) {
  set({ error: { title, detail, manualUrl }, status: "" });
}

/** Reset to the start, closing the board's port. */
export async function startOver() {
  waitCancel?.();
  fetchAbort?.abort();
  await closeLink();
  useFirmware.setState(initial(get().vehicle));
}

export function setVehicle(v: VehicleKind) {
  set({ vehicle: v });
  if (get().step === "board" && get().source === "stable") void loadRelease();
}

/** The restart-and-stay-in-bootloader command, as raw MAVLink, for a port that is running firmware. */
function rebootToBootloaderPackets(): Uint8Array[] {
  // To system 1 (ArduPilot's default) and to every system, as uploader.py does.
  return [1, 0].map((target) =>
    encode(
      "COMMAND_LONG",
      { target_system: target, target_component: target ? 1 : 0, command: 246, confirmation: 0, param1: 3, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 },
      { sysid: 255, compid: 190 },
    ),
  );
}

/**
  Open a port and see whether a bootloader answers. Tries for `ms`, since a
  bootloader can take a moment after appearing. Returns true when the board
  was identified; false when something else (running firmware) is there,
  in which case it has been told to restart into its bootloader.
*/
async function attach(port: SerialPort, ms = 1500): Promise<boolean> {
  await closeLink();
  const info = port.getInfo();
  set({ portLabel: describe(info), usb: { vendor: info.usbVendorId, product: info.usbProductId }, status: "Talking to the board…" });
  const l = new SerialByteLink(port);
  try {
    await l.open(115200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BootloaderError(/already open|InvalidState/i.test(msg) ? "That port is already open, in AERONEX's own connection or another program (Mission Planner, QGroundControl, MAVProxy). Disconnect it there first." : `The port could not be opened: ${msg}`);
  }
  link = l;
  const b = new Bootloader(l);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await b.trySync(250)) {
      bl = b;
      return true;
    }
    if (l.lostReason) break;
  }
  if (l.lostReason) {
    await closeLink();
    throw new BootloaderError(`The board disconnected (${l.lostReason}).`);
  }
  if (!isFlightControllerPort(info)) {
    await closeLink();
    throw new BootloaderError("No bootloader answered, and this does not look like a flight controller's own USB port (a telemetry radio or USB-serial adapter cannot be used to install firmware). Plug the flight controller's USB port into the computer directly.");
  }
  // Running its firmware: ask it to restart into its bootloader. ArduPilot refuses while armed.
  for (const p of rebootToBootloaderPackets()) await l.write(p).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await closeLink();
  return false;
}

function describe(info: SerialPortInfo): string {
  const v = info.usbVendorId;
  const p = info.usbProductId;
  if (v === undefined) return "Serial device";
  const hex = (n?: number) => (n ?? 0).toString(16).padStart(4, "0").toUpperCase();
  const known: Record<string, string> = {
    "1209:5741": "ArduPilot bootloader",
    "1209:5740": "ArduPilot firmware",
    "26AC:0011": "PX4 bootloader (FMUv2)",
    "26AC:0010": "PX4 bootloader (FMUv1)",
  };
  return `${known[`${hex(v)}:${hex(p)}`] ?? "USB device"} (${hex(v)}:${hex(p)})`;
}

/** After the board answered: identify it, pick the build, fetch the firmware. */
async function onBootloader() {
  const b = bl!;
  set({ status: "Reading what board this is…" });
  const before = get();
  const info = await b.identify();
  const rec = recommend(info, get().usb ?? undefined);
  // The same board again (after a failed install): keep the build chosen and the firmware downloaded.
  const same = before.info && before.info.boardId === info.boardId && before.info.serial === info.serial && before.platform;
  const platform = same ? before.platform : (rec.pick?.platform ?? null);
  set({ step: "board", info, rec, platform, waitingFor: null, status: "" });
  if (same) {
    const r = before.release;
    if (before.source === "file" || (r && r.platform === platform && r.vehicle === before.vehicle)) return recheck();
    return loadRelease();
  }
  if (!rec.pick && rec.choose.length) return; // the user chooses the board; nothing is downloaded until then
  if (!rec.pick) {
    fail(
      "AERONEX does not know this board",
      `Its bootloader reports board id ${info.boardId}, which no ArduPilot flight-controller build uses. If ArduPilot supports it, download its .apj from the firmware server and install it from a file.`,
      serverUrl("Copter/stable/"),
    );
    return;
  }
  if (get().source === "stable") await loadRelease();
  else recheck();
}

/** Find the board through Chrome's port list (call from a click). */
export async function findBoard() {
  if (!hasSerial()) return fail("This browser cannot reach USB devices", "Installing firmware needs Web Serial: use Chrome or Edge on a computer.");
  if (linkManager.linkedPortInfo()) {
    return fail("AERONEX's connection has the port open", "Use Restart into bootloader to install over this connection, or disconnect first.");
  }
  set({ error: null });
  let port: SerialPort;
  try {
    port = await navigator.serial!.requestPort({ filters: FILTERS });
  } catch (e) {
    if ((e as DOMException)?.name === "NotFoundError") return; // closed the list
    return fail("The port list could not open", e instanceof Error ? e.message : String(e));
  }
  // A wait in progress would race this port; this one was picked by hand.
  waitCancel?.();
  try {
    if (await attach(port)) return await onBootloader();
    set({ step: "waiting", waitingFor: "reboot", status: "The board was running its firmware. AERONEX asked it to restart into its bootloader…" });
    await waitForBootloader(20000);
  } catch (e) {
    await closeLink();
    set({ step: "start", waitingFor: null });
    fail("The board did not respond", reason(e));
  }
}

/**
  Wait for a board this page already has permission for to appear (plugged
  in, or restarted into its bootloader), and catch it at once. Only ports
  with a flight controller's USB ids are opened.
*/
export async function waitForBootloader(ms = 60000) {
  if (!hasSerial()) return;
  waitCancel?.();
  const started = Date.now();
  if (get().step !== "waiting") set({ step: "waiting", waitingFor: "plug", status: "Plug the board in now." });
  const before = new Set(await navigator.serial!.getPorts());
  const lastTry = new WeakMap<SerialPort, number>();
  let done = false;
  let busy = false;
  return new Promise<void>((resolve) => {
    const stop = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      navigator.serial!.removeEventListener("connect", onConnect);
      waitCancel = null;
      resolve();
    };
    waitCancel = stop;
    const tryPort = async (port: SerialPort) => {
      if (done || busy || port.readable) return; // open already (AERONEX's own link)
      if (!isFlightControllerPort(port.getInfo())) return;
      const last = lastTry.get(port);
      if (last && Date.now() - last < 4000) return;
      lastTry.set(port, Date.now());
      busy = true;
      try {
        if (await attach(port, 2500)) {
          stop();
          await onBootloader().catch(async (e) => {
            await closeLink();
            fail("The board did not respond", reason(e));
          });
          return;
        }
        // It was running its firmware and has been told to restart; keep waiting for the bootloader.
        lastTry.set(port, Date.now() + 6000);
        set({ waitingFor: "reboot", status: "The board was running its firmware. AERONEX asked it to restart into its bootloader…" });
      } catch (e) {
        if (!done) set({ status: reason(e) });
      } finally {
        busy = false;
      }
    };
    const onConnect = (e: Event) => void tryPort(e.target as SerialPort);
    navigator.serial!.addEventListener("connect", onConnect);
    // Also look: the connect event is not sent for every way a port can appear.
    const poll = setInterval(async () => {
      if (done || busy) return;
      if (Date.now() - started > ms) {
        stop();
        const rebooting = get().waitingFor === "reboot";
        set({ step: "start", waitingFor: null });
        fail(
          rebooting ? "The bootloader did not connect by itself" : "No board appeared",
          rebooting
            ? "The board restarted into its bootloader, which shows up as a new USB device that this page has not been allowed to open yet. It waits there until you choose it: click Find the board and pick the entry with “BL” or “bootloader” in its name."
            : "AERONEX can only open a board you have picked once. Click Find the board, plug the board in, and choose it in the list. If it is running ArduPilot, AERONEX restarts it into its bootloader, which then waits for you.",
        );
        return;
      }
      for (const p of await navigator.serial!.getPorts()) {
        if (!before.has(p) || isBootloaderPort(p.getInfo())) {
          await tryPort(p);
          if (done) return;
        }
      }
    }, 400);
  });
}

/** "Wait for a board I have used before", from a click. */
export function waitForBoard() {
  set({ error: null });
  return waitForBootloader();
}

/** Stop waiting for the board. */
export function cancelWait() {
  waitCancel?.();
  set({ step: "start", waitingFor: null, status: "" });
}

/** For a board running ArduPilot and linked to AERONEX: restart it into its bootloader, then catch it. */
export async function restartLinkedIntoBootloader() {
  const s = useLink.getState();
  if (!s.vehicle || s.virtual) return fail("No aircraft linked", "Connect the board over USB first, or use Find the board.");
  if (s.vehicle.armed) return fail("The aircraft is armed", "Disarm before installing firmware.");
  // New firmware starts with the old settings: an ESC calibration left waiting would run on its first start.
  const esc = useParams.getState().values.ESC_CALIBRATION;
  if (esc === 2 || esc === 3) return fail("An ESC calibration is waiting", "ESC_CALIBRATION is set, so the board sends full throttle to the ESCs the next time it starts, with the new firmware too. Clear the calibration flag on the Calibration page (ESC tab) first, or finish the calibration.");
  const info = linkManager.linkedPortInfo();
  if (!info || !isFlightControllerPort(info)) {
    return fail(
      "Not linked over the flight controller's USB",
      "Firmware is installed through the flight controller's own USB port, not a telemetry radio. Disconnect, plug the flight controller into this computer with a USB cable, and connect to it (or use Find the board).",
    );
  }
  set({ error: null, step: "waiting", waitingFor: "reboot", status: "Restarting the board into its bootloader…" });
  try {
    await commandLink.post("COMMAND_LONG", { command: 246, confirmation: 0, param1: 3, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 });
  } catch {
    /* it may already be restarting */
  }
  await new Promise((r) => setTimeout(r, 500));
  await linkManager.disconnect("Restarting into the bootloader to install firmware.");
  await waitForBootloader(20000);
}

/** Download the latest stable release of the chosen build. */
export async function loadRelease() {
  const { platform, vehicle, info } = get();
  if (!platform || !info) return;
  fetchAbort?.abort();
  const ac = new AbortController();
  fetchAbort = ac;
  set({ release: null, problem: null, download: { got: 0, total: 0 }, status: `Downloading the latest stable firmware for ${platform}…`, error: null });
  try {
    const r = await fetchStable(platform, vehicle, (got, total) => set({ download: { got, total } }), ac.signal);
    if (ac.signal.aborted) return;
    set({ release: r, download: null, status: "", problem: checkFits(r.apj, info) });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return;
    set({ download: null });
    if (e instanceof FirmwareSourceError) {
      const { dir, file } = stablePath(platform, vehicle);
      fail(
        e.kind === "missing" ? "No stable release for this build" : e.kind === "not-stable" ? "Not a stable release" : "The firmware could not be downloaded",
        e.kind === "unreachable" ? `${e.message} The file is ${file} in ${dir} on the firmware server; once downloaded, use Install from a file.` : e.message,
        e.manualUrl,
      );
    } else fail("The firmware could not be downloaded", reason(e));
  }
}

/** Use another build for this board. */
export function chooseBuild(platform: string) {
  set({ platform, source: "stable", file: null });
  void loadRelease();
}

/** Install from a .apj file the user picked. */
export async function pickFile(file: File) {
  set({ error: null });
  try {
    const apj = await parseApj(await file.text());
    set({ file: { name: file.name, apj }, source: "file" });
    recheck();
  } catch (e) {
    fail("That file cannot be installed", e instanceof ApjError ? e.message : reason(e));
  }
}

export function backToStable() {
  set({ source: "stable", file: null });
  void loadRelease();
}

function recheck() {
  const { info, source, file, release } = get();
  const apj = source === "file" ? file?.apj : release?.apj;
  set({ problem: info && apj ? checkFits(apj, info) : null });
}

/** The firmware that Install would write. */
export function chosenFirmware(): Apj | null {
  const s = get();
  return s.source === "file" ? (s.file?.apj ?? null) : (s.release?.apj ?? null);
}

const warnLeave = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "";
};

/** Erase, write, verify, restart. */
export async function install() {
  const apj = chosenFirmware();
  const { info, problem } = get();
  if (!bl || !info || !apj) return;
  if (problem) return fail("This firmware does not fit this board", problem);
  set({ step: "installing", error: null, progress: { phase: "erase", share: 0 }, status: "Erasing the old firmware…" });
  const t0 = Date.now();
  window.addEventListener("beforeunload", warnLeave);
  const label: Record<Phase, string> = {
    erase: "Erasing the old firmware…",
    program: "Writing the new firmware…",
    verify: "Checking what was written…",
    "extf-erase": "Erasing the external flash…",
    "extf-program": "Writing to the external flash…",
    "extf-verify": "Checking the external flash…",
    reboot: "Starting the new firmware…",
  };
  const onProgress = (phase: Phase, done: number, total: number) => set({ progress: { phase, share: total ? done / total : 0 }, status: label[phase] });
  try {
    // Identify again right before erasing: the bootloader requires it, and it proves the same board is still there.
    const again = await bl.identify();
    if (again.boardId !== info.boardId) throw new BootloaderError("A different board answered. Start again.");
    if (apj.extfImage && apj.extfImageSize > 0) await bl.writeExternal(apj.extfImage, apj.extfImageSize, onProgress);
    await bl.erase(onProgress);
    await bl.program(apj.image, onProgress);
    await bl.verify(apj.image, onProgress);
    onProgress("reboot", 0, 1);
    await bl.reboot();
    const s = get();
    set({
      step: "done",
      progress: null,
      status: "",
      installed: {
        platform: s.source === "file" ? (apj.summary ?? s.file?.name ?? "custom") : (s.platform ?? ""),
        version: s.source === "file" ? null : (s.release?.version ?? null),
        title: s.source === "file" ? null : (s.release?.title ?? null),
        seconds: (Date.now() - t0) / 1000,
        bytes: apj.imageSize,
      },
    });
  } catch (e) {
    window.removeEventListener("beforeunload", warnLeave);
    const port = link?.port ?? null;
    const lost = !!link?.lostReason;
    await closeLink();
    set({ progress: null });
    fail(
      "Installing stopped",
      `${reason(e)} Nothing was started: a board whose firmware is incomplete stays in its bootloader, so it can always be installed again.`,
    );
    // Get back to the board: the same port if it is still there, or catch it when it is plugged back in.
    if (port && !lost) {
      try {
        if (await attach(port)) return void (await onBootloader());
      } catch {
        /* fall through to waiting */
      }
    }
    set({ step: "waiting", waitingFor: "plug", status: "Unplug the board and plug it back in: AERONEX opens it again by itself." });
    void waitForBootloader(120000);
    return;
  } finally {
    window.removeEventListener("beforeunload", warnLeave);
  }
  await closeLink();
}

function reason(e: unknown): string {
  if (e instanceof BootloaderError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
