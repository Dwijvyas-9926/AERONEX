import { desktop } from "./bridge";

/*
  A Storage that keeps its values encrypted by Windows, through the desktop
  shell. Read once at start (the shell decrypts the file), held in memory,
  and written back on each change. Only the stores' secret fields use it.

  If Windows cannot encrypt (a damaged user profile), nothing is written:
  a key typed in lasts until the app closes, and Settings says why.
*/
let cache: Record<string, string> | null = null;
let available = true;

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const r = desktop!.secrets.all();
    available = !!r.available;
    cache = { ...(r.values ?? {}) };
  } catch {
    available = false;
    cache = {};
  }
  return cache;
}

export const encryptionAvailable = () => {
  load();
  return available;
};

export const desktopSecretStore: Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> = {
  getItem: (name) => load()[name] ?? null,
  setItem: (name, value) => {
    load()[name] = value;
    if (available) void desktop!.secrets.set(name, value);
  },
  removeItem: (name) => {
    delete load()[name];
    if (available) void desktop!.secrets.set(name, null);
  },
};
