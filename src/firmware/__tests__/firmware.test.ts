import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApj } from "../apj";
import { BOARDS } from "../boards.generated";
import { Bootloader, BootloaderError, chipLimitedTo1M } from "../bootloader";
import { checkFits, fetchStable, parseFirmwareVersion, recommend, stablePath } from "../catalog";
import { crc32, flashCrc } from "../crc32";
import { SimBootloader, type SimOptions } from "./blsim";
import { SimLink } from "./simlink";

/** zlib-compressed and base64-encoded, as ArduPilot's build stores the image. */
async function zb64(b: Uint8Array) {
  const z = new Uint8Array(await new Response(new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  let bin = "";
  for (let i = 0; i < z.length; i += 0x8000) bin += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A .apj exactly as ArduPilot's build writes it (Tools/ardupilotwaf/chibios.py). */
async function apjText(image: Uint8Array, boardId = 9, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    board_id: boardId,
    magic: "APJFWv1",
    description: "Firmware for a STM32F427xx board",
    image: await zb64(image),
    extf_image: await zb64(new Uint8Array(0)),
    summary: "Pixhawk1",
    version: "0.1",
    image_size: image.length,
    extf_image_size: 0,
    flash_total: 2080768,
    image_maxsize: 2080768,
    flash_free: 2080768 - image.length,
    extflash_total: 0,
    extflash_free: 0,
    git_identity: "abc1234",
    board_revision: 0,
    USBID: "0x1209/0x5740",
    build_time: 1700000000,
    ...extra,
  });
}

/** Firmware-like bytes: not a repeating pattern, so a shifted or missing block shows. */
function image(n: number, seed = 7) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function board(opts: SimOptions = {}) {
  const sim = new SimBootloader(opts);
  const link = new SimLink(sim);
  return { sim, link, bl: new Bootloader(link) };
}

async function flashAll(bl: Bootloader, img: Uint8Array) {
  const phases = new Set<string>();
  const on = (p: string) => phases.add(p);
  await bl.identify();
  await bl.erase(on);
  await bl.program(img, on);
  await bl.verify(img, on);
  await bl.reboot();
  return phases;
}

describe("CRC, as the bootloader computes it", () => {
  it("matches the values uploader.py gives", () => {
    expect(crc32(new TextEncoder().encode("123456789"), 0)).toBe(0x2dfd2d88);
    const img = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) img[i] = i & 0xff;
    expect(crc32(img, 0)).toBe(0x58bee308);
    // The bootloader's CRC covers the whole flash, the unwritten part reading 0xFF.
    expect(flashCrc(img, 4096)).toBe(0x97c2df68);
  });
});

describe("reading .apj files", () => {
  it("reads what ArduPilot's build writes", async () => {
    const img = image(10001);
    const apj = await parseApj(await apjText(img));
    expect(apj.boardId).toBe(9);
    expect(apj.imageSize).toBe(10001);
    // Padded with 0xFF to whole words, as uploader.py does.
    expect(apj.image.length).toBe(10004);
    expect([...apj.image.subarray(10001)]).toEqual([0xff, 0xff, 0xff]);
    expect(apj.image.subarray(0, 10001)).toEqual(img);
    expect(apj.summary).toBe("Pixhawk1");
    expect(apj.extfImage).toBeNull();
  });

  it("refuses files that are not firmware, or are damaged", async () => {
    await expect(parseApj(":020000040800F2\n")).rejects.toThrow(/not JSON|\.hex/);
    await expect(parseApj(JSON.stringify({ hello: 1 }))).rejects.toThrow(/no firmware image/);
    await expect(parseApj(await apjText(image(500), 9, { magic: "OTHER" }))).rejects.toThrow(/format/);
    await expect(parseApj(await apjText(image(500), 9, { image_size: 499 }))).rejects.toThrow();
    const t = JSON.parse(await apjText(image(5000)));
    t.image = t.image.slice(0, 200);
    await expect(parseApj(JSON.stringify(t))).rejects.toThrow();
  });
});

describe("installing on a simulated ArduPilot bootloader", () => {
  it("writes, verifies and starts the firmware, byte for byte", async () => {
    const { sim, bl } = board();
    const img = (await parseApj(await apjText(image(300_001)))).image;
    const phases = await flashAll(bl, img);
    expect(bl.info).toMatchObject({ blRev: 5, boardId: 9, flashSize: (2048 - 16) * 1024, chip: 0x20016419, chipDes: "STM32F42x_43x,3" });
    expect(bl.info!.serial).toMatch(/^[0-9A-F]{24}$/);
    expect(sim.booted).toBe(true);
    expect(sim.log).toEqual(["erase", "boot"]);
    expect(sim.image(img.length)).toEqual(img);
    // Everything after the firmware is erased.
    expect(sim.flash.subarray(img.length).every((b) => b === 0xff)).toBe(true);
    expect([...phases]).toEqual(["erase", "program", "verify"]);
  });

  it("catches a byte that was not written as sent, and does not start it", async () => {
    const { sim, bl } = board({ corruptAt: 123_457 });
    const img = image(200_000);
    await bl.identify();
    await bl.erase();
    await bl.program(img);
    await expect(bl.verify(img)).rejects.toThrow(/Verification failed/);
    expect(sim.booted).toBe(false);
  });

  it("reports a failed erase", async () => {
    const { bl } = board({ failErase: true });
    await bl.identify();
    await expect(bl.erase()).rejects.toThrow(/could not erase/);
  });

  it("cannot erase without identifying first, as the bootloader insists", async () => {
    const { bl } = board();
    await bl.sync();
    await expect(bl.erase()).rejects.toThrow(/not identified|refused/);
  });

  it("works with an old bootloader: no external-flash query, no chip id, protocol 2 read-back", async () => {
    const { sim, bl } = board({ blRev: 2, noExtfInfo: true });
    const img = image(50_000, 3);
    await flashAll(bl, img);
    expect(bl.info).toMatchObject({ blRev: 2, extfSize: 0, chip: null, serial: null });
    expect(sim.image(img.length)).toEqual(img);
  });

  it("catches a bad write on a protocol 2 bootloader by reading it back", async () => {
    const { bl } = board({ blRev: 2, noExtfInfo: true, corruptAt: 9_000 });
    const img = image(20_000);
    await bl.identify();
    await bl.erase();
    await bl.program(img);
    await expect(bl.verify(img)).rejects.toThrow(/byte 9000/);
  });

  it("refuses a bootloader protocol it does not speak", async () => {
    const { bl } = board({ blRev: 9 });
    await expect(bl.identify()).rejects.toThrow(BootloaderError);
  });

  it("is not fooled by something that is not a bootloader", async () => {
    const { sim, bl } = board();
    // A board running firmware sends MAVLink, never INSYNC.
    sim.input = () => {
      sim.out.push(0xfd, 0x09, 0x00);
      sim.onOutput?.();
    };
    expect(await bl.trySync(200)).toBe(false);
  });
});

describe("choosing the build", () => {
  const info = (o: Partial<{ boardId: number; flashSize: number; chip: number | null }>) => ({ boardId: 9, flashSize: (2048 - 16) * 1024, chip: null as number | null, ...o });

  it("knows the STM32F427 1 MB flaw", () => {
    expect(chipLimitedTo1M(0x20016419)).toBe(false); // rev 3
    expect(chipLimitedTo1M(0x10006419)).toBe(true); // rev A
    expect(chipLimitedTo1M(0x10036419)).toBe(true);
    expect(chipLimitedTo1M(0x10076419)).toBe(true);
    expect(chipLimitedTo1M(0x10016451)).toBe(false); // another MCU
    expect(chipLimitedTo1M(null)).toBeNull();
  });

  it("picks Pixhawk1 or Pixhawk1-1M for a Pixhawk 2.4.8 from its processor", () => {
    expect(recommend(info({ chip: 0x20016419 }), { vendor: 0x1209, product: 0x5741 }).pick?.platform).toBe("Pixhawk1");
    expect(recommend(info({ chip: 0x10006419 }), { vendor: 0x1209, product: 0x5741 }).pick?.platform).toBe("Pixhawk1-1M");
    // An old PX4 bootloader cannot say: the 1 MB build runs on every one.
    const old = recommend(info({ chip: null }), { vendor: 0x26ac, product: 0x0011 });
    expect(old.pick?.platform).toBe("Pixhawk1-1M");
    expect(old.notes.join(" ")).toMatch(/too old/);
    expect(old.others.map((o) => o.platform)).toContain("Pixhawk1");
    // A bootloader offering 1 MB.
    expect(recommend(info({ flashSize: 1024 * 1024 - 16 * 1024, chip: 0x20016419 })).pick?.platform).toBe("Pixhawk1-1M");
  });

  it("tells boards sharing an id apart by their bootloader's USB id", () => {
    expect(recommend(info({ chip: 0x20016419 }), { vendor: 0x2dae, product: 0x1001 }).pick?.platform).toBe("CubeBlack");
  });

  it("never picks a SimOnHardWare build", () => {
    for (const [id, builds] of Object.entries(BOARDS)) {
      const r = recommend({ boardId: Number(id), flashSize: builds[0].flashKb * 1024, chip: null });
      expect(r.pick?.platform ?? "").not.toMatch(/SimOnHardWare/i);
    }
  });

  it("asks which board it is when different boards share the id and bootloader", () => {
    const r = recommend({ boardId: 50, flashSize: 2016 * 1024, chip: null }, { vendor: 0x1209, product: 0x5741 });
    expect(r.pick).toBeNull();
    expect(r.choose).toEqual(expect.arrayContaining(["Pixhawk4", "CUAVv5", "PH4-mini", "fmuv5"]));
    expect(r.choose).not.toContain("Pixhawk4-bdshot");
    // A bootloader with its own USB id says which one it is.
    expect(recommend({ boardId: 50, flashSize: 2016 * 1024, chip: null }, { vendor: 0x3162, product: 0x004e }).pick?.platform).toBe("Pix32v5");
    // Variants of one board are not a question.
    expect(recommend({ boardId: 140, flashSize: 1920 * 1024, chip: null }, { vendor: 0x2dae, product: 0x1016 }).choose).toEqual([]);
  });

  it("says so for a board id no flight-controller build uses", () => {
    expect(recommend(info({ boardId: 999_999 })).pick).toBeNull();
  });

  it("refuses firmware for another board, or too big for its flash", async () => {
    const bi = { blRev: 5, boardId: 9, boardRev: 0, flashSize: 1024 * 1024, extfSize: 0, chip: null, chipDes: null, serial: null };
    const other = await parseApj(await apjText(image(1000), 50));
    expect(checkFits(other, bi)).toMatch(/board id 50.*id 9/);
    const big = await parseApj(await apjText(image(1024 * 1024 + 4), 9));
    expect(checkFits(big, bi)).toMatch(/Pixhawk1-1M/);
    const ok = await parseApj(await apjText(image(900_000), 9));
    expect(checkFits(ok, bi)).toBeNull();
    // Board 33 accepts board 9's firmware (uploader.py's compatible ids).
    expect(checkFits(ok, { ...bi, boardId: 33 })).toBeNull();
  });

  it("finds the stable files where the firmware server keeps them", () => {
    expect(stablePath("Pixhawk1", "copter")).toEqual({ dir: "Copter/stable/Pixhawk1/", file: "arducopter.apj" });
    expect(stablePath("Pixhawk1-1M", "heli")).toEqual({ dir: "Copter/stable/Pixhawk1-1M-heli/", file: "arducopter-heli.apj" });
  });
});

describe("downloading the stable release", () => {
  afterEach(() => vi.unstubAllGlobals());

  function server(files: Record<string, string | number>) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = url.replace("https://firmware.ardupilot.org/", "");
      const f = files[path];
      if (typeof f === "number") return new Response("err", { status: f });
      if (f === undefined) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(f, { status: 200, headers: { "content-length": String(f.length) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the version file", () => {
    expect(parseFirmwareVersion("4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL\n")).toEqual({ version: "4.6.3", type: "FIRMWARE_VERSION_TYPE_OFFICIAL" });
    expect(parseFirmwareVersion("<!doctype html>")).toBeNull();
  });

  it("downloads and checks the latest stable build, with progress", async () => {
    const img = image(70_000);
    server({
      "Copter/stable/Pixhawk1/firmware-version.txt": "4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL\n",
      "Copter/stable/Pixhawk1/git-version.txt": "commit 1234\nAPMVERSION: ArduCopter V4.6.3\n",
      "Copter/stable/Pixhawk1/arducopter.apj": await apjText(img),
    });
    const seen: number[] = [];
    const r = await fetchStable("Pixhawk1", "copter", (got) => seen.push(got));
    expect(r.version).toBe("4.6.3");
    expect(r.title).toBe("ArduCopter V4.6.3");
    expect(r.apj.image.subarray(0, img.length)).toEqual(img);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("refuses anything in the stable folder that is not an official release", async () => {
    server({
      "Copter/stable/Pixhawk1/firmware-version.txt": "4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL",
      "Copter/stable/X/firmware-version.txt": "4.7.0-FIRMWARE_VERSION_TYPE_BETA",
    });
    await expect(fetchStable("X", "copter")).rejects.toMatchObject({ kind: "not-stable" });
  });

  it("says when a board has no stable release", async () => {
    server({ "Copter/stable/Pixhawk1/firmware-version.txt": "4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL" });
    await expect(fetchStable("NewBoard", "copter")).rejects.toMatchObject({ kind: "missing" });
  });
});
