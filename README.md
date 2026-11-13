# released

Find the first release tag that contains a git commit or merged PR/MR.

[![npm](https://img.shields.io/npm/v/git-released?label=git-released)](https://www.npmjs.com/package/git-released)
[![CI](https://github.com/lukaso/released/actions/workflows/ci.yml/badge.svg)](https://github.com/lukaso/released/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

You have a commit SHA or a merged PR and you want the release it shipped in.
`git describe --contains` answers that locally, but only against a cloned repo
with every tag fetched, its output is `v1.2.3~4^2` instead of `v1.2.3`, and it
won't take a PR number. `released` takes a commit URL, a bare SHA, or a PR/MR for
any public **GitHub** repo or a curated set of **GitLab** hosts (gitlab.com,
GNOME, KDE, Debian, freedesktop, Kitware) and returns the tag, a shareable link,
and an auto-updating badge. No clone.
[How it works](https://released.blabberate.com/how-it-works)

### Try it in 30 seconds

```bash
npx git-released github.com/honojs/hono/commit/f82aba8
# → first released in v4.12.11
```

- **Web**: <https://released.blabberate.com> — paste a commit, SHA, or PR/MR.
- **CLI**: `npx git-released <commit-url | owner/repo sha | PR/MR/issue-url>` (published on
  npm as `git-released` — `released` was taken in 2014). The package installs both
  the `released` and `git-released` bins; `git released <sha>` works inside a repo.

### Embed an auto-updating badge

Drop this in a PR description or a README. It shows "not yet released" while the
commit is unshipped and **flips to the version tag automatically** once a release
contains it — no manual updates:

```md
[![released](https://released.blabberate.com/r/<owner>/<repo>/c/<sha>/badge.svg)](https://released.blabberate.com/r/<owner>/<repo>/c/<sha>)
```

Variants: PRs use `/p/<owner>/<repo>/<number>/badge.svg`; GitLab hosts use
`/h/<host>/r/<projectPath>/c/<sha>/badge.svg` (and `/p/…` for MRs). The easiest
way to get the exact snippet is to run a lookup on the web app and click
**Copy → as Badge**.

### released vs `git describe --contains`

| | `git describe --contains` | `released` |
|---|---|---|
| Needs a local clone (with tags) | yes | no |
| Works on any repo from a URL | no | yes |
| Takes a PR / MR number | no | yes |
| Output | `v1.2.3~4^2` | `first release: v1.2.3` + also-in |
| Shareable link + auto-updating badge | no | yes |
| Hosted GitLab (GNOME/KDE/Debian/…) | local only | yes |

**Supported hosts:** GitHub plus a curated list of GitLab instances (gitlab.com,
gitlab.gnome.org, gitlab.freedesktop.org, salsa.debian.org, invent.kde.org,
gitlab.kitware.com). Self-hosted GitLab instances can be added via
`EXTRA_GITLAB_HOSTS` env var (Worker) or `--gitlab-host` flag (CLI).

> If `released` saves you a clone, a ⭐ on the repo helps others find it.

## Private repos

The web app reads public repos only. For a private repo, use the CLI with a token
that can read it:

```bash
# GitHub — classic PAT with `repo` scope, or a fine-grained token with Contents: read
GITHUB_TOKEN=ghp_xxx npx git-released github.com/acme/app/commit/abc1234

# GitLab — PAT with read_api scope
GITLAB_TOKEN=glpat_xxx npx git-released https://gitlab.com/acme/app/-/commit/abc1234
```

Token resolution order:

- **GitHub:** `--token <t>` → `GITHUB_TOKEN` / `GH_TOKEN` → `gh auth token`
- **GitLab:** `--token <t>` → `GITLAB_TOKEN_<HOST>` (host uppercased, `.`/`-` → `_`,
  e.g. `GITLAB_TOKEN_GITLAB_GNOME_ORG`) → `GITLAB_TOKEN` (gitlab.com only) →
  `glab auth token`

If you're already logged in with the `gh` or `glab` CLI, `released` picks up that
token automatically and you don't need an env var.

## Packages

This is a pnpm monorepo with four packages:

| Package | What | Where |
|---|---|---|
| `@released/core` | Pure-TS library: algorithm, GitHub + GitLab providers, sanitizer, parser. Web Platform APIs only — runs in Node 20+ and Cloudflare Workers unchanged. | `packages/core/` |
| `git-released` | Node CLI (installs `git-released` + `released` bin aliases). Published as `git-released` because the unscoped `released` name was taken on npm. | `packages/cli/` |
| `@released/web` | Cloudflare Worker — homepage + permalink page + JSON API. | `packages/web/` |
| `@released/web-og` | Cloudflare Worker — OG-image PNG renderer (isolated bundle weight). Service Binding to `@released/web`. | `packages/web-og/` |

## Development

### Prerequisites

Three tiers — you only need the first to contribute:

| Tier | What | Needed for |
|---|---|---|
| **Contribute** | Node 20+, `pnpm` | build, test, lint, push, open PRs |
| **Sharper local loop** *(optional)* | [`osv-scanner`](https://google.github.io/osv-scanner/installation/), [`gitleaks`](https://github.com/gitleaks/gitleaks#installing), `shellcheck`, `actionlint` | dependency CVE scan, secret scan, shell + workflow lint in your own loop |
| **Run the CLI live** *(optional)* | `GITHUB_TOKEN` / `GITLAB_TOKEN` env vars | running `git-released` against rate-limited hosts. The test suite uses mocks, so this is **not** needed for dev |
| **Publish / deploy** *(maintainer only)* | npm publish rights, Cloudflare API token + account, `gh` | only used by `release.yml`; contributors never touch this |

The tier-2 binaries (`osv-scanner`, `gitleaks`, `shellcheck`, `actionlint`) are
the non-npm tools. All are **optional locally** — the hooks warn and continue
without them, and CI runs every one as the authoritative gate on every PR — but
installing them brings those checks into your own loop (`brew install
osv-scanner gitleaks shellcheck actionlint`). Run `pnpm doctor` to check your
setup and get exact install commands:

```bash
pnpm install      # also wires git hooks via the prepare script
pnpm doctor       # one-shot prerequisite check
```

### Daily flow (the fast loop)

```bash
# edit ...
pnpm validate     # build · typecheck · test · lint · shellcheck · actionlint · secrets · publint · osv  (also the pre-push hook)
git push          # pre-push runs pnpm validate automatically
pnpm ci:status    # poll CI for your pushed commit (pass/fail + failed-step logs)
```

Per-package dev:

```bash
pnpm --filter @released/web dev          # wrangler dev for web
pnpm --filter @released/web-og dev       # wrangler dev for web-og
pnpm --filter git-released dev -- <input>    # tsx-run the CLI in place
```

Working on OG rendering locally? Put this in `packages/web/.dev.vars`:

```
PUBLIC_BASE_URL=http://localhost:8787
```

`/internal/*` (what web-og calls) keys the result cache on the deployment's own
public origin. `wrangler dev` loads `[vars]`, where `PROD_HOST` is set, so
without the override the OG path keys on `https://released.blabberate.com` while
your public routes key on `http://localhost:8787`: two namespaces on one
machine, and every local OG request pays a full lookup instead of hitting the
slot the permalink just warmed. Prod and the preview Worker set it themselves.

### Local checks reference

| Command | What it does | Gate? |
|---|---|---|
| `pnpm validate` | build, typecheck, test, lint, shellcheck, actionlint, secrets, publint (hard-fail when the tool is present); osv (warn-only locally) | pre-push hook |
| `pnpm check:publish` | publint + pack the CLI, install the tarball in a clean dir, run `git-released --help` | pre-publish gate in `release.yml`; run on demand |
| `pnpm ci:status` | shows CI runs for HEAD (`ci.yml` + `release.yml`) + failed-step logs | read-only |
| `pnpm doctor` | prerequisite check with fixes | read-only |

CI mirrors these across jobs: **test** (lint/build/typecheck/test, incl. the
jsdom+axe structural a11y test), **osv** (dependency CVEs), **secrets**
(gitleaks, full history), **meta-lint** (shellcheck + actionlint), and **a11y**
(chromium + axe color-contrast regression guard). The pre-commit hook also runs
a staged gitleaks scan so a stray `git add` of a `.dev.vars` / token is blocked
before it ever lands in a commit.

Two independent hook systems live here, by design:

- **Git hooks** (`.githooks/`, wired via `core.hooksPath` in the `prepare`
  script): `pre-push` runs `pnpm validate`. Skips in CI (`CI=true`). Bypass a
  WIP push with `git push --no-verify`.
- **Claude Code hooks** (`.claude/hooks/`): a commit/push approval gate + a
  "run validate before declaring done" gate, active only when working through
  the Claude Code agent. Plain `git` users never hit these.

Dependency CVEs gate on **High/Critical** only (Medium/Low are reported but not
blocking); routine bumps + newly-disclosed CVEs come in as Dependabot PRs.

<!-- TODO: the dev scripts (validate.sh, check-publish.sh, ci-status.sh, doctor.sh)
     are bash; a Windows contributor without git-bash/WSL can't run the hooks.
     Cross-platform them (or document WSL) if/when a Windows contributor appears. -->

> **Maintainer note (publish/deploy):** publishing to npm and deploying the
> Workers happen only in `release.yml` (npm via OIDC Trusted Publishing,
> Cloudflare via API token). See [Deploy](#deploy-cloudflare-workers) and
> [CI/CD](#cicd) below. Contributors do not need any of these credentials.

## Deploy (Cloudflare Workers)

Order matters — `web-og` has a Service Binding to `web`, so `web` deploys first.

### One-time setup

1. **GitHub token** for the web Worker (gives the shared anonymous fast path
   5000 req/hr instead of 60):

   ```bash
   cd packages/web
   wrangler secret put GITHUB_TOKEN
   ```

   For GitLab — anonymous calls from Workers exhaust the edge IP's shared
   budget almost immediately, so a token is effectively required for
   federation. Each GitLab host is a separate instance with its own rate
   budget, so **every curated host needs its own per-host token** — not just
   gitlab.com. Without one, lookups for that host fail intermittently with a
   `ProviderServerError` (GitLab throttles unauthenticated API traffic from
   the shared Cloudflare egress IP), which surfaces to visitors as a
   "Can't reach <host>" page:

   ```bash
   # gitlab.com (most common case):
   cd packages/web && wrangler secret put GITLAB_TOKEN

   # Per-host PAT — one per curated GitLab host. Name is the host uppercased
   # with `.` and `-` → `_`. The curated hosts (see top of this README):
   wrangler secret put GITLAB_TOKEN_GITLAB_GNOME_ORG
   wrangler secret put GITLAB_TOKEN_GITLAB_FREEDESKTOP_ORG
   wrangler secret put GITLAB_TOKEN_SALSA_DEBIAN_ORG
   wrangler secret put GITLAB_TOKEN_INVENT_KDE_ORG
   wrangler secret put GITLAB_TOKEN_GITLAB_KITWARE_COM

   # To extend the known-hosts allowlist (so users can paste URLs from
   # additional self-hosted instances), set the env var in wrangler.toml:
   #   EXTRA_GITLAB_HOSTS = "git.example.com,gitlab.acme.net"
   ```

   **Token type + identity (matters for the Worker):** use a **legacy /
   classic** GitLab Personal Access Token with the **`read_api`** scope —
   *not* a fine-grained token. The Worker serves lookups for arbitrary
   gitlab.com projects that visitors paste, so it needs broad read access;
   fine-grained tokens require enumerating specific projects up front,
   which doesn't fit. This token is the Worker's shared service identity
   for *every* visitor's GitLab lookup, so prefer a **dedicated bot/service
   account** over a personal one — that keeps rate-limit consumption and
   audit logs cleanly attributable, and means rotating it doesn't touch
   your personal credentials. Set a far-out expiry and rotate on a
   schedule.

2. **Internal secret** shared between `web` and `web-og` (used by `web` to
   reject direct public hits to `/internal/result/*` and only accept calls
   coming through the Service Binding):

   ```bash
   cd packages/web && wrangler secret put INTERNAL_SECRET
   cd packages/web-og && wrangler secret put INTERNAL_SECRET   # same value
   ```

3. **Rate-limiting rule** in the Cloudflare dashboard (D13). Documented here so
   it's reproducible — Cloudflare doesn't yet expose this as wrangler config:

   - Zone → **Security → WAF → Rate limiting rules → Create rule**
   - Name: `released-api-per-ip`
   - Match: `(http.request.uri.path matches "^/api/lookup")`
   - Counting: by source IP
   - Rate: **60 requests per 1 minute**
   - Action: Block, with 1-minute timeout
   - Response: 429 with JSON `{"error":"rate_limited"}`

### Deploy

```bash
# Web first (web-og depends on the service binding existing):
pnpm --filter @released/web deploy
pnpm --filter @released/web-og deploy
```

### Cache warming (optional)

Bumping `CACHE_NS` (`packages/core/src/types.ts`) re-keys the edge cache, so the
next deploy goes cold and high-traffic repos recompute until they re-warm. Warm
them ahead of users, right after the deploy lands:

```bash
cd packages/web
pnpm warm                                       # top 100 GitHub repos by AE traffic
pnpm warm -- --limit 25 --dry-run              # preview the targets, warm nothing
pnpm warm -- --repos honojs/hono,facebook/react
```

It reuses the same Analytics Engine credentials as `pnpm stats` (in `.dev.vars`),
plus an optional `GITHUB_TOKEN`/`GH_TOKEN` for the HEAD-SHA fetch. The Worker's
cache is per-colo, so a run warms the colo nearest the runner, not every edge
location. See `packages/web/scripts/warm-cache.mjs` for the rate-limit and
per-colo notes.

### CI/CD

`.github/workflows/release.yml` runs on every push to `main`. Depending on
repo state, the Changesets step does one of:

- **Pending changeset(s) in `.changeset/`**: opens or force-pushes a "Version
  Packages" PR (`changeset-release/main` → `main`) that bumps versions,
  writes CHANGELOGs, and deletes the consumed changeset files.
- **No pending changesets + a version-bump commit just landed** (i.e., you
  just merged the "Version Packages" PR): runs `pnpm run release` (=
  `pnpm -r build && changeset publish`), which publishes `git-released` to
  npm via OIDC Trusted Publishing.

After either path, the workflow deploys the Cloudflare Workers (`web` first
— `web-og` has a Service Binding to it).

Required GitHub repo configuration:

- **Repo secrets**:
  - `CLOUDFLARE_API_TOKEN` — Workers deploy
  - `CLOUDFLARE_ACCOUNT_ID`
- **Repo settings** (Settings → Actions → General → Workflow permissions):
  - "Allow GitHub Actions to create and approve pull requests" enabled
    (the Changesets action needs this to open the Version Packages PR)
- **npm side** (one-time per published package, at
  `npmjs.com/package/git-released/access` → Trusted Publisher):
  - Repository: `lukaso/released`, Workflow: `release.yml`, Environment: blank
- Per-Worker secrets (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `INTERNAL_SECRET`, etc.)
  must already be set via `wrangler secret put` — see the one-time setup above.

No `NPM_TOKEN` secret is needed — the `id-token: write` permission in
`release.yml` plus the npm-side Trusted Publisher rule above lets the
workflow exchange a GitHub OIDC token for a short-lived npm publish token
at publish time, with a signed provenance attestation attached.

### Releasing the CLI

The CLI (`git-released` on npm) ships via [Changesets](https://github.com/changesets/changesets).
No manual `npm publish` step — the only thing you do by hand is write a
changeset file and merge a PR.

1. **Make your code change** on a feature branch as normal.

2. **Add a changeset** describing what you shipped:

   ```bash
   pnpm changeset
   ```

   This is an interactive prompt:

   - **Which packages?** Only `git-released` is selectable. The internal
     packages (`@released/core`, `@released/web`, `@released/web-og`) are
     in the `ignore` list in `.changeset/config.json` and don't appear.
     `@released/core` is bundled into the CLI tarball at build time and
     is not separately published.
   - **Which type of bump?** Pick by what your change does to users:

     | Bump  | When                                                                 | Example: from `0.1.1` to… |
     |-------|----------------------------------------------------------------------|----------------------------|
     | patch | Bug fix, perf improvement, doc fix, internal refactor. No new flags, no behavior change for existing inputs. | `0.1.2` |
     | minor | New feature or flag, new supported host, new output format. No breaking changes to existing usage. | `0.2.0` |
     | major | Breaking change: removed/renamed flag, changed default behavior, dropped a Node version, changed CLI exit-code semantics, removed a previously-exported function from the bundled library. | `1.0.0` |

     **Pre-1.0 caveat**: while the CLI is `0.x`, you can also fold
     breaking changes into a minor bump (`0.1.x → 0.2.0`) rather than
     going to `1.0.0` — that's the conventional escape hatch for
     unstable APIs. Use `major` (→ `1.0.0`) only when you're consciously
     declaring stability and the bump signals "this is the API now."

   - **Summary**: one or two sentences that will land verbatim in
     `packages/cli/CHANGELOG.md`. Write it for the person who'll grep
     the changelog six months from now: lead with the user-visible
     effect, not the implementation detail.

   Commit the generated `.changeset/<random-name>.md` file alongside
   your code change. You can hand-edit or delete this file freely before
   pushing — it's just markdown with YAML frontmatter, no magic.

   **Stacking multiple changesets** is fine: run `pnpm changeset` once
   per logical change before pushing. When the Version Packages PR
   opens, it sums them — the highest bump type wins (one `minor` + two
   `patch` → minor bump), and all summaries land in the CHANGELOG under
   the new version header.

3. **Merge your change to `main`**. The `release.yml` workflow opens (or
   updates) a "chore(release): version packages" PR with the version bump
   + CHANGELOG entry.

4. **Review and merge that auto-PR**. The next `release.yml` run publishes
   to npm. You can watch the "Create release PR or publish CLI to npm"
   step in the workflow for the `+ git-released@<version>` line.

**To verify a release after CI publishes**:

```bash
npm view git-released versions --json | tail -5
npx --yes git-released github.com/facebook/react/commit/a1b2c3d
```

**To deprecate a published version** (e.g., a broken release):

```bash
npm deprecate "git-released@<version>" "reason / what to use instead"
```

Versions cannot be republished after `npm unpublish` — npm permanently
retires version numbers — so deprecation is almost always the right move
for shipping a fix, paired with bumping to the next patch.

## Architecture

```
packages/core   (pure TS — runs in Node + Workers)
   │
   ├─► packages/cli       (Node CLI; GitHub auth = --token | GITHUB_TOKEN | gh auth,
   │                       GitLab auth = --token | GITLAB_TOKEN[_<HOST>] | glab auth)
   │
   └─► packages/web       (Cloudflare Worker — homepage, /r/:o/:r/c/:sha, /api/*)
                  │
                  └── service binding ──► packages/web-og   (PNG renderer, isolated bundle)
```

**Algorithm** (in `packages/core/src/find-release.ts`):

1. Resolve PR → merge commit, or validate the commit SHA.
2. List all repo tags via GitHub GraphQL (paginated). Per-tag, use the best
   available date: GitHub Release `published_at` if any, else annotated tag
   tagger date, else the tagged commit's committer date.
3. **Sort by date ascending — NOT filter.** Git dates aren't reliably
   monotonic with topology (clock skew, manually-set dates, cherry-picks);
   filtering on date would silently drop containing tags. Date is ordering
   only; ancestry is the sole containment test.
4. Check `/compare/{tag}...{commit}` for each tag in date order, in parallel
   batches of 5, stop at the first hit. Honor soft + hard deadlines (defaults
   20s / 25s); soft → partial state, hard → `LookupTimeoutError`.
5. Build "also in" list from the next ~5 newer tags.
6. Fetch + sanitize the GitHub Release notes (via `micromark` safe profile,
   then attribute scrub for `javascript:`/`vbscript:`/`data:text/html` URIs).

## License

MIT.
