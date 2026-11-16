import { MessageCircleQuestion, Sparkles } from "lucide-react";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { askAssistant, useAssistant } from "../assistant/store";
import type { Finding } from "./diagnostics";

/*
  Questions about the findings go to the AERONEX Assistant, which sees the
  same findings with every question (and the rest of the aircraft, and the
  manual). This card is where they start from on this page; there is one
  conversation, whichever page it began on.
*/
export function AskDoctor({ findings }: { findings: Finding[] }) {
  const hasKey = useSettings((s) => !!s.aiKey);
  const busy = useAssistant((s) => s.busy);
  const open = () => useUi.getState().open("assistant");
  const issues = findings.filter((f) => f.severity === "critical" || f.severity === "warn").slice(0, 3);
  const questions = [
    ...(issues.length > 1 ? ["Explain my Drone Doctor findings and how to fix each one, most important first."] : []),
    ...issues.map((f) => `Help me fix this Drone Doctor finding: ${f.title}${f.metric ? ` (${f.metric})` : ""}.`),
    ...(issues.length ? [] : ["What should I check on the aircraft before its first flight?", "What causes high vibration and how do I reduce it?"]),
  ].slice(0, 4);

  return (
    <section className="panel ask-panel">
      <div className="panel-head">
        <h3>
          <MessageCircleQuestion size={17} /> Ask about these findings
        </h3>
      </div>
      <div className="panel-body ask-body">
        <p className="ask-empty">
          The assistant sees these findings, the aircraft's readings and settings, and knows every page of AERONEX. Ask it why something is flagged, how to fix it, or anything else about the build.
          {!hasKey && " It needs your Anthropic API key; without one it searches the AERONEX manual instead."}
        </p>
        <div className="ask-starters">
          {questions.map((q) => (
            <button key={q} className="ask-starter" disabled={busy} onClick={() => void askAssistant(q, open)}>
              {q}
            </button>
          ))}
        </div>
        <button className="btn" onClick={open}>
          <Sparkles size={15} /> Open the assistant
        </button>
      </div>
    </section>
  );
}
