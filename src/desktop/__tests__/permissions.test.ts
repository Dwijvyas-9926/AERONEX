import { describe, expect, it } from "vitest";
import { createPermissionRule } from "../../../desktop/permissions.cjs";

const allow = createPermissionRule({ scheme: "aeronex" });

describe("desktop permissions", () => {
  it("lets the app's own pages use the serial port, location and clipboard writes", () => {
    for (const p of ["serial", "geolocation", "clipboard-sanitized-write"]) {
      expect(allow(p, "aeronex://app/index.html#/missions")).toBe(true);
      expect(allow(p, "aeronex://app")).toBe(true);
    }
  });

  it("refuses everything else, even to the app", () => {
    for (const p of ["media", "notifications", "clipboard-read", "display-capture", "openExternal", "midi", "pointerLock", "fullscreen"]) {
      expect(allow(p, "aeronex://app/index.html")).toBe(false);
    }
  });

  it("refuses pages from anywhere else", () => {
    expect(allow("geolocation", "https://example.com/")).toBe(false);
    expect(allow("serial", "aeronex://evil/index.html")).toBe(false);
    expect(allow("geolocation", "http://localhost:5173/")).toBe(false);
    expect(allow("geolocation", undefined)).toBe(false);
    expect(allow("geolocation", "not a url")).toBe(false);
  });

  it("allows the dev server only when the app was started from it", () => {
    const dev = createPermissionRule({ scheme: "aeronex", devServer: "http://localhost:5173" });
    expect(dev("geolocation", "http://localhost:5173/#/missions")).toBe(true);
    expect(dev("geolocation", "http://localhost:5174/")).toBe(false);
  });
});
