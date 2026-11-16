import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Markdown } from "../Markdown";

const html = (md: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Markdown text={md} />
    </MemoryRouter>,
  );

describe("markdown from the assistant", () => {
  it("draws numbered steps with links to the app's pages", () => {
    const h = html("Steps:\n\n1. Open [Keyboard Flight](#/keyboard-flight).\n2. Press `T`.\n   - It climbs to **2 m**.\n3. Land with L.");
    expect(h).toContain("<p>Steps:</p>");
    expect(h).toMatch(/<ol start="1"><li>Open <a class="md-page" href="\/keyboard-flight"[^>]*>Keyboard Flight<\/a>\.<\/li><li>Press <code>T<\/code>\.<ul><li>It climbs to <strong>2 m<\/strong>\.<\/li><\/ul><\/li><li>Land with L\.<\/li><\/ol>/);
  });

  it("keeps a list counting across blank lines", () => {
    expect(html("1. a\n\n2. b")).toMatch(/<ol start="1"><li>a<\/li><li>b<\/li><\/ol>/);
  });

  it("draws a number link as a citation, and outside links in a new tab", () => {
    const h = html("Land [1](https://ardupilot.org/a). See [the docs](https://ardupilot.org/b).");
    expect(h).toContain('<sup class="md-cite"><a href="https://ardupilot.org/a" target="_blank" rel="noreferrer"');
    expect(h).toContain('<a href="https://ardupilot.org/b" target="_blank" rel="noreferrer">the docs</a>');
  });

  it("never makes a link of anything but a page or http(s), and never draws markup", () => {
    const h = html("[click](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(h).not.toContain("<a");
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
  });

  it("leaves parameter names alone", () => {
    expect(html("Set FS_GCS_ENABLE and BATT_FS_LOW_ACT.")).toContain("Set FS_GCS_ENABLE and BATT_FS_LOW_ACT.");
  });

  it("draws tables, headings, quotes and code", () => {
    const h = html("## Options\n\n| Mode | Use |\n|---|---|\n| Loiter | holds |\n\n> Props off.\n\n```\nSERIAL2_BAUD 921\n```");
    expect(h).toContain("<h3 class=\"md-h\">Options</h3>");
    expect(h).toContain("<th>Mode</th>");
    expect(h).toContain("<td>Loiter</td>");
    expect(h).toContain("<blockquote><p>Props off.</p></blockquote>");
    expect(h).toContain('<pre class="md-code"><code>SERIAL2_BAUD 921</code></pre>');
  });

  it("does not stall on odd input", () => {
    expect(() => html("#\n|\n|---\n> \n```\n1.\n- ")).not.toThrow();
  });
});
