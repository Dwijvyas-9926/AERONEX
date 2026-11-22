# Maintaining AERONEX

How the project is run: where work is tracked, how a change gets in, how a release goes out, and
what to keep an eye on. Everything happens on GitHub, so the history of every decision stays with
the code, whoever (or whatever) made the change.

## The loop

```
 feedback, bugs, ideas            one issue per task
 (website form, email,   ──▶   Issues + the project board
  GitHub, your own testing)              │
                                         ▼
                              a branch and a pull request
                              (you, a contributor, or Claude)
                                         │   checks run: tests, build,
                                         ▼   Windows installer
                                 you review and merge
                                         │
                                         ▼
                         "Prepare a release" when it is time
                                         │
                                         ▼
                   merge "Release x.y.z": published, and every
                       installed copy updates itself
```

## 1. Track every task as an issue

- **Bugs and ideas** come in through the issue forms (Bug report, Feature request), the website's
  contact form, and email to aeronexstation@gmail.com. Turn every email or message worth acting on
  into an issue, so nothing lives only in an inbox or a chat.
- **Labels** say what kind of task it is. Suggested set: `bug`, `enhancement`, `safety` (anything
  that can affect an aircraft in the air), `docs`, `website`, `good first issue`.
- **The project board** (GitHub Projects) shows what is next. Columns: *Inbox*, *Next*,
  *In progress*, *In review*, *Done*. Drag an issue to *Next* when you decide to do it.
- Close an issue from the pull request that fixes it by writing `Fixes #12` in its description.

## 2. Make changes in pull requests

`main` is what users get. Nothing goes into it except through a pull request.

1. Create a branch for one issue (`fix-heading-360`, `feature-survey-grid`).
2. Make the change, with its tests, and add a line for users under **Unreleased** in
   [CHANGELOG.md](../CHANGELOG.md) if they will notice it.
3. Open a pull request to `main`. GitHub runs the checks: type check, lint, unit tests, the
   production build, and a Windows installer build. The installer from that build can be
   downloaded from the run (Actions → the run → Artifacts) and tried on a PC before merging.
4. Review the change: read the diff, try the installer if it touches the app, then **Merge**.

Changes to the website (`site/`) get a Vercel preview link on the pull request, so you can see the
page before it goes live. Merging to `main` publishes it.

### Working with Claude

Use Claude the way you would a contributor: one task at a time, through a pull request.

- Start a **new session for each issue** rather than one long chat. Give it the issue link.
- The repository's [CLAUDE.md](../CLAUDE.md) tells every session the project's rules (safety,
  wording, releases, licence), so they do not have to be repeated in chat.
- Ask for the result as a **pull request**, and review it like any other before merging.

### Dependency updates

Dependabot opens pull requests each week to update libraries. For each one:

- **Patch and minor updates** (the "minor-and-patch" group): merge when the checks pass.
- **Major updates** (a new first number, for example TypeScript 6 → 7): these can change how things
  work. Merge only when the checks pass, and try the app; close the pull request if it is not worth
  the work yet. Dependabot opens it again for the next version.

## 3. Release when there is something worth shipping

1. Make sure everything for the release is merged, and **Unreleased** in the changelog reads well
   for users.
2. On GitHub: **Actions → Prepare a release → Run workflow**. Choose `patch` for fixes, `minor`
   for new features.
3. It opens a pull request **Release x.y.z** with the new version and the release notes. When its
   checks pass, merge it.
4. The Desktop workflow builds, (signs, once signing is set up,) and publishes the release. Every
   installed copy finds it within a few hours, or at once from Help → Check for updates.

[docs/RELEASING.md](RELEASING.md) has the details of how publishing and updating work.

If a release has a serious problem, fix it in a pull request and release the next patch version
straight away. Installed copies cannot go back to an older version on their own.

## 4. Keep an eye on

| What | Where |
| --- | --- |
| Messages from users | aeronexstation@gmail.com (website form and direct email) |
| Issues and pull requests | GitHub notifications, or the GitHub Mobile app |
| Failed checks or releases | GitHub emails you when a workflow fails |
| Downloads | The Releases page shows each installer's download count |
| The website | Vercel dashboard: deployments and visitor errors |
| Security reports | Repository → Security → Advisories |
| Code signing | SignPath, once approved: each release waits there for your approval |
| Gmail storage | The project inbox must have room, or messages and SignPath's emails bounce |

## 5. Repository settings to turn on once

- **Settings → Branches → Add branch ruleset** for `main`: require a pull request before merging,
  require the status checks **checks** (CI) and **windows** (Desktop) to pass, and block force
  pushes.
- **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests
  (needed by Prepare a release).
- **Settings → General → Pull Requests**: allow squash merging, and "Automatically delete head
  branches".
- **Settings → Code security**: Dependabot alerts and security updates on; private vulnerability
  reporting on.
- **About** (repository home, the gear icon): description, website and topics.
