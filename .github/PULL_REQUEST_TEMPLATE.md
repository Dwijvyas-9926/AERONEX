## What this changes

<!-- What the change does, and why. Link the issue it fixes, if any. -->

## How it was tested

<!-- Unit tests, the virtual aircraft, ArduCopter SITL, or real hardware. -->

## Checklist

- [ ] `npx tsc -b`, `npm run lint`, `npm test` and `npm run build` pass
- [ ] New behaviour has a test
- [ ] Anything that commands an aircraft goes only to ArduCopter, waits for its acknowledgement and fails safe
- [ ] Text in the app is in plain words, and says what the aircraft reports and nothing else
- [ ] `CHANGELOG.md` has a line under Unreleased if users will notice the change
