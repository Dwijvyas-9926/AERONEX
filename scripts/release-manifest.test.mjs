import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { manifestYaml, versionOf, writeManifest } from "./release-manifest.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");

describe("versionOf", () => {
  it("reads the version from the installer's name", () => {
    expect(versionOf("release/AERONEX-Setup-0.3.4.exe")).toBe("0.3.4");
    expect(versionOf("AERONEX-Setup-1.0.0-beta.2.exe")).toBe("1.0.0-beta.2");
  });
  it("refuses any other name", () => {
    expect(() => versionOf("AERONEX-Setup.exe")).toThrow(/not named/);
    expect(() => versionOf("Other-Setup-0.3.4.exe")).toThrow(/not named/);
  });
});

describe("manifestYaml", () => {
  const base = { version: "0.3.4", file: "AERONEX-Setup-0.3.4.exe", sha512: "abc+/=", size: 123, releaseDate: "2026-11-21T07:00:00.000Z" };

  it("is what electron-updater reads", () => {
    expect(yaml.load(manifestYaml({ ...base, releaseNotes: null }))).toEqual({
      version: "0.3.4",
      files: [{ url: "AERONEX-Setup-0.3.4.exe", sha512: "abc+/=", size: 123 }],
      path: "AERONEX-Setup-0.3.4.exe",
      sha512: "abc+/=",
      releaseDate: "2026-11-21T07:00:00.000Z",
    });
  });

  it("keeps release notes exactly, whatever characters they hold", () => {
    const releaseNotes = '- Fixed: "quotes", colons: and #hashes\r\n- Second line\n\n- 100% done\n';
    expect(yaml.load(manifestYaml({ ...base, releaseNotes })).releaseNotes).toBe(releaseNotes);
  });
});

describe("writeManifest", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("describes the installer as it is on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "aeronex-manifest-"));
    const installer = join(dir, "AERONEX-Setup-0.3.4.exe");
    const bytes = randomBytes(300_000);
    writeFileSync(installer, bytes);

    const r = await writeManifest(installer, { notes: "- Signed.\n", date: "2026-11-21T07:00:00.000Z" });

    const sha512 = createHash("sha512").update(bytes).digest("base64");
    expect(r).toMatchObject({ version: "0.3.4", file: "AERONEX-Setup-0.3.4.exe", size: bytes.length, sha512 });
    const m = yaml.load(readFileSync(join(dir, "latest.yml"), "utf8"));
    expect(m).toMatchObject({ version: "0.3.4", path: "AERONEX-Setup-0.3.4.exe", sha512, releaseNotes: "- Signed.\n" });
    expect(m.files).toEqual([{ url: "AERONEX-Setup-0.3.4.exe", sha512, size: bytes.length }]);

    const map = JSON.parse(gunzipSync(readFileSync(`${installer}.blockmap`)).toString());
    expect(map.files[0].checksums.length).toBeGreaterThan(0);
    expect(map.files[0].sizes.reduce((a, b) => a + b, 0)).toBe(bytes.length);
  });
});
