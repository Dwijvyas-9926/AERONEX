/*
  Writes the update files for a Windows installer: latest.yml (what installed
  copies read to find a new version) and <installer>.blockmap (which lets
  them download only the parts that changed).

  electron-builder writes both when it builds the installer. Code signing
  then adds a signature to the .exe, which changes its checksum, so after
  signing they must be written again from the signed file, or every
  installed copy would refuse the update ("sha512 checksum mismatch"). The
  release workflow runs this after signing, and also when nothing was
  signed, where it must reproduce electron-builder's files exactly.

  usage: node scripts/release-manifest.mjs <installer.exe> [--notes <file>] [--date <iso>]
*/
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** YAML for latest.yml, in electron-builder's layout. */
export function manifestYaml({ version, file, sha512, size, releaseDate, releaseNotes }) {
  const lines = [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
  ];
  // A JSON string is valid YAML, and keeps any characters in the notes safe.
  if (releaseNotes) lines.push(`releaseNotes: ${JSON.stringify(releaseNotes)}`);
  lines.push(`releaseDate: '${releaseDate}'`);
  return lines.join("\n") + "\n";
}

/** The version in an installer's name: AERONEX-Setup-0.3.4.exe → 0.3.4. */
export function versionOf(file) {
  const m = /^AERONEX-Setup-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/.exec(basename(file));
  if (!m) throw new Error(`${basename(file)} is not named AERONEX-Setup-<version>.exe`);
  return m[1];
}

export async function writeManifest(installer, { notes, date } = {}) {
  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
  const file = basename(installer);
  const version = versionOf(installer);
  // Same compression as electron-builder's NSIS target uses.
  const info = await buildBlockMap(installer, "gzip", `${installer}.blockmap`);
  if (info.size !== statSync(installer).size) throw new Error("The block map does not cover the whole installer.");
  const yaml = manifestYaml({
    version,
    file,
    sha512: info.sha512,
    size: info.size,
    releaseDate: date ?? new Date().toISOString(),
    releaseNotes: notes ?? null,
  });
  writeFileSync(join(dirname(installer), "latest.yml"), yaml);
  return { version, file, ...info };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("release-manifest.mjs")) {
  const args = process.argv.slice(2);
  const installer = args[0];
  if (!installer) {
    console.error("usage: node scripts/release-manifest.mjs <installer.exe> [--notes <file>] [--date <iso>]");
    process.exit(2);
  }
  const flag = (name) => {
    const i = args.indexOf(name);
    return i > 0 ? args[i + 1] : undefined;
  };
  const notesFile = flag("--notes");
  const notes = notesFile ? readFileSync(notesFile, "utf8") : undefined;
  const r = await writeManifest(installer, { notes, date: flag("--date") });
  console.log(`latest.yml and ${r.file}.blockmap written: version ${r.version}, ${r.size} bytes, sha512 ${r.sha512.slice(0, 16)}…`);
}
