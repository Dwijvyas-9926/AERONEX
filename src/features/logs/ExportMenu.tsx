import { ChevronDown, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { baseName, saveFile, toKml, toParamFile, toReport } from "../../logs/export";
import { readLogBytes } from "../../logs/library";
import { useLogs } from "./store";

export function ExportMenu() {
  const open = useLogs((s) => s.open);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setShow(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setShow(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [show]);
  if (!open) return null;
  const f = open.flight;
  const base = baseName(open.name);
  const items: { label: string; detail: string; run: () => void | Promise<void>; disabled?: boolean }[] = [
    { label: "Report", detail: "What the checks found, as a text file (Markdown)", run: () => saveFile(`${base} report.md`, toReport(f, open.analysis), "text/markdown") },
    { label: "Flight path", detail: "KML, for Google Earth", run: () => saveFile(`${base}.kml`, toKml(f), "application/vnd.google-earth.kml+xml"), disabled: !f.pos },
    { label: "Parameters", detail: ".param, loads in Mission Planner and QGroundControl", run: () => saveFile(`${base}.param`, toParamFile(f)), disabled: !f.params.size },
    {
      label: "The log itself",
      detail: open.id ? `${open.name}, from the library` : "Only for logs kept in the library",
      disabled: !open.id,
      run: async () => saveFile(`${base}.${f.kind}`, await readLogBytes(open.id!), "application/octet-stream"),
    },
  ];
  return (
    <div className="lp-menu" ref={box}>
      <button className="btn" aria-haspopup="menu" aria-expanded={show} onClick={() => setShow((s) => !s)}>
        <Download size={15} /> Export <ChevronDown size={14} />
      </button>
      {show && (
        <div className="lp-menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              onClick={async () => {
                setErr(null);
                try {
                  await it.run();
                  setShow(false);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <strong>{it.label}</strong>
              <span>{it.detail}</span>
            </button>
          ))}
          {err && <p className="lp-err">{err}</p>}
        </div>
      )}
    </div>
  );
}
