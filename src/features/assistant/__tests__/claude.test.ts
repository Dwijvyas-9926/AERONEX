import { describe, expect, it } from "vitest";
import { ask, AssistantError, historyFor, readAnswer, WEB_FETCH, WEB_SEARCH, type ApiMessage, type ContentBlock } from "../claude";

/** A response streaming these events, as the API sends them. */
const sse = (events: object[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        // Split mid-event to check events are put back together across chunks.
        const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
        const cut = Math.floor(body.length / 2);
        c.enqueue(enc.encode(body.slice(0, cut)));
        c.enqueue(enc.encode(body.slice(cut)));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const URL1 = "https://ardupilot.org/copter/docs/gcs-failsafe.html";

const searchRound = [
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 90 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check. " } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"ardu' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'pilot FS_GCS_ENABLE"}' } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: URL1, title: "GCS Failsafe", encrypted_content: "ENC-abc", page_age: null }] },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 20, server_tool_use: { web_search_requests: 1 } } },
  { type: "message_stop" },
];

const answerRound = [
  { type: "message_start", message: { usage: { input_tokens: 50 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: URL1, title: "GCS Failsafe", cited_text: "5: Land", encrypted_index: "IDX" } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Set `FS_GCS_ENABLE` = 5 (Land)." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
];

function fakeFetch(responses: (() => Response)[]) {
  const bodies: { tools?: { name: string }[]; messages: ApiMessage[] }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const base = { apiKey: "k", model: "claude-sonnet-5-5", system: [{ type: "text" as const, text: "sys" }], messages: [{ role: "user" as const, content: "What should FS_GCS_ENABLE be?" }] };

describe("asking the API", () => {
  it("assembles a streamed answer, carries on after pause_turn, and keeps every block to send back", async () => {
    const { f, bodies } = fakeFetch([() => sse(searchRound), () => sse(answerRound)]);
    const seen: number[] = [];
    const r = await ask({ ...base, tools: [WEB_SEARCH, WEB_FETCH], fetchImpl: f, onUpdate: (c) => seen.push(c.length) });

    expect(r.stopReason).toBe("end_turn");
    expect(r.content.map((b) => b.type)).toEqual(["text", "server_tool_use", "web_search_tool_result", "text"]);
    expect((r.content[1] as { input: unknown }).input).toEqual({ query: "ardupilot FS_GCS_ENABLE" });
    expect(seen.length).toBeGreaterThan(3);
    // The second request continued the same turn with the paused answer, untouched.
    expect(bodies).toHaveLength(2);
    const cont = bodies[1].messages.at(-1)!;
    expect(cont.role).toBe("assistant");
    expect(JSON.stringify(cont.content)).toContain("ENC-abc");
    expect(r.usage.input_tokens).toBe(150);
    expect(r.usage.output_tokens).toBe(32);
    expect(r.usage.server_tool_use?.web_search_requests).toBe(1);

    const read = readAnswer(r.content);
    expect(read.markdown).toBe(`Let me check. Set \`FS_GCS_ENABLE\` = 5 (Land). [1](${URL1})`);
    expect(read.sources).toEqual([{ n: 1, url: URL1, title: "GCS Failsafe" }]);
    expect(read.activity).toEqual([{ kind: "search", what: "ardupilot FS_GCS_ENABLE" }]);
  });

  it("answers without a web tool the account has turned off, and says which", async () => {
    const refused = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "web fetch is not enabled for this organization" } }), { status: 400 });
    const { f, bodies } = fakeFetch([refused, () => sse(answerRound)]);
    const r = await ask({ ...base, tools: [WEB_SEARCH, WEB_FETCH], fetchImpl: f });
    expect(r.dropped).toEqual(["web_fetch"]);
    expect(bodies[1].tools!.map((t) => t.name)).toEqual(["web_search"]);
  });

  it("turns HTTP failures into words a person can act on", async () => {
    const cases: [number, string, AssistantError["kind"], RegExp][] = [
      [401, "invalid x-api-key", "key", /rejected the API key/],
      [404, "model: claude-x not found", "model", /not available on this account/],
      [429, "rate", "rate", /Too many requests/],
      [529, "Overloaded", "overloaded", /overloaded/],
      [400, "Your credit balance is too low", "key", /no credit/],
    ];
    for (const [status, message, kind, words] of cases) {
      const { f } = fakeFetch([() => new Response(JSON.stringify({ error: { message } }), { status })]);
      const e = await ask({ ...base, tools: [], fetchImpl: f }).catch((x) => x);
      expect(e).toBeInstanceOf(AssistantError);
      expect(e.kind).toBe(kind);
      expect(e.message).toMatch(words);
    }
  });

  it("reports an error that arrives in the middle of the stream", async () => {
    const { f } = fakeFetch([() => sse([answerRound[0], answerRound[1], { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])]);
    const e = await ask({ ...base, tools: [], fetchImpl: f }).catch((x) => x);
    expect(e.kind).toBe("overloaded");
  });

  it("says when Anthropic cannot be reached", async () => {
    const f = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const e = await ask({ ...base, tools: [], fetchImpl: f }).catch((x) => x);
    expect(e.kind).toBe("network");
  });
});

describe("reading an answer", () => {
  it("numbers each source once and marks the passages that cite it", () => {
    const c: ContentBlock[] = [
      { type: "text", text: "A", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "A page" }] },
      { type: "text", text: " B", citations: [{ type: "web_search_result_location", url: "https://b.example/y", title: "B page" }] },
      { type: "text", text: " C", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "A page" }] },
    ];
    const r = readAnswer(c);
    expect(r.sources.map((s) => s.n)).toEqual([1, 2]);
    expect(r.markdown).toBe("A [1](https://a.example/x) B [2](https://b.example/y) C [1](https://a.example/x)");
  });

  it("credits a fetched page, and shows a failed look-up as failed", () => {
    const c: ContentBlock[] = [
      { type: "server_tool_use", id: "t1", name: "web_fetch", input: { url: "https://ardupilot.org/x" } },
      { type: "web_fetch_tool_result", tool_use_id: "t1", content: { type: "web_fetch_result", url: "https://ardupilot.org/x", content: { type: "document", title: "Fence docs" } } },
      { type: "server_tool_use", id: "t2", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "t2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      { type: "text", text: "Fences.", citations: [{ type: "char_location", document_index: 0, document_title: "Fence docs", cited_text: "…" }] },
    ];
    const r = readAnswer(c);
    expect(r.sources).toEqual([{ n: 1, url: "https://ardupilot.org/x", title: "Fence docs" }]);
    expect(r.activity[1].failed).toBe("max_uses_exceeded");
  });
});

describe("the history sent with a question", () => {
  const full: ContentBlock[] = [
    { type: "server_tool_use", id: "s", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "u", encrypted_content: "BIG" }] },
    { type: "text", text: "Answer" },
  ];
  const turns: ApiMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: full },
    { role: "user", content: "two" },
    { role: "assistant", content: full },
    { role: "user", content: "three" },
  ];

  it("sends the last answer whole and older ones as their words", () => {
    const h = historyFor(turns, [WEB_SEARCH]);
    expect(h[1].content).toBe("Answer");
    expect(h[3].content).toEqual(full);
    expect(h[4]).toEqual({ role: "user", content: "three" });
  });

  it("sends no search results when searching is off", () => {
    const h = historyFor(turns, []);
    expect(h[3].content).toBe("Answer");
  });

  it("starts with a question, and keeps to the most recent exchanges", () => {
    const many: ApiMessage[] = [];
    for (let i = 0; i < 30; i++) many.push({ role: "user", content: `q${i}` }, { role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    many.push({ role: "user", content: "last" });
    const h = historyFor(many, []);
    expect(h[0].role).toBe("user");
    expect(h.length).toBeLessThanOrEqual(16);
    expect(h.at(-1)!.content).toBe("last");
  });
});
