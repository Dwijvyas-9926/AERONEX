import { create } from "zustand";
import { useFirmware, type Step } from "../firmware/installer";
import { useLink, type LinkStatus } from "../state/linkStore";
import { desktop, type UpdateStatus } from "./bridge";

/*
  Updates, as the page sees them (desktop/updater.cjs does the work).

  The page's one duty here is to say, every time it changes, whether AERONEX
  is holding on to an aircraft: a flight controller's port being opened or
  open, or a firmware install between "board found" and "done". While it is,
  the app will not restart to update, and will not install on exit.

  The virtual aircraft does not count: it is part of the app, and restarting
  only ends the simulation.
*/

/** Port states in which a real flight controller may be on the other end. */
const HOLDING: LinkStatus[] = [
  "selecting",
  "opening",
  "listening",
  "no-heartbeat",
  "connected",
  "stale",
];
const FLASHING: Step[] = ["waiting", "board", "installing"];

export function holdingAircraft(
  link: { status: LinkStatus; virtual: boolean },
  firmwareStep: Step,
): boolean {
  return (
    (HOLDING.includes(link.status) && !link.virtual) ||
    FLASHING.includes(firmwareStep)
  );
}

interface UpdateStore {
  status: UpdateStatus | null;
  /** The version the operator chose "Later" for; its notice stays away until the next launch. */
  dismissed: string | null;
}

export const useUpdates = create<UpdateStore>(() => ({
  status: null,
  dismissed: null,
}));

let started = false;

/** Follow the updater and report the busy state. Once per page load; nothing in a browser. */
export function startUpdateBridge(): () => void {
  if (!desktop || started) return () => {};
  started = true;
  const bridge = desktop.updates;
  const offStatus = bridge.onStatus((status) =>
    useUpdates.setState({ status }),
  );
  void bridge
    .status()
    .then((status) =>
      useUpdates.setState((s) => ({ status: s.status ?? status })),
    );

  let last: boolean | null = null;
  const report = () => {
    const busy = holdingAircraft(
      useLink.getState(),
      useFirmware.getState().step,
    );
    if (busy === last) return;
    last = busy;
    bridge.setBusy(busy);
  };
  report();
  const offLink = useLink.subscribe(report);
  const offFirmware = useFirmware.subscribe(report);
  return () => {
    offStatus();
    offLink();
    offFirmware();
    started = false;
  };
}

export async function checkForUpdates(): Promise<UpdateStatus | null> {
  if (!desktop) return null;
  const status = await desktop.updates.check();
  useUpdates.setState({ status });
  return status;
}

export async function restartToUpdate(): Promise<{
  ok: boolean;
  reason: string | null;
}> {
  if (!desktop) return { ok: false, reason: null };
  return desktop.updates.install();
}
