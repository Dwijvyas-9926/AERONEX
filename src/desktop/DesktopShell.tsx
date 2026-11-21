import { Cable, Usb, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { describeUsbDevice } from "../services/capabilities";
import { notify } from "../state/notifyStore";
import { useUi } from "../state/uiStore";
import { desktop, type DesktopPort } from "./bridge";

/*
  What the Windows app adds to the page: the serial-port chooser that a
  browser would draw itself, and the menu's links into the app. Nothing is
  drawn in a browser.
*/
export function DesktopShell() {
  const nav = useNavigate();
  const [ports, setPorts] = useState<DesktopPort[] | null>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!desktop) return;
    const offs = [
      desktop.serial.onChoose((list) => setPorts(list)),
      desktop.serial.onNone(() =>
        notify("warn", "No serial ports found", "Plug the flight controller in with a USB cable, or the telemetry radio, and wait a few seconds for Windows to install its driver. Then press Connect again."),
      ),
      desktop.onGo((hash) => nav(hash)),
      desktop.onGuide(() => useUi.getState().toggle("help")),
    ];
    return () => offs.forEach((off) => off());
  }, [nav]);

  useEffect(() => {
    if (!ports) return;
    first.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [ports]);

  if (!desktop || !ports) return null;

  function answer(id: string | null) {
    desktop!.serial.choose(id);
    setPorts(null);
  }

  return (
    <div className="scrim" onMouseDown={() => answer(null)}>
      <div className="dialog port-dialog" role="dialog" aria-modal="true" aria-labelledby="port-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="port-head">
          <h2 id="port-title">Choose the flight controller</h2>
          <button className="btn btn-ghost btn-icon" aria-label="Cancel" onClick={() => answer(null)}>
            <X size={16} />
          </button>
        </div>
        <p>Pick the port your Pixhawk or telemetry radio is on. Unplugging it and plugging it back in shows which one it is.</p>
        <ul className="port-list">
          {ports.map((p, i) => {
            const usb = p.vendorId !== null ? describeUsbDevice({ usbVendorId: p.vendorId, usbProductId: p.productId ?? undefined }) : "Serial port";
            return (
              <li key={p.id}>
                <button ref={i === 0 ? first : undefined} className="port-item" onClick={() => answer(p.id)}>
                  <Usb aria-hidden size={18} />
                  <span>
                    <strong>{p.display || p.name || "Serial port"}</strong>
                    <small>
                      {p.name ? `${p.name} · ` : ""}
                      {usb}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="actions">
          <button className="btn" onClick={() => answer(null)}>
            <Cable size={15} /> Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
