import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/*
  The simulated bootloader that AERONEX's installer is tested against
  (src/firmware/__tests__/blsim.ts), checked against ArduPilot's own
  reference uploader, Tools/scripts/uploader.py, the one Mission Planner's and
  QGroundControl's installers follow. uploader.py talks to it through a
  pseudo-terminal exactly as it talks to a Pixhawk's USB port: if the real
  uploader identifies, erases, writes, verifies and boots it, and notices
  when a byte goes wrong, then the simulator answers as a real bootloader
  does, and the tests that pass against it mean something for real boards.

      ARDUPILOT_DIR=…/ardupilot npx vitest run sitl/firmware

  Skipped without ARDUPILOT_DIR.
*/
const AP = process.env.ARDUPILOT_DIR;
const ROOT = path.resolve(__dirname, "..");

// A pty bridge: the simulator on one end, uploader.py on the other.
const BRIDGE = `
import os, pty, sys, subprocess, tty, time
ap, apj, opts, flash_out = sys.argv[1:5]
master, slave = pty.openpty()
tty.setraw(slave); tty.setraw(master)
sim = subprocess.Popen(["npx", "tsx", "sitl/blsim-stdio.ts", opts, flash_out], stdin=master, stdout=master, cwd=sys.argv[5])
time.sleep(2.5)
r = subprocess.run([sys.executable, ap + "/Tools/scripts/uploader.py", "--port", os.ttyname(slave), apj], capture_output=True, text=True, timeout=600)
print("EXIT", r.returncode)
print(r.stdout.replace("\\r", "\\n")[-3000:])
print(r.stderr[-1500:])
try: sim.wait(5)
except Exception: sim.kill()
`;

function apj(dir: string, size: number) {
  const img = Buffer.alloc(size);
  let x = size;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    img[i] = x >>> 24;
  }
  const file = path.join(dir, "fw.apj");
  writeFileSync(
    file,
    JSON.stringify({
      board_id: 9, magic: "APJFWv1", description: "Firmware for a STM32F427xx board", image: deflateSync(img, { level: 9 }).toString("base64"),
      extf_image: deflateSync(Buffer.alloc(0)).toString("base64"), summary: "Pixhawk1", version: "0.1", image_size: size, extf_image_size: 0,
      flash_total: 2080768, image_maxsize: 2080768, flash_free: 2080768 - size, extflash_total: 0, extflash_free: 0, git_identity: "0000000", board_revision: 0, USBID: "0x1209/0x5741",
    }),
  );
  return { file, img };
}

function upload(opts: object, size: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "aeronex-fw-"));
  const { file, img } = apj(dir, size);
  const flash = path.join(dir, "flash.bin");
  const bridge = path.join(dir, "bridge.py");
  writeFileSync(bridge, BRIDGE);
  const r = spawnSync("python3", [bridge, AP!, file, JSON.stringify(opts), flash, ROOT], { encoding: "utf8", timeout: 600_000 });
  let flashed: Buffer | null = null;
  try {
    flashed = readFileSync(flash);
  } catch {
    flashed = null;
  }
  return { out: r.stdout + r.stderr, img, flashed };
}

describe.skipIf(!AP)("the simulated bootloader against ArduPilot's uploader.py", () => {
  it("is identified, erased, written, verified and booted, and holds the image", () => {
    const { out, img, flashed } = upload({}, 400_000);
    expect(out).toMatch(/EXIT 0/);
    expect(out).toMatch(/board_type: 9/);
    expect(out).toMatch(/Verify/);
    expect(flashed).not.toBeNull();
    expect(Buffer.compare(flashed!.subarray(0, img.length), img)).toBe(0);
    expect(flashed!.subarray(img.length).every((b) => b === 0xff)).toBe(true);
  }, 600_000);

  it("makes uploader.py report a bad write, as a real bootloader would", () => {
    const { out, flashed } = upload({ corruptAt: 123_457 }, 300_000);
    expect(out).not.toMatch(/EXIT 0/);
    expect(out).toMatch(/CRC|verif/i);
    expect(flashed).toBeNull();
  }, 600_000);
});
