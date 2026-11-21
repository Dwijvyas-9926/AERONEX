// Types for updater.cjs, for the page's tests.
export interface UpdaterStatus {
  state: string;
  current: string;
  version: string | null;
  notes: string;
  percent: number;
  error: string | null;
  manual: boolean;
  busy: boolean;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, fn: (arg?: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface Updater {
  start(): void;
  check(manual?: boolean): Promise<void>;
  setBusy(busy: boolean): void;
  beforeQuit(): void;
  install(): { ok: boolean; reason: string | null };
  status(): UpdaterStatus;
}

export function createUpdater(deps: {
  updater: UpdaterLike;
  current: string;
  send: (status: UpdaterStatus) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
}): Updater;
export function plainNotes(notes: unknown): string;
export function plainError(err: unknown): string;
export const FIRST_CHECK_MS: number;
export const EVERY_MS: number;
