# AERONEX website

The public site that offers the Windows installer: `index.html`, `privacy.html`, `site.css` and `app.js`, with no build step.

- The download button finds the newest release through GitHub's API and falls back to the releases page, so a new version needs no change here.
- The contact form emails dwijgvyas@gmail.com through FormSubmit (https://formsubmit.co). The first message ever sent asks for the address to be confirmed once, by a link in that email.
- Screenshots in `img/` are taken from the app itself; `mark.png` and `logo.webp` come from the brand masters in `brand/`.

Live at https://aeronexstation.vercel.app (Vercel project "aeronex", this folder as its root directory). Every push to main redeploys it. `vercel.json` sets the security headers and sends the old aeronex-steel.vercel.app address to the new one.
