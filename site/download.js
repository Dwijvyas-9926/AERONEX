/*
  The download button always offers the newest installer.

  Without this script, or if GitHub cannot be reached, the button is a plain
  link to the latest release page, which works just as well. With it, the
  button downloads AERONEX-Setup-<version>.exe directly and says which
  version and how large it is, and the release notes appear below.

  Everything from GitHub is put on the page as text, never as HTML.
*/
const REPO = "Dwijvyas-9926/AERONEX";
const INSTALLER = /^AERONEX-Setup-[\d.]+\.exe$/;

const $ = (sel) => document.querySelector(sel);

function size(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

function day(iso) {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** Release notes are short Markdown lists; show each line as a list item, as text. */
function noteLines(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function windowsVisitor() {
  const ua = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /win/i.test(ua);
}

async function latest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function main() {
  if (!windowsVisitor()) $("[data-not-windows]")?.removeAttribute("hidden");
  let rel;
  try {
    rel = await latest();
  } catch {
    return; // The button already links to the release page.
  }
  const exe = (rel.assets || []).find((a) => INSTALLER.test(a.name));
  const version = String(rel.tag_name || "").replace(/^v/, "");
  if (exe && /^https:\/\/github\.com\//.test(exe.browser_download_url)) {
    $("[data-download-link]").href = exe.browser_download_url;
    $("[data-download-label]").textContent = `Download AERONEX ${version} for Windows`;
    const meta = $("[data-download-meta]");
    meta.textContent = `Version ${version}, ${size(exe.size)}${rel.published_at ? `, released ${day(rel.published_at)}` : ""}. Windows 10 and 11, 64-bit. Free. `;
    const notes = document.createElement("a");
    notes.href = "#news-title";
    notes.textContent = "What's new";
    meta.append(notes);
  }
  const lines = noteLines(rel.body);
  if (lines.length) {
    $("[data-release-title]").textContent = `What's new in ${version}`;
    const list = $("[data-release-notes]");
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      list.append(li);
    }
    $("[data-release]").removeAttribute("hidden");
  }
}

void main();
