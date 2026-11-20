# Security

AERONEX Ground Station talks to flight controllers, so a security fault here
can become a safety fault in the air. Reports are welcome and taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
reporting instead: on this repository, open **Security → Report a
vulnerability**. Say what you found, how to reproduce it, and what it could
let someone do. You will get a reply there.

## What is in scope

- Anything that lets a web page, a file (a log, a mission, a settings file, a
  3D model, a firmware file) or a flight controller run code in the app, read
  the API keys the user entered, or send a command the user did not ask for.
- Anything that sends a command to an aircraft without the confirmation or
  check the app says it applies.

## How the app is built to resist this

- **No server.** The app is static files. It has no accounts and stores no
  user data anywhere but the user's own browser.
- **Content security policy.** Scripts run only from the app itself; no inline
  script, no `eval`. The policy is in `vite.config.ts` and is sent both in the
  page and, on hosts that support it, as a response header together with
  HSTS, `nosniff`, a referrer policy, a permissions policy and a
  frame-ancestors rule (`vercel.json`, `dist/_headers`).
- **No HTML from data.** Text from a flight controller, a file or the
  assistant is always drawn as text. The assistant's Markdown is turned into
  React elements, never HTML, and its links are limited to `http(s)` and the
  app's own pages.
- **Keys stay in the session.** The Anthropic and map-provider keys are kept
  for the browser session unless the user chooses to remember them, and are
  sent only to the service they belong to.
- **Files are untrusted.** Parsers for logs, missions, settings and firmware
  refuse what they cannot read, in words; `src/__tests__/untrustedFiles.test.ts`
  feeds them random and hostile input.
- **Commands are gated in one place.** `src/services/link/commandLink.ts`
  refuses flight commands to anything that is not ArduCopter, parameter writes
  and restarts on an armed aircraft, and missions without a GPS fix, whichever
  page asks.
- **Dependencies.** `npm audit` runs in CI on every push; Dependabot proposes
  updates weekly.
