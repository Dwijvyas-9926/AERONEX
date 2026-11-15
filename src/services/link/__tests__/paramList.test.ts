import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLink } from "../commandLink";
import { useLink, type VehicleIdentity } from "../../../state/linkStore";
import { useParams } from "../../../state/paramStore";
import { MavlinkParser, decode } from "../../../mavlink/parser";

/*
  The full parameter list must arrive whichever page asks first, and gaps must
  be filled. The bug this pins: a page reading two settings by name made the
  Parameters page think the list had been downloaded, so it stayed at
  "2 of 1,370" until the aircraft was reconnected.
*/

const COUNT = 300;
const names = Array.from({ length: COUNT }, (_, i) => `P${String(i).padStart(3, "0")}`);

const vehicle: VehicleIdentity = {
  sysid: 1, compid: 1, type: 2, typeLabel: "Quadrotor", autopilot: 3, firmware: "ardupilot", firmwareLabel: "ArduPilot",
  armed: false, mode: null, customMode: 0, systemStatus: "Standby", mavlinkVersion: 3, protocol: 2,
};

/** A flight controller that answers list and index requests, dropping what `lose` says. */
function fakeAutopilot(lose: (i: number, attempt: number) => boolean) {
  const sent: string[] = [];
  const tries = new Map<number, number>();
  const reply = (i: number) => {
    const n = (tries.get(i) ?? 0) + 1;
    tries.set(i, n);
    if (lose(i, n)) return;
    queueMicrotask(() => commandLink.handle("PARAM_VALUE", { param_id: names[i], param_value: i, param_count: COUNT, param_index: i, param_type: 9 }));
  };
  const parser = new MavlinkParser();
  commandLink.attach(async (bytes) => {
    for (const f of parser.push(bytes)) {
      const d = (decode(f) ?? {}) as Record<string, unknown>;
      sent.push(f.name);
      if (f.name === "PARAM_REQUEST_LIST") for (let i = 0; i < COUNT; i++) reply(i);
      if (f.name === "PARAM_REQUEST_READ") {
        const idx = d.param_index as number;
        if (idx >= 0) reply(idx);
        else {
          const i = names.indexOf(String(d.param_id));
          if (i >= 0) queueMicrotask(() => commandLink.handle("PARAM_VALUE", { param_id: names[i], param_value: i, param_count: COUNT, param_index: 65535, param_type: 9 }));
        }
      }
    }
  });
  return sent;
}

beforeEach(() => {
  vi.useFakeTimers();
  useParams.getState().reset();
  useLink.setState({ vehicle, status: "connected", virtual: false });
});
afterEach(() => {
  commandLink.detach();
  useLink.setState({ vehicle: null, status: "idle" });
  vi.useRealTimers();
});

const settle = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) await vi.advanceTimersByTimeAsync(250);
};

describe("downloading the parameter list", () => {
  it("still downloads everything after another page read a few settings by name", async () => {
    const sent = fakeAutopilot(() => false);
    const reading = commandLink.requestParams(["P010", "P020"]);
    await settle(100);
    await reading;
    expect(useParams.getState().received).toBe(2);
    expect(useParams.getState().count).toBe(COUNT);

    await commandLink.ensureParamList();
    await settle(3000);
    expect(sent).toContain("PARAM_REQUEST_LIST");
    expect(useParams.getState().received).toBe(COUNT);
    expect(useParams.getState().list).toBe("complete");
  });

  it("fills gaps a lossy radio leaves, however many rounds it takes", async () => {
    // A third of the list is lost on the first pass, and every retry loses half again.
    fakeAutopilot((i, attempt) => (attempt === 1 ? i % 3 === 0 : (i + attempt) % 2 === 0 && attempt < 6));
    await commandLink.ensureParamList();
    await settle(60_000);
    expect(useParams.getState().received).toBe(COUNT);
    expect(useParams.getState().list).toBe("complete");
  });

  it("says the list is incomplete when the vehicle stops answering, and resumes on request", async () => {
    let cap = 250;
    const sent = fakeAutopilot((i) => i >= cap);
    await commandLink.ensureParamList();
    await settle(30_000);
    expect(useParams.getState().received).toBe(250);
    expect(useParams.getState().list).toBe("incomplete");

    // The aircraft answers again: only the missing ones are asked for.
    cap = Infinity;
    sent.length = 0;
    await commandLink.ensureParamList();
    await settle(8000);
    expect(sent).not.toContain("PARAM_REQUEST_LIST");
    expect(sent.filter((n) => n === "PARAM_REQUEST_READ")).toHaveLength(50);
    expect(useParams.getState().list).toBe("complete");
  });

  it("does nothing when the list is already whole", async () => {
    const sent = fakeAutopilot(() => false);
    await commandLink.ensureParamList();
    await settle(3000);
    sent.length = 0;
    await commandLink.ensureParamList();
    await settle(2000);
    expect(sent).toEqual([]);
  });
});
