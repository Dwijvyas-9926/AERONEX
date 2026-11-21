import { describe, expect, it, vi } from "vitest";
import { firmwareTarget, proxyFirmware } from "../../../desktop/firmwareProxy.cjs";

/*
  The Windows app passes firmware requests to ArduPilot's server, and to
  nothing else.
*/
describe("firmware pass-through in the Windows app", () => {
  it("maps plain firmware paths to ArduPilot's server", () => {
    expect(firmwareTarget("/ardupilot-firmware/Copter/stable/Pixhawk1/firmware-version.txt")).toBe("https://firmware.ardupilot.org/Copter/stable/Pixhawk1/firmware-version.txt");
    expect(firmwareTarget("/ardupilot-firmware/Copter/stable/Pixhawk6C/arducopter.apj")).toBe("https://firmware.ardupilot.org/Copter/stable/Pixhawk6C/arducopter.apj");
  });

  it("refuses anything that could reach elsewhere", () => {
    for (const p of [
      "/ardupilot-firmware/../secret",
      "/ardupilot-firmware/Copter/%2e%2e/x",
      "/ardupilot-firmware//evil.example/x",
      "/ardupilot-firmware/a?b",
      "/ardupilot-firmware/a%3Fb",
      "/ardupilot-firmware/a@evil.example",
      "/ardupilot-firmware/%ZZ",
      "/ardupilot-firmware/a\\b",
    ])
      expect(firmwareTarget(p), p).toBeNull();
    expect(firmwareTarget("/index.html")).toBeNull();
  });

  it("leaves the app's own files alone, and only reads", async () => {
    const fetchFn = vi.fn(async () => new Response("4.6.3-FIRMWARE_VERSION_TYPE_OFFICIAL", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(proxyFirmware(new Request("aeronex://app/index.html"), fetchFn)).toBeNull();
    const post = await proxyFirmware(new Request("aeronex://app/ardupilot-firmware/x.txt", { method: "POST", body: "x" }), fetchFn)!;
    expect(post.status).toBe(404);
    // The URL parser itself folds "%2e%2e" away, so this never even looks like a firmware request.
    expect(proxyFirmware(new Request("aeronex://app/ardupilot-firmware/%2e%2e/x"), fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    const ok = await proxyFirmware(new Request("aeronex://app/ardupilot-firmware/Copter/stable/Pixhawk1/firmware-version.txt"), fetchFn)!;
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("OFFICIAL");
    expect(fetchFn).toHaveBeenCalledWith("https://firmware.ardupilot.org/Copter/stable/Pixhawk1/firmware-version.txt", expect.objectContaining({ method: "GET" }));
  });

  it("passes on a missing file as missing, and an unreachable server as an error", async () => {
    const missing = await proxyFirmware(new Request("aeronex://app/ardupilot-firmware/Copter/stable/Nope/firmware-version.txt"), async () => new Response("no", { status: 404 }))!;
    expect(missing.status).toBe(404);
    const down = await proxyFirmware(new Request("aeronex://app/ardupilot-firmware/a.txt"), async () => {
      throw new Error("offline");
    })!;
    expect(down.status).toBe(502);
  });
});
