import { BookOpen, Check, Copy, ExternalLink, Eye, Globe, KeyRound, Send, Sparkles, Square, SquarePen, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { routeFor } from "../../app/routes";
import { Markdown } from "../../components/ui/Markdown";
import { useLink } from "../../state/linkStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { readAnswer, type ContentBlock } from "./claude";
import type { Hit } from "./offline";
import { startersFor } from "./starters";
import { liveSnapshot, useAssistant, type Turn } from "./store";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function ManualHits({ hits, onNavigate }: { hits: Hit[]; onNavigate: () => void }) {
  if (!hits.length) return <p className="as-note">Nothing in the AERONEX manual matches that. Try other words, such as the page's name.</p>;
  return (
    <div className="as-hits">
      {hits.map((h) => (
        <section key={h.topic.id} className="as-hit">
          <h4>
            <BookOpen aria-hidden />
            {h.topic.path ? (
              <Link to={h.topic.path} onClick={onNavigate}>
                {h.topic.title.replace(/ \(#.*\)$/, "")}
              </Link>
            ) : (
              h.topic.title
            )}
          </h4>
          <div className="as-md">
            <Markdown text={h.text} onNavigate={onNavigate} />
          </div>
        </section>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="as-mini"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
      aria-label="Copy the answer"
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />} {done ? "Copied" : "Copy"}
    </button>
  );
}

function Answer({ turn, onNavigate }: { turn: Turn; onNavigate: () => void }) {
  const r = readAnswer(turn.content as ContentBlock[]);
  const streaming = turn.status === "streaming";
  const last = r.activity.at(-1);
  const working = streaming && !r.markdown;

  return (
    <div className="as-answer">
      {r.activity.length > 0 && (
        <ul className="as-activity" aria-label="What the assistant looked up">
          {r.activity.map((a, i) => (
            <li key={i} className={a.failed ? "failed" : undefined}>
              <Globe aria-hidden />
              {a.kind === "search" ? <>Searched “{a.what}”</> : <>Read {host(a.what)}</>}
              {a.failed && <span> (failed: {a.failed.replace(/_/g, " ")})</span>}
            </li>
          ))}
        </ul>
      )}

      {working && (
        <p className="as-working" role="status">
          <span className="ask-typing">
            <span />
            <span />
            <span />
          </span>
          {last && !last.failed ? (last.kind === "search" ? `Searching the web for “${last.what}”…` : `Reading ${host(last.what)}…`) : "Thinking…"}
        </p>
      )}

      {r.markdown && (
        <div className="as-md">
          <Markdown text={r.markdown} onNavigate={onNavigate} />
        </div>
      )}

      {r.sources.length > 0 && (
        <ol className="as-sources" aria-label="Sources">
          {r.sources.map((s) => (
            <li key={s.n}>
              <a href={s.url} target="_blank" rel="noreferrer">
                <span className="as-src-n">{s.n}</span>
                <span className="as-src-t">{s.title}</span>
                <span className="as-src-h">
                  {host(s.url)} <ExternalLink aria-hidden />
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}

      {turn.status === "offline" && (
        <>
          <p className="as-note">There is no API key, so this is what the AERONEX manual says, found by matching words. Add a key in Settings for real answers.</p>
          <ManualHits hits={turn.hits ?? []} onNavigate={onNavigate} />
        </>
      )}

      {turn.status === "error" && (
        <>
          <div className="callout warn as-error">
            <TriangleAlert />
            <span>{turn.error}</span>
          </div>
          {turn.hits && (
            <>
              <p className="as-note">Meanwhile, the AERONEX manual on this computer says:</p>
              <ManualHits hits={turn.hits} onNavigate={onNavigate} />
            </>
          )}
        </>
      )}

      {turn.status === "stopped" && <p className="as-note">Stopped.</p>}
      {turn.truncated && <p className="as-note">The answer reached its length limit. Ask “go on” for the rest.</p>}
      {turn.dropped?.length ? <p className="as-note">Web {turn.dropped.map((d) => (d === "web_search" ? "search" : "reading")).join(" and ")} is turned off for this Anthropic account, so this was answered without it.</p> : null}

      {turn.status === "done" && r.markdown && (
        <div className="as-actions">
          <CopyButton text={r.markdown} />
        </div>
      )}
    </div>
  );
}

function KeySetup() {
  const setSetting = useSettings((s) => s.set);
  const [draft, setDraft] = useState("");
  const save = () => draft.trim() && setSetting("aiKey", draft.trim());
  return (
    <section className="as-setup">
      <h3>
        <KeyRound aria-hidden /> Add an Anthropic API key
      </h3>
      <p>The assistant runs on your own key. AERONEX has no server: the key and your questions go only to Anthropic, which bills the key's account per question.</p>
      <ol>
        <li>
          Open{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>{" "}
          and sign up or sign in.
        </li>
        <li>Add credit under Billing.</li>
        <li>Under API keys, press Create key and copy it.</li>
        <li>Paste it here.</li>
      </ol>
      <div className="as-key">
        <input className="input" type="password" placeholder="sk-ant-…" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} aria-label="Anthropic API key" />
        <button className="btn btn-primary" disabled={!draft.trim()} onClick={save}>
          Save
        </button>
      </div>
      <p className="as-fine">Kept until this tab closes, unless “Remember keys on this device” is on in <Link to="/settings">Settings</Link>. Until then, questions are answered from the AERONEX manual on this computer.</p>
    </section>
  );
}

export function AssistantPanel() {
  const open = useUi((s) => s.overlay === "assistant");
  const close = useUi((s) => s.close);
  const { pathname } = useLocation();
  const route = routeFor(pathname);
  const turns = useAssistant((s) => s.turns);
  const busy = useAssistant((s) => s.busy);
  const draft = useAssistant((s) => s.draft);
  const setDraft = useAssistant((s) => s.setDraft);
  const send = useAssistant((s) => s.send);
  const stop = useAssistant((s) => s.stop);
  const clear = useAssistant((s) => s.clear);
  const aiKey = useSettings((s) => s.aiKey);
  const share = useSettings((s) => s.aiShare);
  const web = useSettings((s) => s.aiWeb);
  const setSetting = useSettings((s) => s.set);
  const vehicle = useLink((s) => s.vehicle);
  const virtual = useLink((s) => s.virtual);
  const [showSent, setShowSent] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Flying from the keyboard, focus stays on the page: keys typed into the
  // composer type instead of flying, and Space there would be a space, not Hold.
  const flyingHere = route.path === "/keyboard-flight" && !!vehicle?.armed;

  useEffect(() => {
    if (!open) return;
    if (!flyingHere) inputRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, close, flyingHere]);

  // Follow the answer as it grows, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // The composer grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, open]);

  // On a phone the panel covers the page, so following a link to a page closes it.
  const onNavigate = () => {
    if (window.innerWidth < 720) close();
  };

  const submit = (text: string) => {
    if (!text.trim() || busy) return;
    stick.current = true;
    void send(text);
  };

  const sees = !share ? "this page only" : vehicle ? `this page and the ${virtual ? "virtual aircraft" : "linked aircraft"}` : "this page (no aircraft linked)";

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="as-panel"
          role="complementary"
          aria-labelledby="as-title"
          initial={{ x: 28, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 28, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <header className="as-head">
            <span className="as-icon">
              <Sparkles aria-hidden />
            </span>
            <div>
              <h2 id="as-title">Assistant</h2>
              <p>AERONEX, and drones in general</p>
            </div>
            {turns.length > 0 && (
              <button className="icon-btn" onClick={clear} aria-label="Start a new conversation" title="New conversation">
                <SquarePen />
              </button>
            )}
            <button className="icon-btn" onClick={close} aria-label="Close the assistant">
              <X />
            </button>
          </header>

          <div
            className="as-scroll"
            ref={scrollRef}
            role="log"
            aria-label="Conversation"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {turns.length === 0 && (
              <div className="as-empty">
                {!aiKey && <KeySetup />}
                <p className="as-intro">
                  Ask how to do something in AERONEX, why the aircraft does what it does, or anything about building and flying a drone. Answers name the page to open and the steps to follow.
                </p>
                <div className="as-starters">
                  {startersFor(route.path).map((s) => (
                    <button key={s} className="ask-starter" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t) =>
              t.role === "user" ? (
                <div key={t.id} className="as-q">
                  {t.content as string}
                </div>
              ) : (
                <Answer key={t.id} turn={t} onNavigate={onNavigate} />
              ),
            )}
          </div>

          <footer className="as-foot">
            {flyingHere && (
              <div className="callout warn as-flying">
                <TriangleAlert />
                <span>The aircraft is armed. While the cursor is in this box, W A S D, Space and L type here instead of flying. Click the page before using them, or use the Hold and Land buttons.</span>
              </div>
            )}
            <div className="as-sees">
              <span>
                <Eye aria-hidden /> Sees {sees}
                {aiKey && web ? ", and can search the web" : ""}.
              </span>
              <button className="as-link" onClick={() => setShowSent((v) => !v)} aria-expanded={showSent}>
                {showSent ? "Hide" : "What is sent"}
              </button>
            </div>
            {showSent && (
              <div className="as-sent">
                <label className="as-switch">
                  <input type="checkbox" checked={share} onChange={(e) => setSetting("aiShare", e.target.checked)} />
                  <span>Share aircraft data with each question</span>
                </label>
                <pre>{liveSnapshot(route.path)}</pre>
                <p>Also sent: your question, the conversation so far and the AERONEX manual. Never the aircraft's position. {aiKey ? "Sent to Anthropic only." : "Nothing is sent until a key is added."}</p>
              </div>
            )}
            <form
              className="as-compose"
              onSubmit={(e) => {
                e.preventDefault();
                submit(draft);
              }}
            >
              <textarea
                ref={inputRef}
                className="input"
                rows={1}
                placeholder={aiKey ? "Ask anything about AERONEX or drones…" : "Search the AERONEX manual…"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(draft);
                  }
                }}
                aria-label="Your question"
              />
              {busy ? (
                <button type="button" className="btn btn-danger as-send" onClick={stop} aria-label="Stop the answer">
                  <Square />
                </button>
              ) : (
                <button type="submit" className="btn btn-primary as-send" disabled={!draft.trim()} aria-label="Ask">
                  <Send />
                </button>
              )}
            </form>
            <p className="as-fine">AI answers can be wrong. Before anything that makes the aircraft move, follow the page's own checks.</p>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
