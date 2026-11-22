/*
  Prepares a release from CHANGELOG.md, for the "Prepare a release" workflow
  (.github/workflows/release.yml), or by hand.

  It takes what is listed under "## Unreleased", writes it as the release
  notes (desktop/build/release-notes.md, which the installer and GitHub
  release show), turns the heading into "## <version>, <date>" with a fresh
  empty Unreleased section above it, and sets the version in package.json and
  package-lock.json. It refuses when there is nothing under Unreleased, so a
  release always says what changed.

  usage: node scripts/prepare-release.mjs <patch|minor|major|x.y.z> [--date "22 November 2026"]
*/
import { readFileSync, writeFileSync } from "node:fs";

/** The next version: a bump of the current one, or an exact x.y.z. */
export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`The current version "${current}" is not x.y.z.`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "major") return `${maj + 1}.0.0`;
  const e = /^(\d+)\.(\d+)\.(\d+)$/.exec(bump ?? "");
  if (!e) throw new Error(`"${bump}" is not patch, minor, major or a version like 1.2.3.`);
  // The first part that differs decides which is newer.
  const diff = e.slice(1).map((n, i) => Number(n) - [maj, min, pat][i]).find((d) => d !== 0) ?? 0;
  if (diff <= 0) throw new Error(`${bump} is not newer than ${current}.`);
  return bump;
}

/** Splits the changelog at its Unreleased section. */
export function takeUnreleased(changelog, version, date) {
  const head = /^## Unreleased[ \t]*\r?\n/m.exec(changelog);
  if (!head) throw new Error('CHANGELOG.md has no "## Unreleased" section.');
  const start = head.index + head[0].length;
  const next = changelog.slice(start).search(/^## /m);
  const end = next === -1 ? changelog.length : start + next;
  const notes = changelog.slice(start, end).trim();
  if (!notes) throw new Error('Nothing is listed under "## Unreleased" in CHANGELOG.md. Add what changed for users first.');
  const updated = `${changelog.slice(0, head.index)}## Unreleased\n\n## ${version}, ${date}\n\n${notes}\n\n${changelog.slice(end).replace(/^\s+/, "")}`;
  return { notes, changelog: updated.replace(/\n{3,}/g, "\n\n") };
}

/** Release notes are one line per item: the changelog wraps its lines, GitHub and the updater should not. */
export function unwrapNotes(notes) {
  return notes
    .split(/\n(?=- )/)
    .map((item) => item.replace(/\s*\n\s*/g, " ").trim())
    .join("\n") + "\n";
}

const longDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

if (process.argv[1]?.endsWith("prepare-release.mjs")) {
  const args = process.argv.slice(2);
  const bump = args[0];
  const di = args.indexOf("--date");
  const date = di > 0 ? args[di + 1] : longDate(new Date());
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const version = nextVersion(pkg.version, bump);
    const { notes, changelog } = takeUnreleased(readFileSync("CHANGELOG.md", "utf8"), version, date);
    writeFileSync("CHANGELOG.md", changelog);
    writeFileSync("desktop/build/release-notes.md", unwrapNotes(notes));
    for (const file of ["package.json", "package-lock.json"]) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      j.version = version;
      if (file === "package-lock.json" && j.packages?.[""]) j.packages[""].version = version;
      writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    }
    console.log(version);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
