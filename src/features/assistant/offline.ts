/*
  Answers without the AI: the manual searched on this computer.

  With no API key, or no internet, a question still gets the parts of the
  manual that match it, with a link to the page. It is a keyword search
  (BM25 over short passages, with a few drone words folded together), so it
  finds where something is written; it does not reason about it, and says so.
*/
import { ROUTES } from "../../app/routes";
import { MANUAL, type ManualTopic } from "./manual";

export interface Passage {
  topic: ManualTopic;
  /** Markdown: a part of the topic's body. */
  text: string;
}

export interface Hit extends Passage {
  score: number;
}

const STOP = new Set(
  "a an the to of and or in on at for is are be it its this that with by from as how do does i my me can what when where which why you your we our use using get into if not no yes so up out than then there their they will would should could has have had was were just".split(" "),
);

/** Words that mean the same thing here. */
const SAME: Record<string, string> = {
  takeoff: "take-off",
  "take-off": "take-off",
  launch: "take-off",
  wasd: "keyboard",
  keys: "keyboard",
  key: "keyboard",
  geofence: "fence",
  fencing: "fence",
  geofencing: "fence",
  waypoint: "waypoint",
  waypoints: "waypoint",
  mission: "mission",
  missions: "mission",
  route: "mission",
  calibrate: "calibration",
  calibrating: "calibration",
  calibrated: "calibration",
  params: "parameter",
  param: "parameter",
  settings: "parameter",
  arm: "arm",
  arming: "arm",
  armed: "arm",
  connect: "connection",
  connecting: "connection",
  connected: "connection",
  link: "connection",
  usb: "connection",
  serial: "connection",
  pid: "pid",
  pids: "pid",
  tune: "tuning",
  tuning: "tuning",
  wobble: "tuning",
  oscillation: "tuning",
  sim: "simulator",
  simulation: "simulator",
  virtual: "simulator",
  rtl: "return",
  home: "home",
  esc: "esc",
  escs: "esc",
  motor: "motor",
  motors: "motor",
  prop: "propeller",
  props: "propeller",
  propellers: "propeller",
  propeller: "propeller",
  gps: "gps",
  compass: "compass",
  mag: "compass",
  magnetometer: "compass",
  lipo: "battery",
  batt: "battery",
  battery: "battery",
  failsafes: "failsafe",
  failsafe: "failsafe",
};

export function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]*/g) ?? [])
    .map((w) => w.replace(/[.-]+$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => SAME[w] ?? (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w));
}

/** The manual cut into passages: a topic's opening, and its lists a few lines at a time. */
export function passages(manual: ManualTopic[] = MANUAL): Passage[] {
  const out: Passage[] = [];
  for (const topic of manual) {
    let chunk: string[] = [];
    let size = 0;
    const flush = () => {
      if (chunk.length) out.push({ topic, text: chunk.join("\n").trim() });
      chunk = [];
      size = 0;
    };
    for (const para of topic.body.split(/\n(?=\S)/)) {
      // A new list or heading after a long chunk starts a new passage.
      if (size > 700) flush();
      chunk.push(para);
      size += para.length;
    }
    flush();
  }
  return out.filter((p) => p.text.length > 0);
}

let index: { docs: { p: Passage; tf: Map<string, number>; len: number }[]; df: Map<string, number>; avg: number } | null = null;

function build() {
  const docs = passages().map((p) => {
    const words = terms(`${p.topic.title} ${p.topic.title} ${p.text}`);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { p, tf, len: words.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avg };
}

/** The passages that best match a question, best first, at most one per topic. */
export function searchManual(question: string, limit = 3): Hit[] {
  index ??= build();
  const q = [...new Set(terms(question))];
  if (!q.length) return [];
  const N = index.docs.length;
  const k1 = 1.4;
  const b = 0.7;
  const scored = index.docs
    .map((d) => {
      let score = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - index!.df.get(w)! + 0.5) / (index!.df.get(w)! + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index!.avg));
      }
      // Naming a page ("keyboard flight") is the strongest hint there is.
      const lower = question.toLowerCase();
      for (const r of ROUTES) {
        const name = r.label.toLowerCase();
        if (r.path !== "/" && lower.includes(name) && d.p.topic.title.toLowerCase().includes(name)) score += 6;
      }
      return { ...d.p, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b2) => b2.score - a.score);
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of scored) {
    if (seen.has(h.topic.id)) continue;
    seen.add(h.topic.id);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
