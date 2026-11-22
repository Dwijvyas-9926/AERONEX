/*
  AERONEX website.

  - The download button finds the newest installer on GitHub; without the
    script, or if GitHub cannot be reached, it links to the releases page.
  - The contact form emails Dwij Vyas through FormSubmit; if that fails it
    offers to open the visitor's own email app instead.
  - The terrain contours, the reveal on scroll, the cursor-lit cards and the
    counting numbers. All motion stops for visitors who ask for less of it.

  Everything that comes from GitHub or the visitor is put on the page as
  text, never as HTML.
*/
(function () {
  "use strict";

  const SITE = {
    repo: "Dwijvyas-9926/AERONEX",
    email: "aeronexstation@gmail.com",
    // FormSubmit sends the form to this address. The first message ever sent
    // asks the owner to confirm the address once, by a link in that email.
    formEndpoint: "https://formsubmit.co/ajax/aeronexstation@gmail.com",
  };
  const INSTALLER = /^AERONEX-Setup-[\d.]+\.exe$/;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.add("js");

  /* ------------------------------------------------------------ page chrome */

  $$("[data-year]").forEach((el) => (el.textContent = String(new Date().getFullYear())));

  const bar = $("#top-bar");
  const onScroll = () => bar && bar.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const menu = $("#menuBtn");
  const drawer = $("#drawer");
  if (menu && drawer) {
    menu.addEventListener("click", () => {
      const open = drawer.classList.toggle("open");
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "Close the menu" : "Open the menu");
    });
    $$("a", drawer).forEach((a) =>
      a.addEventListener("click", () => {
        drawer.classList.remove("open");
        menu.setAttribute("aria-expanded", "false");
      }),
    );
  }

  // The nav shows which section is on screen.
  const navLinks = $$("nav.main a");
  if ("IntersectionObserver" in window && navLinks.length) {
    const byId = new Map(navLinks.map((a) => [a.getAttribute("href").slice(1), a]));
    const spy = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          const link = byId.get(e.target.id);
          if (link && e.isIntersecting) {
            navLinks.forEach((a) => a.classList.remove("on"));
            link.classList.add("on");
          }
        }),
      { rootMargin: "-45% 0px -50% 0px" },
    );
    byId.forEach((_, id) => {
      const s = document.getElementById(id);
      if (s) spy.observe(s);
    });
  }

  // Sections rise into place as they come into view.
  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    reveals.forEach((el) => io.observe(el));
  } else reveals.forEach((el) => el.classList.add("in"));

  // Cards light up under the pointer.
  $$(".card, .safe, .why-item").forEach((el) =>
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    }),
  );

  // The numbers count up the first time they are seen.
  const counters = $$("[data-count]");
  if ("IntersectionObserver" in window && !reduced && counters.length) {
    const co = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          co.unobserve(e.target);
          const el = e.target;
          const end = Number(el.dataset.count);
          const suffix = el.dataset.suffix || "";
          const t0 = performance.now();
          const step = (t) => {
            const k = Math.min(1, (t - t0) / 1400);
            el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))) + suffix;
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      { threshold: 0.6 },
    );
    counters.forEach((c) => co.observe(c));
  }

  // The aircraft on the hero's flight path stays put for visitors who ask for less motion.
  if (reduced) $$("svg").forEach((s) => typeof s.pauseAnimations === "function" && s.pauseAnimations());

  /* ------------------------------------------------------ terrain contours */

  // A small seeded random, so the hills are the same on every visit.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Closed contour lines around a few hills, like a topographic map.
  function drawTerrain(host, opts) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 1440 860");
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.setAttribute("fill", "none");
    const rand = rng(opts.seed);
    for (const hill of opts.hills) {
      const waves = [1, 2, 3, 4].map((k) => ({ k: k + 1, a: (0.05 + rand() * 0.09) / k, p: rand() * Math.PI * 2 }));
      for (let i = 0; i < hill.rings; i++) {
        const r0 = hill.r * (1 - i / (hill.rings + 1.5));
        const pts = [];
        for (let j = 0; j < 72; j++) {
          const t = (j / 72) * Math.PI * 2;
          let r = r0;
          for (const w of waves) r += r0 * w.a * Math.sin(w.k * t + w.p + i * 0.35);
          pts.push([hill.x + r * Math.cos(t) * hill.sx, hill.y + r * Math.sin(t)]);
        }
        // A smooth closed curve through the points.
        let d = "";
        for (let j = 0; j < pts.length; j++) {
          const p0 = pts[(j - 1 + pts.length) % pts.length];
          const p1 = pts[j];
          const p2 = pts[(j + 1) % pts.length];
          const p3 = pts[(j + 2) % pts.length];
          if (j === 0) d += `M${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
          const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
          const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
          d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
        }
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d + "Z");
        path.setAttribute("stroke", opts.color);
        path.setAttribute("stroke-width", i % 4 === 0 ? "1.4" : "0.9");
        path.setAttribute("opacity", String(opts.opacity * (i % 4 === 0 ? 1 : 0.65)));
        svg.appendChild(path);
      }
    }
    host.appendChild(svg);
  }

  const TERRAIN = {
    hero: { seed: 7, color: "#e8650f", opacity: 0.26, hills: [ { x: 1250, y: 140, r: 420, rings: 14, sx: 1.25 }, { x: 160, y: 820, r: 360, rings: 12, sx: 1.4 }, { x: 760, y: 980, r: 260, rings: 7, sx: 1.6 } ] },
    night: { seed: 19, color: "#f4a259", opacity: 0.3, hills: [ { x: 1240, y: 60, r: 380, rings: 12, sx: 1.3 }, { x: 120, y: 760, r: 340, rings: 11, sx: 1.5 } ] },
  };
  $$("[data-terrain]").forEach((host) => {
    const opts = TERRAIN[host.dataset.terrain];
    if (opts) drawTerrain(host, opts);
  });

  /* --------------------------------------------------- the newest release */

  const fmtDate = (iso) => {
    try {
      return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
    } catch {
      return "";
    }
  };
  const noteLines = (body) =>
    String(body || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim())
      .filter(Boolean)
      .slice(0, 6);
  const meta = (el, label, value) => {
    if (!el) return;
    el.textContent = "";
    const b = document.createElement("strong");
    b.textContent = label;
    el.append(b, " " + value);
  };

  fetch(`https://api.github.com/repos/${SITE.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((rel) => {
      const version = String(rel.tag_name || "").replace(/^v/, "");
      const exe = (rel.assets || []).find((a) => INSTALLER.test(a.name));
      if (version) {
        const pill = $("[data-ver-pill]");
        if (pill) pill.textContent = `Latest release v${version}`;
        const float = $("[data-version-float]");
        if (float) {
          float.textContent = "";
          const small = document.createElement("small");
          small.textContent = "Updates itself, never mid-flight";
          float.append(`Version ${version}, out now`, small);
        }
      }
      if (rel.published_at) meta($("[data-dl-when]"), "Published", fmtDate(rel.published_at));
      if (exe && /^https:\/\/github\.com\//.test(exe.browser_download_url)) {
        $("[data-dl-link]").href = exe.browser_download_url;
        const label = $("[data-dl-label]");
        if (label) label.textContent = `Download v${version} (.exe)`;
        meta($("[data-dl-size]"), "Size", `${Math.round(exe.size / 1e6)} MB`);
      }
      if (rel.html_url && /^https:\/\/github\.com\//.test(rel.html_url)) $("[data-notes-link]").href = rel.html_url;
      const lines = noteLines(rel.body);
      const list = $("[data-notes]");
      if (lines.length && list) {
        $("[data-notes-title]").textContent = `What's new in v${version}`;
        list.textContent = "";
        for (const line of lines) {
          const li = document.createElement("li");
          li.textContent = line;
          list.append(li);
        }
      }
    })
    .catch(() => {
      /* The links already point at the releases page. */
    });

  /* -------------------------------------------------------- contact form */

  const form = $("#contactForm");
  if (form) {
    const status = $("#formStatus");
    const label = $("[data-send-label]");
    const button = $("button[type=submit]", form);
    const say = (kind, text, mailto) => {
      status.className = `form-status ${kind}`;
      status.textContent = text;
      if (mailto) {
        status.append(" ");
        const a = document.createElement("a");
        a.href = mailto;
        a.textContent = "Send it from your email app instead.";
        status.append(a);
      }
    };
    const fields = ["name", "email", "subject", "message"].map((n) => form.elements[n]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const [name, email, subject, message] = fields.map((f) => f.value.trim());
      fields.forEach((f) => f.removeAttribute("aria-invalid"));
      const missing = fields.filter((f) => !f.value.trim());
      const badEmail = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (missing.length || badEmail) {
        missing.forEach((f) => f.setAttribute("aria-invalid", "true"));
        if (badEmail) form.elements.email.setAttribute("aria-invalid", "true");
        say("err", badEmail && !missing.length ? "Please check your email address, so a reply can reach you." : "Please fill in your name, your email, a subject and a message.");
        (missing[0] || form.elements.email).focus();
        return;
      }
      // Bots fill in the hidden field; people never see it.
      if (form.elements._honey.value) return;

      const mailto = `mailto:${SITE.email}?subject=${encodeURIComponent(`[AERONEX] ${subject}`)}&body=${encodeURIComponent(`${message}\n\n${name} (${email})`)}`;
      button.disabled = true;
      label.textContent = "Sending…";
      try {
        const res = await fetch(SITE.formEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            name,
            email,
            _replyto: email,
            _subject: `[AERONEX] ${subject}`,
            message,
            _template: "table",
            _captcha: "false",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && String(data.success) === "true") {
          say("ok", `Thank you, ${name}. Your message has been sent, and the reply will come to ${email}.`);
          form.reset();
        } else {
          say("err", "The message could not be sent just now.", mailto);
        }
      } catch {
        say("err", "The message could not be sent: the connection failed.", mailto);
      } finally {
        button.disabled = false;
        label.textContent = "Send message";
      }
    });
  }
})();
