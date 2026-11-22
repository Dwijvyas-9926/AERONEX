# Contributing to AERONEX

Thank you for helping. AERONEX sends commands to real aircraft, so changes are held to the standard
of the code a pilot trusts in the field: tested, honest about what they do, and safe when something
goes wrong.

## Reporting a bug

Open an [issue](https://github.com/Dwijvyas-9926/AERONEX/issues/new/choose) with the **Bug report**
form. Include the AERONEX version (About page), the flight controller and ArduCopter version, what
you did, what you expected, and what happened. A flight log (`.bin` or `.tlog`) or a screenshot
helps a lot.

A problem that could let someone control an aircraft, run code or read your API keys is a security
problem: report it privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Suggesting a feature

Open an issue with the **Feature request** form. Say what you are trying to do and how you do it
today; that matters more than a proposed design.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Set up the project as described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
3. Make the change, with tests.
4. Before opening a pull request, run:

   ```bash
   npx tsc -b       # type check
   npm run lint     # oxlint
   npm test         # unit tests
   npm run build    # production build
   ```

5. Add a line for users under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) if they will
   notice the change. Leave the version alone: releases are prepared separately.
6. Open a pull request against `main` and fill in the template.

### What a good change looks like

- **Small and focused.** One fix or feature per pull request.
- **Tested.** New behaviour has a unit test. Anything that commands an aircraft (arming, modes,
  missions, parameters, calibration, servo outputs, firmware) is also checked against ArduCopter's
  own simulator where it can be (`sitl/`, see the development guide).
- **Safe by default.** Commands go only to ArduCopter, wait for its acknowledgement, and fail to a
  safe state. Nothing moves an aircraft without the operator asking.
- **Honest.** The interface shows what the aircraft reports and nothing else. Missing or old
  readings are shown as such, never filled in.
- **Plain words.** Text in the app is written for the person flying: what happened and what to do
  next, in sentence case, without jargon where a plain word works.

### Code style

TypeScript and React, formatted the way the surrounding code is. Comments explain why a piece of
code is the way it is, especially where a simpler version would be unsafe. Generated files
(`src/mavlink/dialect.generated.ts`, parameter metadata) are changed by their generator in
`scripts/`, not by hand.

### Commit messages

A short summary line in the imperative ("Fix heading shown as 360°"), then a blank line and the
reason for the change if it is not obvious.

## Licence of contributions

AERONEX is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms (section 5 of the licence).

## Conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
