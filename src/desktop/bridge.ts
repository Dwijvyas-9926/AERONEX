/*
  The Windows app's shell, as the page sees it (desktop/preload.cjs).

  In a browser `desktop` is null and every caller carries on as before; the
  same build runs in both.
*/
export interface DesktopPort {
  id: string;
  name: string;
  display: string;
  vendorId: number | null;
  productId: number | null;
  serial: string;
}

export type UpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "none"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** This copy's version. */
  current: string;
  /** The new version, once one is found. */
  version: string | null;
  /** Its release notes, as plain text. */
  notes: string;
  percent: number;
  error: string | null;
  manual: boolean;
  /** An aircraft is connected or firmware is being installed: no restart. */
  busy: boolean;
}

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  serial: {
    onChoose: (fn: (ports: DesktopPort[]) => void) => () => void;
    onNone: (fn: () => void) => () => void;
    choose: (id: string | null) => void;
  };
  secrets: {
    all: () => { available: boolean; values: Record<string, string> };
    set: (name: string, value: string | null) => Promise<boolean>;
  };
  updates: {
    status: () => Promise<UpdateStatus>;
    check: () => Promise<UpdateStatus>;
    install: () => Promise<{ ok: boolean; reason: string | null }>;
    setBusy: (busy: boolean) => void;
    onStatus: (fn: (s: UpdateStatus) => void) => () => void;
  };
  onGo: (fn: (hash: string) => void) => () => void;
  onGuide: (fn: () => void) => () => void;
}

export const desktop: DesktopBridge | null =
  typeof window !== "undefined" &&
  (window as unknown as { aeronexDesktop?: DesktopBridge }).aeronexDesktop
    ?.isDesktop
    ? (window as unknown as { aeronexDesktop: DesktopBridge }).aeronexDesktop
    : null;

export const isDesktop = () => desktop !== null;
