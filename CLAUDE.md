# AERONEX: notes for Claude

AERONEX is a free, open-source ground station for ArduCopter drones, shipped as a Windows app
(Electron) with a download website. It sends commands to real aircraft: treat every change as
safety-relevant until shown otherwise.

## How work is done here

- One task per session, usually one GitHub issue. Work on a branch and open a pull request to
  `main`. Never push to `main` directly, and never publish a release yourself.
- Add a line for users under **Unreleased** in `CHANGELOG.md` for any change they will notice.
  Do not change the version in `package.json`: the "Prepare a release" workflow does that.
- Before opening the pull request, run `npx tsc -b`, `npm run lint`, `npm test` and
  `npm run build`, and say in the description how the change was tested.
- The maintainer's process is in `docs/MAINTAINING.md`, releases in `docs/RELEASING.md`.

## Layout

- `src/`: the app (React 19, TypeScript, Vite, Three.js, Zustand). One folder per page in
  `src/features/`; MAVLink in `src/mavlink/`; the link and command gate in `src/services/link/`.
- `desktop/`: the Windows shell. `main.cjs` (window, menus, serial chooser, firmware pass-through,
  updater), `permissions.cjs` (the only browser permissions allowed), `preload.cjs` (the bridge).
  It is bundled by `npm run desktop:bundle`.
- `site/`: the website at aeronexstation.vercel.app (static HTML, CSS and JS, deployed by Vercel
  from `main`).
- `sitl/`: tests against ArduPilot's own ArduCopter simulator. `scripts/`: generators and release
  tools. Generated files (`*.generated.ts`, parameter metadata) are changed through their
  generator, never by hand.

## Rules that matter

- **Aircraft safety.** Commands go only to ArduCopter, through `commandLink`, and wait for the
  acknowledgement. Anything that moves an aircraft must fail safe when the link, a reading or a
  reply is missing. Keyboard Flight takes control only from the ground.
- **Honest display.** Show what the aircraft reports and nothing else. Missing or old readings
  are shown as missing or stale, never filled in. Simulated data is always labelled.
- **Wording.** Plain words for the person flying, in sentence case: what happened and what to do
  next. Headings are three digits (`headingText`), signed rates never read "-0.0" (`signed1`).
- **Desktop security.** Pages stay sandboxed. Only `serial`, `geolocation`,
  `clipboard-sanitized-write` and `fullscreen` are allowed, and only to the app's own pages.
  External links open in the browser; only `http(s)` and plain `mailto:` links are passed on.
- **Privacy.** No accounts, analytics or server. Anything new that leaves the computer must be
  added to `site/privacy.html` and the About page.
- **Do not rename** `productName` ("AERONEX") or `build.appId` in `package.json`: the first
  decides where Windows keeps users' data (`%APPDATA%\AERONEX`), the second identifies the
  installed app, and changing either would lose data or break updates.
- **Licence.** Apache-2.0, copyright "Dwij Vyas" only. Keep `NOTICE` and
  `THIRD-PARTY-NOTICES.txt` current (`node scripts/third-party-notices.mjs`).
- **Contact.** Project email aeronexstation@gmail.com; website https://aeronexstation.vercel.app.
