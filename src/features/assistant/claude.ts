/*
  The Anthropic Messages API, called straight from the browser with the
  person's own key. There is no AERONEX server: the key and the question go
  to api.anthropic.com and nowhere else.

  Answers stream as the API's content blocks, kept whole: text with its
  citations, and the web search and web fetch calls the API runs itself.
  They are kept whole because a follow-up question must send them back
  exactly as they came (the search results carry encrypted content the API
  needs to see again), and because the citations are what let the answer
  show its sources.

  A long search can end a response early with stop_reason "pause_turn": the
  answer so far is sent back as it is and the API carries on from there.
*/
import type { SystemBlock } from "./prompt";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface Citation {
  type: string;
  url?: string;
  title?: string | null;
  cited_text?: string;
  document_title?: string | null;
  document_index?: number;
  [k: string]: unknown;
}

export interface TextBlock {
  type: "text";
  text: string;
  citations?: Citation[] | null;
}
export interface ServerToolUse {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface OtherBlock {
  type: string;
  [k: string]: unknown;
}
export type ContentBlock = TextBlock | ServerToolUse | OtherBlock;

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type Tool = { type: string; name: string; [k: string]: unknown };

/** Web search, run by the API. At most a few per question: each one is billed. */
export const WEB_SEARCH: Tool = { type: "web_search_20250305", name: "web_search", max_uses: 4 };
/** Reading a page the conversation already contains, run by the API. Costs only its tokens. */
export const WEB_FETCH: Tool = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3, citations: { enabled: true }, max_content_tokens: 6000 };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

export interface AskOptions {
  apiKey: string;
  model: string;
  system: SystemBlock[];
  messages: ApiMessage[];
  tools: Tool[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with the whole answer so far each time it grows. */
  onUpdate?: (content: ContentBlock[]) => void;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export interface AskResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  /** Tools the account would not allow, dropped so the question could still be answered. */
  dropped: string[];
}

/** An error with a message fit to show the person, and what kind it was. */
export class AssistantError extends Error {
  kind: "network" | "key" | "model" | "rate" | "overloaded" | "request" | "stream";
  constructor(kind: AssistantError["kind"], message: string) {
    super(message);
    this.kind = kind;
    this.name = "AssistantError";
  }
}

/* ------------------------------------------------------------------ */
/* Stream assembly                                                     */
/* ------------------------------------------------------------------ */

export interface StreamState {
  blocks: ContentBlock[];
  /** Tool input arriving as JSON fragments, by block index. */
  json: Map<number, string>;
  stopReason: string | null;
  usage: Usage;
}

export const newStream = (): StreamState => ({ blocks: [], json: new Map(), stopReason: null, usage: {} });

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: ContentBlock;
  delta?: { type?: string; text?: string; partial_json?: string; citation?: Citation; stop_reason?: string };
  usage?: Usage;
  message?: { usage?: Usage };
  error?: { type?: string; message?: string };
}

/**
 * Fold one server-sent event into the answer. Pure apart from mutating the
 * state, so a recorded stream can be replayed in a test.
 */
export function applyEvent(s: StreamState, e: StreamEvent): void {
  switch (e.type) {
    case "message_start":
      if (e.message?.usage) s.usage = { ...s.usage, ...e.message.usage };
      break;
    case "content_block_start": {
      const b = structuredClone(e.content_block!) as ContentBlock;
      if (b.type === "text") (b as TextBlock).text = (b as TextBlock).text ?? "";
      if (b.type === "server_tool_use") s.json.set(e.index!, "");
      s.blocks[e.index!] = b;
      break;
    }
    case "content_block_delta": {
      const b = s.blocks[e.index!];
      const d = e.delta ?? {};
      if (!b) break;
      if (d.type === "text_delta" && b.type === "text") (b as TextBlock).text += d.text ?? "";
      else if (d.type === "citations_delta" && b.type === "text" && d.citation) ((b as TextBlock).citations ??= []).push(d.citation);
      else if (d.type === "input_json_delta") s.json.set(e.index!, (s.json.get(e.index!) ?? "") + (d.partial_json ?? ""));
      break;
    }
    case "content_block_stop": {
      const b = s.blocks[e.index!];
      if (b?.type === "server_tool_use" && s.json.has(e.index!)) {
        const raw = s.json.get(e.index!)!;
        try {
          (b as ServerToolUse).input = raw ? JSON.parse(raw) : {};
        } catch {
          (b as ServerToolUse).input = {};
        }
        s.json.delete(e.index!);
      }
      break;
    }
    case "message_delta":
      if (e.delta?.stop_reason) s.stopReason = e.delta.stop_reason;
      if (e.usage) s.usage = { ...s.usage, ...e.usage };
      break;
    case "error":
      throw new AssistantError(e.error?.type === "overloaded_error" ? "overloaded" : "stream", e.error?.type === "overloaded_error" ? "Anthropic is overloaded right now. Try again in a minute." : (e.error?.message ?? "The answer stopped with an error."));
    default:
      break;
  }
}

/** Split a body of server-sent events into parsed events; returns the unfinished tail. */
export function parseEvents(buffer: string, emit: (e: StreamEvent) => void): string {
  const parts = buffer.split(/\r?\n\r?\n/);
  const tail = parts.pop() ?? "";
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let parsed: StreamEvent;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    emit(parsed);
  }
  return tail;
}

/* ------------------------------------------------------------------ */
/* The request                                                         */
/* ------------------------------------------------------------------ */

function friendly(status: number, detail: string | undefined, model: string): AssistantError {
  if (status === 401) return new AssistantError("key", "Anthropic rejected the API key (401). Paste it again in Settings.");
  if (status === 403) return new AssistantError("key", `This API key is not allowed to do that (403)${detail ? `: ${detail}` : "."}`);
  if (status === 404 && /model/i.test(detail ?? "")) return new AssistantError("model", `The model "${model}" is not available on this account. Choose another in Settings.`);
  if (status === 429) return new AssistantError("rate", "Too many requests for this key just now (429). Wait a moment and ask again.");
  if (status === 529 || status === 503) return new AssistantError("overloaded", "Anthropic is overloaded right now. Try again in a minute.");
  if (status === 400 && /credit balance/i.test(detail ?? "")) return new AssistantError("key", "The Anthropic account has no credit left. Add credit in the Anthropic Console, then ask again.");
  return new AssistantError("request", detail ? `Anthropic said: ${detail}` : `The request failed (HTTP ${status}).`);
}

/** Which tool a 400 says this account cannot use, if that is what it says. */
export function refusedTool(detail: string, tools: Tool[]): string | null {
  const t = tools.find((x) => detail.includes(x.name) || detail.includes(x.type) || (x.name === "web_search" && /web search/i.test(detail)) || (x.name === "web_fetch" && /web fetch/i.test(detail)));
  return t ? t.name : null;
}

async function once(o: AskOptions, messages: ApiMessage[], tools: Tool[], state: StreamState, before: ContentBlock[]): Promise<void> {
  const doFetch = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": o.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: o.model,
        max_tokens: o.maxTokens ?? 4096,
        system: o.system,
        messages,
        ...(tools.length ? { tools } : {}),
        stream: true,
      }),
      signal: o.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AssistantError("network", "Could not reach Anthropic. Check the internet connection.");
  }
  if (!res.ok || !res.body) {
    let detail: string | undefined;
    try {
      detail = (await res.json())?.error?.message;
    } catch {
      /* not JSON */
    }
    const err = friendly(res.status, detail, o.model);
    (err as AssistantError & { status?: number; detail?: string }).status = res.status;
    (err as AssistantError & { status?: number; detail?: string }).detail = detail;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseEvents(buffer, (e) => {
      applyEvent(state, e);
      if (e.type.startsWith("content_block")) o.onUpdate?.([...before, ...state.blocks.filter(Boolean)]);
    });
  }
  parseEvents(buffer + "\n\n", (e) => applyEvent(state, e));
}

/**
 * Ask, and stream the answer. Continues across pause_turn, and drops a web
 * tool the account has turned off rather than failing the question.
 */
export async function ask(o: AskOptions): Promise<AskResult> {
  let tools = [...o.tools];
  const dropped: string[] = [];
  let content: ContentBlock[] = [];
  let usage: Usage = {};
  let stopReason: string | null = null;

  for (let round = 0; round < 5; round++) {
    const messages = content.length ? [...o.messages, { role: "assistant" as const, content }] : o.messages;
    const state = newStream();
    try {
      await once(o, messages, tools, state, content);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const detail = (e as { detail?: string }).detail ?? "";
      const which = status === 400 && !state.blocks.length ? refusedTool(detail, tools) : null;
      if (which) {
        tools = tools.filter((t) => t.name !== which);
        dropped.push(which);
        round--;
        continue;
      }
      throw e;
    }
    content = [...content, ...state.blocks.filter(Boolean)];
    usage = sumUsage(usage, state.usage);
    stopReason = state.stopReason;
    if (stopReason !== "pause_turn") break;
  }
  return { content, stopReason, usage, dropped };
}

function sumUsage(a: Usage, b: Usage): Usage {
  const n = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  return {
    input_tokens: n(a.input_tokens, b.input_tokens),
    output_tokens: n(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: n(a.cache_read_input_tokens, b.cache_read_input_tokens),
    cache_creation_input_tokens: n(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
    server_tool_use: {
      web_search_requests: n(a.server_tool_use?.web_search_requests, b.server_tool_use?.web_search_requests),
      web_fetch_requests: n(a.server_tool_use?.web_fetch_requests, b.server_tool_use?.web_fetch_requests),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reading an answer                                                   */
/* ------------------------------------------------------------------ */

export interface Source {
  n: number;
  url: string;
  title: string;
}

export interface Reading {
  /** The answer as markdown, with each cited passage followed by its source number as a link. */
  markdown: string;
  sources: Source[];
  /** What was searched for and read, in order. */
  activity: { kind: "search" | "fetch"; what: string; failed?: string }[];
}

const textOf = (b: ContentBlock): string => (b.type === "text" ? ((b as TextBlock).text ?? "") : "");

/** Turn the blocks of an answer into what is shown: the text, its sources and what was looked up. */
export function readAnswer(content: ContentBlock[]): Reading {
  const sources: Source[] = [];
  const activity: Reading["activity"] = [];
  const fetched: { url: string; title: string }[] = [];
  const numberOf = (url: string, title: string) => {
    let s = sources.find((x) => x.url === url);
    if (!s) sources.push((s = { n: sources.length + 1, url, title: title || url }));
    return s.n;
  };
  let md = "";
  const calls = new Map<string, number>();
  for (const b of content) {
    if (b.type === "server_tool_use") {
      const u = b as ServerToolUse;
      const what = String(u.name === "web_search" ? (u.input?.query ?? "") : (u.input?.url ?? ""));
      calls.set(u.id, activity.push({ kind: u.name === "web_fetch" ? "fetch" : "search", what }) - 1);
    } else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
      const c = b.content as { type?: string; error_code?: string; url?: string; content?: { title?: string } } | unknown[];
      const i = calls.get(String(b.tool_use_id));
      if (!Array.isArray(c) && c?.type?.endsWith("_error") && i !== undefined) activity[i].failed = c.error_code ?? "error";
      if (b.type === "web_fetch_tool_result" && !Array.isArray(c) && c?.url) fetched.push({ url: c.url, title: c.content?.title ?? c.url });
    } else if (b.type === "text") {
      const t = b as TextBlock;
      md += t.text;
      const marks = new Set<number>();
      for (const c of t.citations ?? []) {
        if (c.url) marks.add(numberOf(c.url, c.title ?? ""));
        else if (c.document_title || c.document_index !== undefined) {
          const f = fetched.find((x) => x.title === c.document_title) ?? fetched.at(-1);
          if (f) marks.add(numberOf(f.url, f.title));
        }
      }
      if (marks.size) md += [...marks].map((n) => ` [${n}](${sources[n - 1].url})`).join("");
    }
  }
  return { markdown: md.trim(), sources, activity };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** The most recent exchanges sent with each question. */
export const HISTORY_MESSAGES = 16;

/**
 * The conversation as it is sent with the next question. The last answer
 * goes back whole, so a follow-up can build on its sources; older answers
 * go back as their text alone, because search results and fetched pages are
 * large and are paid for again with every question.
 */
export function historyFor(turns: ApiMessage[], tools: Tool[]): ApiMessage[] {
  let recent = turns.slice(-HISTORY_MESSAGES);
  while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
  const lastAssistant = recent.map((m) => m.role).lastIndexOf("assistant");
  // A tool's results can only go back in a request that offers the tool.
  const usable = (c: ContentBlock[]) => c.every((b) => b.type !== "server_tool_use" || tools.some((t) => t.name === (b as ServerToolUse).name));
  return recent.map((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    if (i === lastAssistant && usable(m.content)) return { role: m.role, content: m.content.filter((b) => b.type !== "text" || textOf(b)) };
    const text = m.content.map(textOf).join("").trim();
    return { role: m.role, content: text || "(no answer)" };
  });
}
