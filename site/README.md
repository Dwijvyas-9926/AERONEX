# AERONEX download site

The public page that offers the Windows installer: `index.html`, `privacy.html`, `site.css` and `download.js`, with no build step.

The download button finds the newest release through GitHub's API (`download.js`) and falls back to the releases page, so a new version needs no change here. Screenshots in `img/` are taken from the app itself.

Deployed on Vercel with this folder as the project's root directory; `vercel.json` sets the security headers.
