# Releasing AERONEX

Releases are built and published by GitHub Actions
([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)). Nothing is built or
published from a personal computer.

## Publishing a new version

1. List what changed for users under **Unreleased** in [CHANGELOG.md](../CHANGELOG.md) (each
   pull request adds its own line).
2. On GitHub: **Actions → Prepare a release → Run workflow**, and choose `patch`, `minor`,
   `major` or an exact version. It runs [`scripts/prepare-release.mjs`](../scripts/prepare-release.mjs):
   the version is raised in `package.json` and `package-lock.json`, the Unreleased lines become
   `desktop/build/release-notes.md` and a dated changelog section, and a pull request
   **Release x.y.z** is opened with its checks running.
3. Merge that pull request.

(By hand, the same is `node scripts/prepare-release.mjs patch`, then a pull request.)

When `main` carries a version that has no release yet, the Desktop workflow:

1. builds the app and the NSIS installer on a GitHub-hosted Windows runner;
2. checks the installer's file details (product name AERONEX, the version);
3. if code signing is set up, sends the installer to SignPath and waits for an approver;
4. writes `latest.yml` and the `.blockmap` from the installer being published
   ([`scripts/release-manifest.mjs`](../scripts/release-manifest.mjs));
5. creates a draft release on the pushed commit, uploads the three files, checks they are all
   there, and only then publishes it as the latest release.

A push to `main` with an unchanged version, and every pull request, builds the installer as a
check and publishes nothing. Nothing is ever published from another branch.

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
