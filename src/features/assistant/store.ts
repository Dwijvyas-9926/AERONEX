/*
  The conversation with the assistant. It lives here rather than in the
  panel so an answer keeps arriving while the panel is closed or the person
  moves to another page, and so any page can hand it a question (the Doctor's
  "help me fix this" does). It is kept only in memory: closing the tab ends it.
*/
import { logBrief } from "../../logs/export";
import { useLogs } from "../logs/store";
import { create } from "zustand";
import { useLink } from "../../state/linkStore";
import { useParams } from "../../state/paramStore";
import { useSettings } from "../../state/settingsStore";
import { useSim } from "../../state/simStore";
import { fenceSync, useFence } from "../../state/fenceStore";
import { ask, AssistantError, historyFor, WEB_FETCH, WEB_SEARCH, type ApiMessage, type ContentBlock, type Tool, type Usage } from "./claude";
import { buildLiveContext } from "./context";
import { searchManual, type Hit } from "./offline";
import { systemBlocks } from "./prompt";

export interface Turn {
  id: number;
  role: "user" | "assistant";
  /** The question, or the answer's content blocks. */
  content: string | ContentBlock[];
  at: number;
  /** Answers only. */
  status?: "streaming" | "done" | "stopped" | "error" | "offline";
  error?: string;
  /** Matching passages of the manual, for an answer given without the AI. */
  hits?: Hit[];
  /** Web tools the account refused; the answer was given without them. */
  dropped?: string[];
  /** The answer hit its length limit. */
  truncated?: boolean;
  usage?: Usage;
}

interface AssistantState {
  turns: Turn[];
  busy: boolean;
  /** Text waiting in the composer, set by "ask about this" elsewhere in the app. */
  draft: string;
  setDraft: (s: string) => void;
  send: (question: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

let nextId = 1;
let controller: AbortController | null = null;

/** The page open now, from the hash the router uses. */
export function currentPath(): string {
  const h = typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "");
  return (h.split("?")[0] || "/").replace(/\/+$/, "") || "/";
}

/** The live snapshot sent with a question, read from the app's stores now. */
export function liveSnapshot(path = currentPath()): string {
  const link = useLink.getState();
  const params = useParams.getState();
  const sim = useSim.getState();
  const fence = useFence.getState();
  const sync = fenceSync(fence);
  const openLog = useLogs.getState().open;
  return buildLiveContext({
    now: Date.now(),
    path,
    share: useSettings.getState().aiShare,
    status: link.status,
    virtual: link.virtual,
    vehicle: link.vehicle,
    telemetry: link.telemetry,
    events: link.events,
    params: params.values,
    paramCount: params.received,
    plan: { points: sim.points, ending: sim.ending, takeoffAlt: sim.takeoffAlt },
    fence: { zones: fence.zones, limits: fence.limits, sentAndSame: sync.known ? sync.same : null },
    log: path === "/logs" && openLog ? logBrief(openLog.flight, openLog.analysis, openLog.name) : null,
  });
}

/** The finished exchanges, as the API takes them. A question whose answer failed is left out with it. */
export function apiTurns(turns: Turn[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "user") continue;
    const a = turns[i + 1];
    if (!a || a.role !== "assistant" || typeof a.content === "string") continue;
    if (a.status === "done" && a.content.length) {
      out.push({ role: "user", content: t.content as string }, { role: "assistant", content: a.content });
    } else if (a.status === "stopped") {
      // Cut off mid-way, perhaps inside a search: only its words go back.
      const text = a.content.map((b) => (b.type === "text" ? String((b as { text?: string }).text ?? "") : "")).join("").trim();
      if (text) out.push({ role: "user", content: t.content as string }, { role: "assistant", content: `${text}\n\n(The person stopped this answer here.)` });
    }
  }
  return out;
}

export const useAssistant = create<AssistantState>((set, get) => {
  const patch = (id: number, p: Partial<Turn>) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

  return {
    turns: [],
    busy: false,
    draft: "",
    setDraft: (draft) => set({ draft }),

    send: async (raw) => {
      const question = raw.trim();
      if (!question || get().busy) return;
      const { aiKey, aiModel, aiWeb } = useSettings.getState();
      const before = apiTurns(get().turns);
      const user: Turn = { id: nextId++, role: "user", content: question, at: Date.now() };
      const answer: Turn = { id: nextId++, role: "assistant", content: [], at: Date.now(), status: "streaming" };
      set((s) => ({ turns: [...s.turns, user, answer], busy: true, draft: "" }));

      if (!aiKey) {
        patch(answer.id, { status: "offline", hits: searchManual(question) });
        set({ busy: false });
        return;
      }

      const tools: Tool[] = aiWeb ? [WEB_SEARCH, WEB_FETCH] : [];
      controller = new AbortController();
      try {
        const r = await ask({
          apiKey: aiKey,
          model: aiModel,
          system: systemBlocks(liveSnapshot()),
          messages: historyFor([...before, { role: "user", content: question }], tools),
          tools,
          signal: controller.signal,
          onUpdate: (content) => patch(answer.id, { content }),
        });
        patch(answer.id, { content: r.content, status: "done", dropped: r.dropped.length ? r.dropped : undefined, truncated: r.stopReason === "max_tokens", usage: r.usage });
      } catch (e) {
        if ((e as Error).name === "AbortError") patch(answer.id, { status: "stopped" });
        else {
          const offline = e instanceof AssistantError && e.kind === "network";
          patch(answer.id, { status: "error", error: (e as Error).message, hits: offline ? searchManual(question) : undefined });
        }
      } finally {
        controller = null;
        set({ busy: false });
      }
    },

    stop: () => controller?.abort(),

    clear: () => {
      controller?.abort();
      set({ turns: [], busy: false });
    },
  };
});

/** Open the assistant and ask it something, from anywhere in the app. */
export async function askAssistant(question: string, open: () => void): Promise<void> {
  open();
  await useAssistant.getState().send(question);
}
