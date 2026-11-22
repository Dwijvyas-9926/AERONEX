# Releasing AERONEX

Releases are built and published by GitHub Actions
([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)). Nothing is built or
published from a personal computer.

## Publishing a new version

1. Change `version` in `package.json` (and `package-lock.json`, with
   `npm version <x.y.z> --no-git-tag-version`).
2. Write what changed for users in `desktop/build/release-notes.md`, and move the same lines
   from **Unreleased** to a new section in [CHANGELOG.md](../CHANGELOG.md).
3. Commit and push to `main`.

The workflow sees that this version has no release yet and:

1. builds the app and the NSIS installer on a GitHub-hosted Windows runner;
2. checks the installer's file details (product name AERONEX, the version);
3. if code signing is set up, sends the installer to SignPath and waits for an approver;
4. writes `latest.yml` and the `.blockmap` from the installer being published
   ([`scripts/release-manifest.mjs`](../scripts/release-manifest.mjs));
5. creates a draft release on the pushed commit, uploads the three files, checks they are all
   there, and only then publishes it as the latest release.

A push with an unchanged version builds the installer as a check and publishes nothing.

## How installed copies update

AERONEX uses electron-updater with the GitHub provider. It reads `latest.yml` from the latest
release when it starts and every four hours, downloads the installer in the background, and checks
its SHA-512 against `latest.yml`. It never restarts while a flight controller is connected or
firmware is being installed.

`latest.yml` must describe the exact installer that is published. Code signing changes the file,
so the manifest is always written after signing.

## Code signing

Free code signing is applied for at SignPath Foundation; the public policy is at
[aeronexstation.vercel.app/code-signing](https://aeronexstation.vercel.app/code-signing).

Signing turns on by itself once the repository has, under **Settings → Secrets and variables →
Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | variable | the SignPath organization ID |
| `SIGNPATH_API_TOKEN` | secret | an API token for a SignPath user that can submit signing requests |
| `SIGNPATH_PROJECT_SLUG` | variable, optional | defaults to `AERONEX` |
| `SIGNPATH_POLICY_SLUG` | variable, optional | defaults to `release-signing` |

What SignPath signs is defined in [`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml):
the installer only, and only if its file details say AERONEX and the version being released.

After the first signed release, `build.win.publisherName` can be set to `SignPath Foundation`, so
installed copies accept updates only from that publisher.
