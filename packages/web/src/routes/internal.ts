// Service-Binding-only endpoints (D23) that feed the web-og PNG renderer.
//   GET /internal/result/:owner/:repo/:sha     — GitHub (legacy/canonical)
//   GET /internal/h/:host/r/:projectPath/:sha  — federated (any host, #12)
// web-og calls these via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.

import { cacheKey, findRelease, type LookupInput } from '@released/core';
import type { Context } from 'hono';
import type { CacheEntry, WorkerCache } from '../cache.js';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { type Resolved, resolveLookup } from '../resolve.js';

/** Marker header set by the web-og Service Binding to identify itself.
 *  Cloudflare Service Binding requests can also be checked via the routing
 *  metadata; we use a shared-secret-style marker as an extra guard for v1. */
const SVC_HEADER = 'x-released-internal';

/** True when the caller presented the Service-Binding marker secret.
 *  Fails CLOSED when INTERNAL_SECRET is unset: a missing secret must DENY,
 *  never fall back to a guessable default (the legacy 'web-og' constant), or
 *  /internal/* would open to anyone who guesses it. Prod and `wrangler dev`
 *  (via .dev.vars) always set it; set with `wrangler secret put INTERNAL_SECRET`,
 *  matching web-og's. */
function isServiceBinding(c: Context): boolean {
  const env = (c.env ?? {}) as Env;
  const secret = env.INTERNAL_SECRET;
  if (!secret) return false;
  const marker = c.req.raw.headers.get(SVC_HEADER);
  return !!marker && marker === secret;
}

/** Origin for the result-cache key URL.
 *
 *  web-og hardcodes `https://web/internal/...` as the Service-Binding target, so
 *  keying the cache on the incoming request broke OG renders two ways (#143):
 *  `web` is not a routable hostname, which the Cache API silently declines to
 *  store (see cache.ts's header note), and it is a different namespace from the
 *  public permalink routes'. The OG path could therefore neither reuse a warm
 *  public entry nor persist its own, so every cold unfurl paid a full lookup,
 *  blew web-og's deadline, and got the placeholder cached by the crawler.
 *
 *  Resolve the origin this deployment's own public routes key on: an explicit
 *  PUBLIC_BASE_URL, else the committed PROD_HOST var, else the request's origin.
 *
 *  PUBLIC_BASE_URL is what makes that per-environment. PROD_HOST is committed in
 *  BOTH [vars] and [env.preview.vars] (it gates analytics, which must stay
 *  prod-only), so without an explicit override the preview Worker — and
 *  `wrangler dev`, which loads [vars] — would key on the production origin while
 *  their public routes key on the origin they actually serve. wrangler.toml sets
 *  PUBLIC_BASE_URL for preview; for `wrangler dev`, put
 *  `PUBLIC_BASE_URL=http://localhost:8787` in packages/web/.dev.vars (README,
 *  "Daily flow", says the same where a dev will actually look).
 *
 *  The fallback is NOT passed through `originOf`, because a request origin has no
 *  configured spelling to normalise — but it is the one input `originOf` exists to
 *  reject: a real Service Binding arrives as the non-routable `https://web` that
 *  #143 was about. Today only the unit tests reach it, and only with a routable
 *  origin; that holds because BOTH deployed envs set a var. If one ever stops —
 *  PROD_HOST dropped from [vars], blanked in the dashboard, or a new [env.*]
 *  deployed that the committed wrangler.toml does not describe — every read here
 *  misses and every write no-ops, and `neverFatal` renders that as "served, just
 *  not cached". Silence of exactly that kind is why #143 looked green for weeks,
 *  so say it out loud: the wrangler.toml guard in internal-cache-origin.test.ts
 *  covers the committed file, and this covers the config it cannot see. */
function cacheOrigin(env: Env, req: Request): string {
  // A var that is SET but rejected by `originOf` is otherwise indistinguishable
  // from unset — the `??` chain falls through, `configured` comes back truthy from
  // the next arm, and the fallback warning below is never reached. That silence
  // matters most on preview: PUBLIC_BASE_URL exists to stop preview keying on
  // production, but PROD_HOST is committed in [env.preview.vars] too, so a
  // dashboard-set PUBLIC_BASE_URL typo is caught by neither the `??` chain nor the
  // wrangler.toml guard, and preview writes onto the PRODUCTION origin silently.
  for (const [name, raw] of [
    ['PUBLIC_BASE_URL', env.PUBLIC_BASE_URL],
    ['PROD_HOST', env.PROD_HOST],
  ] as const) {
    if (raw && !originOf(raw)) {
      console.warn(
        `released: ${name} \`${raw}\` is not a routable cache origin — ignored. ` +
          'Its /internal cache entries key on whatever origin resolves next, which ' +
          "may be another environment's (#143).",
      );
    }
  }

  const configured = originOf(env.PUBLIC_BASE_URL) ?? originOf(env.PROD_HOST);
  if (configured) return configured;

  const fallback = new URL(req.url).origin;
  if (!isRoutableOrigin(fallback)) {
    console.warn(
      `released: /internal has no routable cache origin (${fallback}) — ` +
        'the result cache is disabled and every OG unfurl pays a full lookup (#143). ' +
        'Set PUBLIC_BASE_URL or PROD_HOST for this environment.',
    );
  }
  return fallback;
}

/** The routability rule `originOf()` applies, exported so the wrangler.toml
 *  config guard can run the SHIPPED predicate instead of a lookalike. A
 *  duplicate drifts: an earlier copy of this rule in the test read `URL.host`
 *  and `startsWith('localhost')`, so it rejected `http://app:8787` — which
 *  production accepts — and accepted `localhostx`, which production rejects.
 *
 *  Note the port is NOT part of `hostname` (it lives in `URL.port`; `hostname`
 *  holds a colon only for a bracketed IPv6 literal), so it has to be read
 *  separately. */
export function isRoutableOrigin(origin: string): boolean {
  const { hostname, port } = new URL(origin);
  return hostname.includes('.') || hostname === 'localhost' || port !== '';
}

/** Normalise a configured host or base URL to a bare origin, or null if it is
 *  unset/unparseable.
 *
 *  Both spellings have to be tolerated, because both vars are already written
 *  both ways: PUBLIC_BASE_URL carries a scheme, PROD_HOST does not, and
 *  isProdRequest() (analytics.ts) documents PROD_HOST as forgiving of a value
 *  "copied from PUBLIC_BASE_URL". Concatenating a scheme blindly does NOT throw
 *  on the mixed case — `new URL('https://https://host')` yields origin
 *  `https://https` — so it would silently key every entry on a non-routable host
 *  the Cache API drops, which is #143 exactly, with neverFatal swallowing it.
 *  The reverse slip is worse: a scheme-less PUBLIC_BASE_URL made `new Request()`
 *  throw OUTSIDE neverFatal, turning a computed answer into a 503 → placeholder.
 *  Parsing both through URL and taking .origin also drops any path/trailing slash. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value.includes('//') ? value : `https://${value}`).origin;
    // `URL.origin` is the literal string "null" for any opaque origin (a
    // non-special scheme: file:, foo:). Such a value contains '//', so it skips
    // the scheme-prefix branch and parses cleanly — returning a non-null,
    // non-URL string that satisfies `??` and then throws out of `new Request()`
    // below, OUTSIDE neverFatal. That is the scheme-less slip again: a 500 where
    // a computed answer was available, rendered as the neutral placeholder.
    if (origin === 'null') return null;
    // A single-label host (`web`, `localhost:8787`'s sibling shapes) is not
    // routable, and the Cache API silently declines a key URL on one — #143's
    // mechanism. `https://web` parses cleanly and yields a plausible-looking
    // origin, so a var accidentally set to the Service-Binding target would
    // otherwise sail through here looking configured while caching nothing.
    //
    // Be precise about the reach of this guard, because the ?? chain it falls
    // through to ends at the REQUEST origin. It fixes the case where the request
    // origin is routable (a `wrangler dev` or public request to /internal): the
    // key lands on a host this Worker actually serves and the entry persists. It
    // does NOT fix the Service-Binding case, where the request origin is that same
    // `https://web` — there is no routable candidate left, and a synthetic constant
    // would not help, because cache.ts's rule is that the key URL must be on the
    // Worker's OWN hostname (a made-up one no-ops exactly like `cache.invalid`).
    // That case is unguardable at runtime and is guarded in config instead, by the
    // wrangler.toml suite that requires every env to set PROD_HOST or
    // PUBLIC_BASE_URL.
    //
    // Single-label hosts are the ones to reject, with two real exceptions.
    // `localhost` is one — `wrangler dev` serves on it and README tells
    // developers to put it in PUBLIC_BASE_URL. An explicit PORT is the other: a
    // dev on Codespaces / Docker / WSL reaches the Worker at a service name like
    // `http://app:8787`, which is a host this Worker really does serve. Note the
    // port is NOT in `hostname` (it lives in `URL.port`; `hostname` holds a colon
    // only for a bracketed IPv6 literal), so it has to be read separately.
    //
    // Rejecting one of those would not be a harmless over-strictness: a REJECTED
    // PUBLIC_BASE_URL is indistinguishable from an unset one, so the ?? chain
    // falls through to PROD_HOST and every /internal entry keys on the production
    // origin while the public routes key on the dev one — the two-namespace split
    // of #143, reached silently despite the var being set correctly.
    return isRoutableOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** Wrap a cache so no Cache API call can be fatal. The key URL is deliberately
 *  not this request's own origin (see cacheOrigin) and the Cache API is entitled
 *  to refuse such a read or write; that must degrade to "served, just not
 *  cached". A 503 here is what web-og renders as the neutral placeholder — the
 *  #143 symptom — so a cache fault must never throw away a computed answer. */
function neverFatal(cache: WorkerCache): WorkerCache {
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return await cache.get<T>(key);
      } catch {
        return null;
      }
    },
    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      try {
        return await cache.getEntry<T>(key);
      } catch {
        return null;
      }
    },
    async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      try {
        await cache.put(key, value, ttlSeconds);
      } catch {
        // Served, just not cached.
      }
    },
  };
}

/** Message for the 503 web-og reads as "no result" (it renders the neutral card
 *  for any non-OK response, so only the body text differs by cause). */
function failureMessage(resolved: Exclude<Resolved, { status: 'ok' }>): string {
  if (resolved.status === 'not_yet') return resolved.error.message;
  if (resolved.status === 'transient') return resolved.kind;
  return (resolved.error as Error)?.message ?? 'failed';
}

/** Resolve the LookupResult JSON for a lookup input. Cache-first, then compute
 *  via the (relay-aware) provider.
 *
 *  The cache key MUST match the public permalink routes' exactly (result.tsx,
 *  issue.tsx, pr.tsx) or the OG card renders into a namespace no public hit can
 *  ever warm — that was half of #143. That means all five parts, including the
 *  `cull`/`nopre` suffixes for the default (non-strict, no-prerelease) options an
 *  OG card always renders, and the public `issue#`/`pr#` id spelling rather than
 *  the `issue:`/`pr:` this endpoint used to invent.
 *
 *  CAVEAT — this alignment is complete for the issue and PR routes only. On the
 *  COMMIT route `input.sha` is whatever web-og was handed, and `ui/og-meta.tsx`
 *  builds the `og:image` URL from `shortSha()` (7 chars) while `result.tsx` keys
 *  the permalink on the full 40. The two digests differ, so a commit unfurl still
 *  misses the slot the permalink warmed and still pays a full `findRelease`.
 *  Closing that needs a change to the PUBLIC routes' key namespace and is tracked
 *  as #147 — do not read this function as having fixed #143 for commit links. */
async function resolveResult(c: Context, input: LookupInput): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const { host, projectPath } = input.repo;

  const idPart = input.kind === 'commit' ? `sha:${input.sha}` : `${input.kind}#${input.number}`;
  const k = await cacheKey('res', `${host}/${projectPath}`, idPart, 'cull', 'nopre');
  const cache = neverFatal(makeWorkerCache(new Request(cacheOrigin(env, req))));

  // Same resolver the public routes use, on the same slot — sharing a cache slot
  // means sharing the policy that governs it: per-state hard TTLs (30 days
  // terminal / 24h pending / 60s partial), a 5-minute freshness window, and the
  // negative back-off that keeps a down host from being pounded. A flat TTL here
  // would downgrade a terminal slot the permalink would have kept for 30 days,
  // and a bare read would keep serving a 60-second partial for far longer than
  // the public page does. This caller BLOCKS on a refresh when the slot is not
  // servable. An earlier round added a stale-while-revalidate opt-out for it, but
  // `findRelease` emits only two entry shapes — TERMINAL (fresh forever) and
  // PARTIAL (fresh for its 60s, then unpinnable to a pinning consumer) — and
  // neither can be both stale and servable, so nothing could ever reach it (round
  // 9: dead code, removed). web-og waiting on a cold or unpinnable slot is #152.
  // Options are stated explicitly because they are what the
  // `cull`/`nopre` key parts promise. Anubis-protected hosts get a relay-backed
  // fetch (see makeProvider/relay.ts). The web-og caller chose to wait for this.
  const resolved = await resolveLookup({
    cache,
    key: k,
    load: () =>
      findRelease(input, {
        client: makeProvider(env, req, host),
        strict: false,
        includePrereleases: false,
      }),
    // The shared key means a public page view's failed lookup also writes the
    // shared `:neg` back-off marker. Honouring that on a COLD slot would 503 here
    // without ever calling findRelease, and the crawler caches the resulting
    // placeholder for good — #143 all over again, via the alignment that fixes it.
    //
    // On THIS path the opt-out is unconditional, not cold-only, and the flag name
    // reads more conditional than the code is: of the two entry shapes findRelease
    // emits, a TERMINAL prior returns at the fresh exit and a PARTIAL one is either
    // fresh (same exit) or unpinnable, so no prior ever reaches the marker's
    // stale-serve. The cost is real and accepted — during a
    // host outage each unfurl runs its own findRelease out to the hard deadline
    // (see resolveLookup's fall-through comment) — because the alternative for a
    // consumer that asks ONCE is a placeholder pinned long after the host recovers.
    //
    // The asymmetry is deliberate: this caller opts out of READING the marker on
    // a cold slot, but resolveLookup still WRITES it when the slot was cold, so a
    // failure discovered here can back off a human permalink for up to 60s. That
    // is the point of sharing the slot — the marker describes the HOST being down,
    // not who found it out, and the host is equally down for the human. They get
    // the "checking…" recovery card (never a wrong "not yet released") and can
    // reload; the crawler asks once and keeps what it got. Suppressing the write
    // would instead leave the key with no back-off at all whenever the crawler
    // touches it first, and every human reload would pound the down host.
    //
    // What it does NOT do is re-stamp a marker it bypassed. Writing on every
    // bypassed failure would keep the shared marker permanently younger than
    // NEG_TTL under a once-a-minute unfurl cadence, and the humans on this key —
    // who do not bypass — would never see it expire, i.e. never get the retry
    // window the back-off exists to give them. resolveLookup writes the marker
    // only when it was cold (`!backedOff`), so their clock runs uninterrupted.
    bypassBackOffWhenUnservable: true,
    // web-og renders whatever we return into a PNG it long-caches for 24h, and
    // nothing here can invalidate that PNG afterwards. So no exit may hand this
    // caller a CACHED entry that is either older than the stale bound — before
    // #143 this route had a flat 30-minute TTL and could not, and it now shares
    // the public routes' 24h slot, where a 23h-old answer is representable — or
    // a truncated `partial`, whose `firstRelease: null` web-og would render as a
    // definite "not yet released" (badge.ts writes those onto this same key with
    // an 8s soft deadline). Rather than pin either, we pay a fresh lookup, or
    // 503 into a short-cached placeholder. web-og long-caching a partial that
    // THIS route's own lookup produced is the remaining half, tracked in #151.
    consumerPinsResult: true,
    // Share the SLOT with badge.ts and the permalink pages, but not the in-isolate
    // FLIGHT. Aligning the cache key also aligned the single-flight key, and
    // `singleFlight` runs the first registrant's loader for every joiner: a badge
    // request that registers first (badge.ts:110 builds a byte-identical key for
    // `issue#N`/`pr#N`) would hand this route its own 8-second-deadline result. On
    // a repo that needs longer than that, this caller would inherit a `partial` and
    // 503 into a pinned placeholder — #143's symptom, on a link where this route's
    // own 24s deadline finds the answer. On main that could not happen, because
    // /internal keyed on a three-part key of its own. Concurrent OG unfurls of the
    // same key still collapse into one flight; only the cross-caller join is cut.
    flightKey: `${k}:og`,
  });
  // Refusing to SERVE a cached partial (consumerPinsResult, above) is only half
  // the guardrail: on a repo that reliably blows findRelease's soft deadline the
  // recompute it forces returns a partial too, and a 200 here pins exactly the
  // answer the refusal exists to prevent.
  //
  // NO partial is servable to this caller, whichever shape it has. With
  // `firstRelease: null`, web-og renders `firstRelease?.tag ?? 'not yet released'`
  // and long-caches it, so a truncated traversal of a RELEASED commit becomes a
  // definite "not yet released" for 24h — the CLAUDE.md guardrail ("Partial state
  // != 'not yet released'"). WITH a `firstRelease` it is no safer: that tag is the
  // gallop hit, and the bisect that would confirm no EARLIER release contains the
  // commit is precisely what the deadline cut short ("the gallop-found tag is
  // almost always the right answer; bisect just verifies could there be an earlier
  // one", find-release.ts:288-292). "Almost always" is a caveat the result card
  // renders and an OG card cannot. Answering "which release FIRST contains this
  // commit" with a possibly-later release is the one thing this product must not
  // do, so both fall through to the 503: web-og caches the neutral placeholder at
  // max-age=60, which claims nothing and self-heals on the next unfurl, and the
  // permalink it links to still shows the best-effort answer WITH its caveat.
  //
  // resolveLookup hands back a partial it computed less than HARD_TTL_PARTIAL ago
  // rather than recomputing it (see `shouldRecompute`), so this 503 is throttled to
  // one traversal per 60s per key, and ONLY for a partial this route itself computed
  // (a badge-truncated one in the shared slot is recomputed, not inherited). Do NOT read that as "the cost is bounded": web-og
  // short-caches the neutral placeholder at max-age=60 and HARD_TTL_PARTIAL is
  // also 60, so for a URL under active unfurling the two cadences COINCIDE and the
  // throttle buys close to nothing. On a repo that reliably blows the soft deadline
  // (GNOME/gimp: large tag set, single-instance relay) the card never converges —
  // it is the placeholder forever — and upstream load for that key goes from ~0 to
  // a full traversal per minute for as long as the link is being unfurled. That is
  // the accepted price of not pinning an unconfirmed answer for 24h; making the
  // card render the gallop hit while keeping it revalidatable needs web-og to
  // short-cache it, which is #156 (adjacent to #151).
  if (resolved.status === 'ok') {
    if (!resolved.result.partial) {
      return new Response(JSON.stringify(resolved.result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'partial' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: failureMessage(resolved) }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

/** Parse a permalink :number param into a positive int, or null if invalid. */
function parseNumber(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET /internal/result/:owner/:repo/:sha — GitHub-only (legacy/canonical). */
export async function internalResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/h/:host/r/:projectPath/:sha — federated (any host, #12).
 *  projectPath is URL-encoded into a single segment, matching the /h/ permalink
 *  routes. Hono already percent-decodes c.req.param() (safe try/catch), so do
 *  NOT decodeURIComponent again — that's a redundant double-decode that throws
 *  URIError on a malformed escape (bad%25 → bad% → throws) → HTTP 500. */
export async function internalFederatedResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const sha = c.req.param('sha');
  if (!host || !projectPath || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host, projectPath },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/issue/:owner/:repo/:number — GitHub issue (#79). Resolves the
 *  issue (→ its closing commit(s) → release) so the returned result carries
 *  subject = the issue title, which web-og renders on the title-aware OG card. */
export async function internalIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/pr/:owner/:repo/:number — GitHub PR (#79). Resolves the PR to
 *  its merge commit so subject = the PR title. */
export async function internalPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/h/:host/i/:projectPath/:number — federated issue (#79). */
export async function internalFederatedIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host, projectPath },
    number,
  });
}

/** GET /internal/h/:host/p/:projectPath/:number — federated PR/MR (#79). */
export async function internalFederatedPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host, projectPath },
    number,
  });
}
