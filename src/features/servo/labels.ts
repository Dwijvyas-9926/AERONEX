/* Names and kinds for the servo drawing and lists. */
import { functionInfo, motorOf, rcOf, type Category, type Output } from "../../servo/model";

export const CATEGORY_LABEL: Record<Category | "off", string> = {
  motor: "Motor",
  payload: "Payload",
  rc: "Transmitter",
  command: "Mission / button",
  camera: "Camera",
  gimbal: "Gimbal",
  signal: "Fixed signal",
  gpio: "GPIO pin",
  other: "Other",
  off: "Not used",
};

/** Short name for a pin label. */
export function shortName(o: Pick<Output, "fn" | "servo">): string {
  const m = motorOf(o.fn);
  if (m !== null) return `M${m}`;
  const rc = rcOf(o.fn, o.servo);
  if (rc) return `CH${rc.channel}${rc.scaled ? "~" : ""}`;
  const s: Record<number, string> = { 0: "—", 28: "GRIP", 27: "CHUTE", 29: "GEAR", 22: "PUMP", 23: "SPIN", 88: "WINCH", 10: "CAM", 7: "TILT", 8: "ROLL", 6: "PAN", 134: "MIN", 135: "TRIM", 136: "MAX", 138: "BUZZ", [-1]: "GPIO" };
  return s[o.fn] ?? `F${o.fn}`;
}

export function categoryOf(fn: number): Category | "off" {
  if (fn === 0) return "off";
  return functionInfo(fn).category;
}

