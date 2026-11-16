/** Keep a time window inside the log and at least 0.5 s wide. */
export function clampView(v: [number, number], full: [number, number]): [number, number] {
  const span = Math.min(full[1] - full[0], Math.max(0.5, v[1] - v[0]));
  const mid = (v[0] + v[1]) / 2;
  let a = mid - span / 2;
  let b = mid + span / 2;
  if (a < full[0]) {
    b += full[0] - a;
    a = full[0];
  }
  if (b > full[1]) {
    a -= b - full[1];
    b = full[1];
  }
  return [Math.max(full[0], a), Math.min(full[1], b)];
}

export const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${Math.round(n)} B`);
