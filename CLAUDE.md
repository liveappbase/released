# CLAUDE.md

Project-specific instructions for Claude Code. See `README.md` for the
human-facing overview.

## Project

`released` answers "which release first contains this commit?" for GitHub
and a curated set of GitLab hosts. It's a pnpm monorepo:

- `packages/core` — pure-TS algorithm + providers. Web Platform APIs only;
  runs in Node 22+ and Cloudflare Workers unchanged.
- `packages/cli` — Node CLI, published to npm as `git-released`.
- `packages/web` — Cloudflare Worker: homepage, permalink pages, JSON API.
- `packages/web-og` — Cloudflare Worker: OG-image PNG renderer. Service
  Binding to `web`.

Deploy order matters: `web` first, then `web-og` (the binding has to exist).

## Design system

Read `DESIGN.md` before making any visual or UI change. The source of truth
for tokens is `packages/web/src/ui/styles.ts` — `DESIGN.md` documents what
ships there. If you change a token in one, change it in both.

Specifics that come up often:
- Dark mode only. No light theme, no toggle.
- Geist + Geist Mono, self-hosted under `/fonts/`. Do not add Google Fonts
  preconnects — visitor IPs must stay on the edge.
- The `--accent` blue, `--ship` green, and `--warn` gold are semantic. Don't
  use them decoratively.
- Primary CTA = `--white` background. One per surface.

## Writing / voice

Applies to all human-facing copy: README, web page text (home, `/how-it-works`,
result cards, errors), blog and launch posts, release notes. Not code comments.

Write like a developer wrote it quickly. Lead with the concrete thing. State the
fact and skip the framing.

Avoid these LLM tells (they are tedious to read):

- Rhetorical section setups: "the question everyone eventually asks", "the part
  that's easy to get wrong", "here's the thing".
- Throat-clearing intros: "Is X annoying? Here's how Y fixes it." Just say what Y does.
- Balanced antithetical parallelism: "Date picks the order; ancestry decides the
  answer." Write it flat.
- Filler adjectives: "surprisingly", "simply", "powerful", "seamless", "robust",
  "comprehensive", "genuinely", "delightful".
- Em dashes for dramatic pauses in copy. Use a period or a colon.
- Headings that tease instead of describe. Prefer "Why it doesn't trust tag
  dates" over "The part that's easy to get wrong".

Quick test: if a sentence could open a blog post for any SaaS, cut it or rewrite
it as a plain statement of fact.

## Tests

```bash
pnpm -r test          # 180+ tests across packages
pnpm -r typecheck
pnpm -r build
```

Follow TDD: write a failing test before changing implementation behavior.
Pure refactors covered by existing tests are the exception — run them first
to confirm coverage.

## Algorithm guardrails

`packages/core/src/find-release.ts` is the heart of the product. Two rules
that have already cost us bugs:

- **Sort tags by date ascending; never *filter* by date.** Git dates aren't
  reliably monotonic with topology (clock skew, manual tag dates,
  cherry-picks). Date is ordering only; ancestry (`/compare`) is the sole
  containment test.
- **Partial state ≠ "not yet released."** A `partial` result from a soft
  deadline must surface a best-effort answer with a caveat, not the
  not-released UI. See `result-card.tsx`.

## Secrets / deploy

**Deploy = push to `main`.** `.github/workflows/release.yml` runs on every
push to `main` and deploys the Workers for you (`web` first, then `web-og`).
Do NOT run `wrangler deploy` by hand — CI owns the deploy order and holds the
Cloudflare credentials. Manual fallback, only if CI is down:
`pnpm --filter @released/web deploy && pnpm --filter @released/web-og deploy`.
Full detail in README "Deploy (Cloudflare Workers)".

Per-Worker secrets are set via `wrangler secret put`; see README "One-time
setup". `web-og` and `web` share an `INTERNAL_SECRET` for the Service
Binding handshake — they must match.

## Anubis relay container

`gitlab.freedesktop.org` / `gitlab.gnome.org` sit behind Anubis, which
fingerprints workerd's TLS/HTTP2 stack and challenges it — a token doesn't
help (Anubis runs before auth). Empirically the block is the *runtime
fingerprint*, not the IP: from one machine, `curl`/Node pass while workerd is
challenged, and a Cloudflare Container (Node) clears it. So for those hosts the
`web` Worker routes provider fetches through a **container relay** (`container/`
+ `src/relay.ts`, the `GitlabRelay` Durable Object). The Worker still runs the
whole algorithm; the container only ferries raw bytes, gated by `RELAY_SECRET`
+ an SSRF allowlist. Which hosts are relayed is the `ANUBIS_HOSTS` var
(`wrangler.toml`); an empty string disables it and lookups fall back to the
"use the CLI" card.

Two deploy prerequisites beyond the usual:
- `wrangler secret put RELAY_SECRET` on `web` (also propagated into the
  container). If unset, relay fetch is skipped and blocked hosts degrade to the
  CLI-hint card — no hard failure.
- The CI Cloudflare API token (`release.yml`) must include **Containers /
  Cloudchamber: Edit**, and the deploy runner needs Docker to build the image
  (GitHub-hosted ubuntu runners have it).
