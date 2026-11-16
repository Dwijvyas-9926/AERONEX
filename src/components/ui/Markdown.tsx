import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/*
  Markdown as the assistant writes it, drawn as React elements: headings,
  paragraphs, ordered and bulleted lists (one level of nesting), code, tables,
  quotes, bold, italics and links. Never HTML: nothing in an answer can put
  markup or script on the page.

  Links go where they safely can: "#/page" opens that page of the app,
  http(s) opens a new tab, anything else stays plain text. A link whose text
  is only a number is a citation and is drawn as a small superscript.
*/

type Props = { text: string; onNavigate?: () => void };

const SAFE_URL = /^https?:\/\//i;

function InlineLink({ label, href, onNavigate }: { label: string; href: string; onNavigate?: () => void }) {
  if (href.startsWith("#/")) {
    return (
      <Link to={href.slice(1)} className="md-page" onClick={onNavigate}>
        <Inline text={label} onNavigate={onNavigate} />
      </Link>
    );
  }
  if (SAFE_URL.test(href)) {
    if (/^\d+$/.test(label)) {
      return (
        <sup className="md-cite">
          <a href={href} target="_blank" rel="noreferrer" title={href}>
            {label}
          </a>
        </sup>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer">
        <Inline text={label} onNavigate={onNavigate} />
      </a>
    );
  }
  return <Inline text={label} onNavigate={onNavigate} />;
}

const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s\n][^*\n]*?\*|https?:\/\/[^\s)<>"]+[^\s)<>".,;:!?'])/g;

export function Inline({ text, onNavigate }: Props) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        if (p.startsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith("**")) return <strong key={i}><Inline text={p.slice(2, -2)} onNavigate={onNavigate} /></strong>;
        if (p.startsWith("[")) {
          const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p)!;
          return <InlineLink key={i} label={m[1]} href={m[2]} onNavigate={onNavigate} />;
        }
        if (p.startsWith("*")) return <em key={i}><Inline text={p.slice(1, -1)} onNavigate={onNavigate} /></em>;
        return (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        );
      })}
    </>
  );
}

interface ListItem {
  text: string;
  sub: { ordered: boolean; items: string[] } | null;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Block-level markdown. */
export function Markdown({ text, onNavigate }: Props) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const inl = (t: string) => <Inline text={t} onNavigate={onNavigate} />;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    // Code fence
    if (t.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={out.length} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as "h2" | "h3" | "h4";
      out.push(<Tag key={out.length} className="md-h">{inl(h[2])}</Tag>);
      i++;
      continue;
    }
    // Rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push(<hr key={out.length} />);
      i++;
      continue;
    }
    // Table: a header row, then a separator row
    if (t.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      const head = cells(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        <div key={out.length} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, k) => <th key={k}>{inl(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, k) => <td key={k}>{inl(r[k] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Quote
    if (t.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) body.push(lines[i++].trim().replace(/^>\s?/, ""));
      out.push(
        <blockquote key={out.length}>
          <Markdown text={body.join("\n")} onNavigate={onNavigate} />
        </blockquote>,
      );
      continue;
    }
    // List, with one level of nesting by indentation
    const lm = LIST.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const start = ordered ? parseInt(lm[2], 10) : 1;
      const baseIndent = lm[1].length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST.exec(l);
        if (m && m[1].length <= baseIndent + 1) {
          if (/\d/.test(m[2]) !== ordered) break;
          items.push({ text: m[3], sub: null });
          i++;
        } else if (m && items.length) {
          const last = items[items.length - 1];
          last.sub ??= { ordered: /\d/.test(m[2]), items: [] };
          last.sub.items.push(m[3]);
          i++;
        } else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          // A continuation line of the last item.
          items[items.length - 1].text += ` ${l.trim()}`;
          i++;
        } else if (!l.trim() && i + 1 < lines.length && LIST.exec(lines[i + 1]) && /\d/.test(LIST.exec(lines[i + 1])![2]) === ordered && LIST.exec(lines[i + 1])![1].length <= baseIndent + 1) {
          // A blank line between items of the same list.
          i++;
        } else break;
      }
      const li = items.map((it, k) => (
        <li key={k}>
          {inl(it.text)}
          {it.sub && (it.sub.ordered ? <ol>{it.sub.items.map((s, j) => <li key={j}>{inl(s)}</li>)}</ol> : <ul>{it.sub.items.map((s, j) => <li key={j}>{inl(s)}</li>)}</ul>)}
        </li>
      ));
      out.push(ordered ? <ol key={out.length} start={start}>{li}</ol> : <ul key={out.length}>{li}</ul>);
      continue;
    }
    // Paragraph: consecutive plain lines
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || l.startsWith("```") || /^#{1,6}\s/.test(l) || LIST.test(lines[i]) || l.startsWith(">") || (l.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim()))) break;
      para.push(l);
      i++;
    }
    if (!para.length) {
      // Nothing above took this line: show it as it is rather than stall on it.
      para.push(lines[i].trim());
      i++;
    }
    out.push(<p key={out.length}>{inl(para.join(" "))}</p>);
  }
  return <>{out}</>;
}
