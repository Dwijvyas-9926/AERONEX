import { describe, expect, it } from "vitest";
import { nextVersion, takeUnreleased, unwrapNotes } from "./prepare-release.mjs";

describe("nextVersion", () => {
  it("bumps", () => {
    expect(nextVersion("0.3.5", "patch")).toBe("0.3.6");
    expect(nextVersion("0.3.5", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.5", "major")).toBe("1.0.0");
  });
  it("takes an exact newer version", () => {
    expect(nextVersion("0.3.5", "0.3.10")).toBe("0.3.10");
    expect(nextVersion("0.3.5", "1.0.0")).toBe("1.0.0");
  });
  it("refuses one that is not newer, or not a version", () => {
    expect(() => nextVersion("0.3.5", "0.3.5")).toThrow(/not newer/);
    expect(() => nextVersion("0.3.5", "0.3.4")).toThrow(/not newer/);
    expect(() => nextVersion("0.3.5", "0.2.9")).toThrow(/not newer/);
    expect(() => nextVersion("0.3.5", "banana")).toThrow(/not patch/);
  });
});

const log = `# Changelog

Intro.

## Unreleased

- First change, which is long and
  wraps onto a second line.
- Second change.

## 0.3.5, 22 November 2026

- Older.
`;

describe("takeUnreleased", () => {
  it("moves Unreleased under the new version and leaves a fresh section", () => {
    const r = takeUnreleased(log, "0.3.6", "23 November 2026");
    expect(r.notes).toBe("- First change, which is long and\n  wraps onto a second line.\n- Second change.");
    expect(r.changelog).toBe(`# Changelog

Intro.

## Unreleased

## 0.3.6, 23 November 2026

- First change, which is long and
  wraps onto a second line.
- Second change.

## 0.3.5, 22 November 2026

- Older.
`);
  });
  it("refuses an empty Unreleased section", () => {
    expect(() => takeUnreleased("# C\n\n## Unreleased\n\n## 0.3.5, x\n\n- Old.\n", "0.3.6", "d")).toThrow(/Nothing is listed/);
  });
  it("refuses a changelog without one", () => {
    expect(() => takeUnreleased("# C\n\n## 0.3.5, x\n", "0.3.6", "d")).toThrow(/no "## Unreleased"/);
  });
});

describe("unwrapNotes", () => {
  it("puts each item on one line", () => {
    expect(unwrapNotes("- First change, which is long and\n  wraps onto a second line.\n- Second change.")).toBe("- First change, which is long and wraps onto a second line.\n- Second change.\n");
  });
});
