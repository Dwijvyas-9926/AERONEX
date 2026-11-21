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
  onGo: (fn: (hash: string) => void) => () => void;
  onGuide: (fn: () => void) => () => void;
}

export const desktop: DesktopBridge | null =
  typeof window !== "undefined" && (window as unknown as { aeronexDesktop?: DesktopBridge }).aeronexDesktop?.isDesktop
    ? (window as unknown as { aeronexDesktop: DesktopBridge }).aeronexDesktop
    : null;

export const isDesktop = () => desktop !== null;
