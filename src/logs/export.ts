/*
  What can be taken out of an opened log: the flight path for Google Earth
  (KML), a written report, the parameters as a .param file Mission Planner
  and QGroundControl load, and any message type as CSV.
*/
import { clock, type Analysis } from "./analyze";
import type { Flight } from "./model";
import { isNumeric, type Table } from "./types";

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** The flight path as KML, altitudes absolute (AMSL), one placemark per flight. */
export function toKml(f: Flight): string {
  const p = f.pos;
  const parts: string[] = [];
  if (p) {
    const spans = f.flying.length ? f.flying : [{ from: 0, to: f.duration, open: false }];
    spans.forEach((s, k) => {
      const coords: string[] = [];
      let last = -Infinity;
      for (let i = 0; i < p.t.length; i++) {
        if (p.t[i] < s.from || p.t[i] > s.to) continue;
        // Five points a second is plenty for a path; more only makes the file big.
        if (p.t[i] - last < 0.2) continue;
        last = p.t[i];
        if (!Number.isFinite(p.lat[i]) || !Number.isFinite(p.lng[i]) || (p.lat[i] === 0 && p.lng[i] === 0)) continue;
        coords.push(`${p.lng[i].toFixed(7)},${p.lat[i].toFixed(7)},${p.alt[i].toFixed(2)}`);
      }
      if (coords.length < 2) return;
      parts.push(`    <Placemark>
      <name>${esc(spans.length > 1 ? `Flight ${k + 1}` : "Flight")} (${clock(s.from)}–${clock(s.to)})</name>
      <styleUrl>#path</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
${coords.map((c) => `          ${c}`).join("\n")}
        </coordinates>
      </LineString>
    </Placemark>`);
    });
  }
  if (f.home) parts.unshift(`    <Placemark>
      <name>Home</name>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${f.home.lng.toFixed(7)},${f.home.lat.toFixed(7)},${f.home.alt.toFixed(2)}</coordinates></Point>
    </Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(f.name)}</name>
    <description>Exported by AERONEX</description>
    <Style id="path"><LineStyle><color>ff2f8ef4</color><width>3</width></LineStyle><PolyStyle><color>402f8ef4</color></PolyStyle></Style>
${parts.join("\n")}
  </Document>
</kml>
`;
}

/** Parameters as NAME,VALUE lines (the format Mission Planner saves and loads). */
export function toParamFile(f: Flight, which: "last" | "first" = "last"): string {
  const lines = [...f.params.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((p) => `${p.name},${fmtParam(which === "last" ? p.last : p.value)}`);
  return `# Parameters from ${f.name}${f.firmware ? ` (${f.firmware})` : ""}, exported by AERONEX\n${lines.join("\n")}\n`;
}

/** The value as ArduPilot prints it: no float noise (0.15000000596 → 0.15). */
export function fmtParam(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(+v.toPrecision(7));
}

/** One message type as CSV, with the time column first. */
export function toCsv(t: Table): string {
  const head = ["time_s", ...t.fields].join(",");
  const rows: string[] = [head];
  for (let r = 0; r < t.count; r++) {
    const cells = [Number.isFinite(t.t[r]) ? t.t[r].toFixed(6) : ""];
    for (const c of t.cols) {
      if (isNumeric(c)) cells.push(Number.isFinite(c[r]) ? String(c[r]) : "");
      else {
        const s = c[r] ?? "";
        cells.push(/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      }
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n") + "\n";
}

/** A written report: summary, findings, every check. Markdown, so it reads as plain text too. */
export function toReport(f: Flight, a: Analysis): string {
  const s = a.summary;
  const L: string[] = [];
  const verdict = { fail: "Problems found", warn: "Worth a look", pass: "No problems found" }[a.verdict];
  L.push(`# Flight log report: ${f.name}`, "");
  L.push(`**${verdict}.** ${a.findings.filter((x) => x.severity === "fail").length} problem(s), ${a.findings.filter((x) => x.severity === "warn").length} warning(s).`, "");
  L.push("## Flight", "");
  const row = (k: string, v: string | null) => v !== null && L.push(`- ${k}: ${v}`);
  row("Aircraft", `${s.vehicle}${s.firmware ? `, ${s.firmware}` : ""}`);
  row("Started", s.startUtc ? new Date(s.startUtc).toISOString().replace("T", " ").slice(0, 19) + " UTC" : null);
  row("Log length", clock(s.logDuration));
  row("Time in the air", `${clock(s.flightTime)}${s.flights > 1 ? ` over ${s.flights} flights` : ""}`);
  row("Distance flown", s.distance !== null ? `${(s.distance / 1000).toFixed(2)} km` : null);
  row("Highest above home", s.maxAltRel !== null ? `${s.maxAltRel.toFixed(1)} m` : null);
  row("Farthest from home", s.maxFromHome !== null ? `${s.maxFromHome.toFixed(0)} m` : null);
  row("Top ground speed", s.maxSpeed !== null ? `${s.maxSpeed.toFixed(1)} m/s` : null);
  row("Battery used", s.usedMah !== null ? `${s.usedMah.toFixed(0)} mAh` : null);
  row("Lowest battery voltage", s.minVolt !== null ? `${s.minVolt.toFixed(2)} V${s.cells ? ` (${(s.minVolt / s.cells).toFixed(2)} V a cell, ${s.cells}S)` : ""}` : null);
  if (s.modes.length) row("Modes flown", s.modes.map((m) => `${m.name} ${clock(m.seconds)}`).join(", "));
  L.push("", "## Findings", "");
  if (!a.findings.length) L.push("Nothing to report.");
  for (const x of a.findings) {
    const tag = { fail: "PROBLEM", warn: "WARNING", info: "NOTE" }[x.severity];
    L.push(`### ${tag}: ${x.title}`, "", `${x.area}${x.at !== undefined ? `, at ${clock(x.at)}` : ""}.`, "", x.detail);
    if (x.advice) L.push("", `What to do: ${x.advice}`);
    if (x.source) L.push("", `Reference: ${x.source}`);
    L.push("");
  }
  L.push("## Every check", "", "| Check | Result | Measured |", "| --- | --- | --- |");
  for (const c of a.checks) L.push(`| ${c.title} | ${c.status} | ${c.note.replace(/\|/g, "/")} |`);
  L.push("", `Generated by AERONEX on ${new Date().toISOString().slice(0, 10)}. Checks are guidance against ArduPilot's published limits, not a certificate of airworthiness.`, "");
  return L.join("\n");
}

/** Hand a text or binary file to the browser to save. */
export function saveFile(name: string, data: string | ArrayBuffer, type = "text/plain") {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** The log's name without its extension, safe for a file name. */
export const baseName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");

/** A short account of an open log for the assistant: what it is and what the checks found. */
export function logBrief(f: Flight, a: Analysis, name: string): string {
  const s = a.summary;
  const lines = [
    `File: ${name} (${f.kind === "bin" ? "on-board DataFlash log" : "telemetry log: what reached the ground station"}), ${s.firmware ?? f.vehicle}, ${clock(s.logDuration)} long, ${clock(s.flightTime)} in the air${s.maxAltRel !== null ? `, up to ${s.maxAltRel.toFixed(1)} m above home` : ""}${s.maxFromHome !== null ? `, ${s.maxFromHome.toFixed(0)} m from home at most` : ""}${s.usedMah !== null ? `, ${s.usedMah.toFixed(0)} mAh used` : ""}.`,
    `Modes flown: ${s.modes.map((m) => `${m.name} ${clock(m.seconds)}`).join(", ") || "none while flying"}.`,
    `Verdict of AERONEX's log checks: ${{ fail: "problems found", warn: "worth a look", pass: "no problems found" }[a.verdict]}.`,
  ];
  for (const x of a.findings.slice(0, 12)) lines.push(`- [${x.severity === "fail" ? "PROBLEM" : x.severity === "warn" ? "CHECK" : "note"}] ${x.title}${x.at !== undefined ? ` (at ${clock(x.at)})` : ""}: ${x.detail}`);
  lines.push(`Checks: ${a.checks.map((c) => `${c.title}: ${c.status} (${c.note})`).join("; ")}.`);
  return lines.join("\n");
}
