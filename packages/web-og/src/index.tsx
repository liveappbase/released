// web-og Worker: renders OG PNGs for permalink URLs.
//
// GET /r/:owner/:repo/c/:sha.png             — GitHub (legacy/canonical)
// GET /h/:host/r/:projectPath/c/:sha.png     — federated (any host, #8)
//   → Fetch the result data from `web` via Service Binding (D23).
//   → Render PNG via @cloudflare/workers-og (Satori + resvg-wasm).
//   → Cache 24h, but only for a SETTLED answer (a released commit). A
//     not-yet-released or partial result, and a data miss (neutral
//     placeholder), get a short TTL so the card can still flip (#151).

import { type LookupResult, OG_TEMPLATE_VERSION } from '@released/core';
import { type Context, Hono } from 'hono';
import { ImageResponse } from 'workers-og';
import type { Env } from './env.js';

const app = new Hono<{ Bindings: Env }>();

/** Render a card for a route that `web` links with `?v=${OG_TEMPLATE_VERSION}`.
 *
 *  `release.yml` deploys `web` BEFORE `web-og`, so during the deploy window this
 *  build can be asked for a template version it cannot render: `web` is already
 *  emitting `?v=og.vNEXT` while this Worker is still the old build. Serving that
 *  URL from the old template under the 24h cache would pin a stale card in every
 *  downstream cache — and the version-busting URL is already spent, so there is
 *  no second URL left to bump. An unrenderable version falls back to SHORT_CACHE
 *  and self-heals 60s after web-og lands.
 *
 *  No `v` at all is not evidence of a mismatch (a hand-typed or pre-#55 crawler
 *  URL), so it keeps the result-based default. */
function renderCard(
  c: Context,
  result: LookupResult | null,
  ctx: { owner: string; repo: string; sha?: string; number?: string },
): Response {
  const v = c.req.query('v');
  return renderImage(
    result,
    ctx,
    v !== undefined && v !== OG_TEMPLATE_VERSION ? SHORT_CACHE : undefined,
  );
}

/** Fetch the result JSON from the `web` Worker via Service Binding. Returns null
 *  on any miss/error so the caller renders a short-cached placeholder. */
async function fetchResult(env: Env, internalUrl: string): Promise<LookupResult | null> {
  try {
    const res = await env.WEB.fetch(internalUrl, {
      headers: { 'x-released-internal': env.INTERNAL_SECRET ?? 'web-og' },
    });
    if (res.ok) return (await res.json()) as LookupResult;
  } catch {
    // Fall through to placeholder.
  }
  return null;
}

// GitHub permalinks (legacy/canonical).
app.get('/r/:owner/:repo/c/:shaPng', async (c) => {
  const { owner, repo, shaPng } = c.req.param();
  if (!shaPng.endsWith('.png')) return c.text('not found', 404);
  const sha = shaPng.slice(0, -4);

  const internalUrl = `https://web/internal/result/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderCard(c, result, { owner, repo, sha });
});

// Federated permalinks (any non-GitHub provider, #8). projectPath is URL-encoded
// into a single segment, matching the /h/ scheme in web/src/index.ts.
app.get('/h/:host/r/:projectPath/c/:shaPng', async (c) => {
  const { host, projectPath, shaPng } = c.req.param();
  if (!shaPng.endsWith('.png')) return c.text('not found', 404);
  const sha = shaPng.slice(0, -4);

  // projectPath is already percent-decoded by Hono's router (via a safe
  // try/catch), so re-encoding here yields one clean segment regardless of how
  // the caller encoded it. Do NOT decodeURIComponent again — that's a redundant
  // double-decode that throws URIError on a malformed escape (foo%2 → 500).
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/r/${encodeURIComponent(projectPath)}/${encodeURIComponent(sha)}`;
  const result = await fetchResult(c.env, internalUrl);

  // Placeholder context: split the project path on the first slash so
  // PlaceholderCard's `owner/repo` label renders the full path.
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderCard(c, result, { owner, repo, sha });
});

// GitHub issue/PR permalinks (#79): title-aware OG card. Fetches the result
// resolved AS an issue/PR (not the bare closing commit) so result.subject
// carries the issue/PR title and the card can render "Issue #N" / "PR #N".
app.get('/i/:owner/:repo/:numberPng', async (c) => {
  const { owner, repo, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/issue/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderCard(c, result, { owner, repo, number });
});

app.get('/p/:owner/:repo/:numberPng', async (c) => {
  const { owner, repo, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderCard(c, result, { owner, repo, number });
});

// Federated issue/PR permalinks (#79). projectPath URL-encoded into one segment,
// matching the /h/ scheme in web/src/index.ts.
app.get('/h/:host/i/:projectPath/:numberPng', async (c) => {
  const { host, projectPath, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/i/${encodeURIComponent(projectPath)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderCard(c, result, { owner, repo, number });
});

app.get('/h/:host/p/:projectPath/:numberPng', async (c) => {
  const { host, projectPath, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/p/${encodeURIComponent(projectPath)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderCard(c, result, { owner, repo, number });
});

// The one null-result render that is NOT transient: no owner/repo/sha, so the
// PNG is byte-identical on every request, and `web` only ever links it as
// `/placeholder.png?v=${OG_TEMPLATE_VERSION}` (packages/web/src/ui/og-meta.tsx)
// — a template change busts the URL instead of waiting out a TTL. Inheriting
// the null-result SHORT_CACHE would re-run a ~700ms satori+resvg wasm render
// every 60s for an image that can never differ, so it opts into LONG_CACHE
// explicitly. The default stays short for the genuinely transient null
// renders (service-binding miss, the notFound deploy-window path below).
//
// The long cache is gated on the requested version being one THIS build can
// render, because `release.yml` deploys `web` before `web-og`: on a template
// bump `web` emits `?v=og.vNEXT` while this Worker is still the old build, and
// long-caching that URL would pin a stale-template card for 24h with no second
// URL left to bust. Falling back to SHORT_CACHE self-heals 60s after web-og
// lands, then the version matches and the 24h cache resumes.
app.get('/placeholder.png', (c) =>
  renderImage(
    null,
    { owner: '', repo: '' },
    c.req.query('v') === OG_TEMPLATE_VERSION ? LONG_CACHE : SHORT_CACHE,
  ),
);

app.get('/healthz', (c) => c.text('ok'));

// An unmatched .png request (a stale crawler URL, or a permalink OG URL hit
// during the brief web→web-og deploy window before web-og has the matching
// route) renders a short-cached placeholder PNG instead of a 404 text body — a
// social unfurl fetcher gets a valid image, not an error. Non-.png paths still
// 404. (Deploy-order safety: web deploys before web-og in CI, so og:image URLs
// can briefly point at routes web-og hasn't shipped yet.)
app.notFound((c) => {
  if (c.req.path.endsWith('.png')) return renderImage(null, { owner: '', repo: '' });
  return c.text('not found', 404);
});

export default app;

// --- rendering ---------------------------------------------------------------

// `no-transform` is carried deliberately: workers-og's own default included it,
// and `res.headers.set` below replaces that value outright, so dropping it here
// would silently let a transforming edge (Polish/Mirage, or any proxy in front
// of the og.* zone) recompress the PNG that `web` links as the byte-exact social
// card. Everything after it is the actual freshness policy.
export const LONG_CACHE = `public, no-transform, max-age=${24 * 60 * 60}, s-maxage=${24 * 60 * 60}`;

/** A card we could NOT render from a result: the placeholder. Either `/internal`
 *  missed/failed (transient — retry soon), or the URL carries a template version
 *  this build cannot render (self-heals once web-og lands). Both want the
 *  shortest honest retry window, so this stays at 60s. */
export const SHORT_CACHE = 'public, no-transform, max-age=60';

/** A card we DID render, from an answer that is still in motion: not-yet-released
 *  or a soft-deadline `partial`. Distinct from SHORT_CACHE because the question is
 *  different — not "how fast should a failure retry" but "how fast can this answer
 *  actually change". It cannot change faster than the data behind it, and
 *  `/internal` stores every computed result for 30 minutes
 *  (`cache.put(k, r, 30 * 60)`, packages/web/src/routes/internal.ts). A 60s TTL
 *  therefore bought no freshness the upstream has: it re-ran the ~700ms
 *  satori+resvg wasm render up to 60x/hour per URL for byte-identical JSON. 300s
 *  matches the TTL `badge.ts` already uses for the same pending state, and is
 *  still 6x fresher than the upstream cache it reads through. */
export const PENDING_CACHE = 'public, no-transform, max-age=300, s-maxage=300';

/** True only when the answer the card renders can never change again: a
 *  completed traversal that found a release.
 *
 *  The lifetime used to key on whether a result came back AT ALL, which
 *  long-cached two shapes that are still in motion (#151):
 *
 *  - a `partial` is a best-effort answer from a traversal the soft deadline
 *    truncated, so its `firstRelease` is not confirmed to be the earliest one.
 *    It has to stay revalidatable rather than be pinned as if it were final.
 *    **This is the arm that changes production behaviour** (24h → 300s).
 *  - `firstRelease: null` renders "not yet released", the one card whose whole
 *    job is to flip once a release contains the commit. Two DIFFERENT shapes
 *    render it, and only one of them is unreachable:
 *
 *      - BARE null (no `partial`): core does not emit it. `find-release.ts:316`
 *        is its only `firstRelease: null` return and it always carries
 *        `partial: soft_deadline`, and a genuine not-yet-released commit throws
 *        `NotYetReleasedError` (`:326`, `:478` for the issue/PR aggregation),
 *        which `/internal` turns into a 503
 *        (`web/src/routes/internal.ts:67-72`) — so `fetchResult` sees
 *        `!res.ok`, returns null, and web-og renders the neutral PLACEHOLDER at
 *        `SHORT_CACHE`, never this card. The bare-null arm below is a defensive
 *        guard on a shape the type permits and core keeps a fallback branch for
 *        (`:486`), not a bug that shipped.
 *      - null WITH `partial: soft_deadline`: REACHABLE, and it ships the "not
 *        yet released" card today. `find-release.ts:312-322` returns it as a
 *        normal value, `/internal` caches it and answers 200, so `ResultCard`
 *        sets `tag = firstRelease?.tag ?? 'not yet released'`. That is the
 *        blown-soft-deadline route into this card, not `NotYetReleasedError`.
 *        PR #144 makes `/internal` 503 every `partial`, which closes this route
 *        until #156 reopens it with a caveat on the card — but the shape is live
 *        on `main` right now, so the lifetime rule has to be right for it either
 *        way. It is: PENDING via the `partial` arm above. `routing.test.ts` has
 *        a copy guard on it.
 *
 *  What that means for #151's headline case: the not-yet-released unfurl is
 *  still wrong today, but wrong in a different way than "pinned for 24h" — it
 *  is the neutral "Looking up…" placeholder rather than a card saying the
 *  commit is unreleased. That is #150, and it is deliberately NOT fixed here:
 *  it needs `/internal` to stop 503-ing `NotYetReleasedError`, which is a
 *  change to the web package's error mapping, not to this lifetime rule.
 *
 *  This is STRICTER than the web side, deliberately. `hardTtlFor()`
 *  (packages/web/src/resolve.ts) tests `firstRelease` first, so a partial
 *  that carries a `firstRelease` gets the 30-day terminal TTL there, and
 *  `badge.ts` long-caches the same shape for 24h. A truncated traversal that
 *  reported v2.0.0 when v1.9.0 was the true earliest is therefore still
 *  pinned on those two surfaces — the partial half of #151, tracked
 *  separately in #159. Here it revalidates.
 *
 *  It is the OG analogue of the badge invariant the project already states:
 *  released → long cache, not-yet/checking → short cache. */
function isTerminal(result: LookupResult): boolean {
  return result.firstRelease != null && !result.partial;
}

export function renderImage(
  result: LookupResult | null,
  ctx: { owner: string; repo: string; sha?: string; number?: string },
  cacheOverride?: string,
): Response {
  const SIZE = { width: 1200, height: 630 };
  const cacheControl =
    cacheOverride ??
    (result == null ? SHORT_CACHE : isTerminal(result) ? LONG_CACHE : PENDING_CACHE);

  const node = result ? ResultCard(result) : PlaceholderCard(ctx);

  const res = new ImageResponse(node, {
    ...SIZE,
    headers: {
      'x-og-template': OG_TEMPLATE_VERSION,
    },
  });
  // Set cache-control on the RESPONSE, not through ImageResponse's `headers`
  // option. workers-og builds its header object as
  //   { 'Content-Type': …, 'Cache-Control': <1-year immutable default>, ...opts.headers }
  // and object spread is case-SENSITIVE, so a lowercase 'cache-control' passed
  // in above does NOT replace that default — both keys reach `new Response`,
  // where Headers merges them into one value ("public, immutable, no-transform,
  // max-age=31536000, public, max-age=60") and caches honor the FIRST max-age.
  // That pinned every short-cached card (placeholder, cold lookup, the
  // deploy-window notFound render) as immutable for a year, so a transient
  // failure's unfurl could never refresh. Headers.set is case-insensitive and
  // replaces the default outright, whatever casing the library uses.
  res.headers.set('cache-control', cacheControl);
  return res;
}

function ResultCard(r: LookupResult) {
  const tag = r.firstRelease?.tag ?? 'not yet released';
  const date = r.firstRelease ? r.firstRelease.date.slice(0, 10) : '';
  const repo = r.input.repo.projectPath;
  const sha = r.canonicalSha.slice(0, 7);

  // #79: issue/PR results get a title-aware headline ("Issue #N" / "PR #N" +
  // the title from result.subject). findReleaseForIssue / the pr path set
  // subject to the issue/PR title; commit results leave it as the commit
  // subject, which the commit card does NOT surface (unchanged behavior).
  // web-og has no provider terms, so the noun/sigil branches on host: a
  // GitLab MR unfurls as "Merge request !N" (matching its permalink page, which
  // pulls the wording from provider.terms), not GitHub's "PR #N". Issues use "#"
  // on every host, so they need no branch.
  const input = r.input;
  const kindLabel =
    input.kind === 'issue'
      ? `Issue #${input.number}`
      : input.kind === 'pr'
        ? input.repo.host === 'github.com'
          ? `PR #${input.number}`
          : `Merge request !${input.number}`
        : null;
  const title = kindLabel !== null ? (r.subject ?? null) : null;
  // Shrink the release tag when a headline is present so both fit the card.
  const tagFontSize = kindLabel !== null ? 96 : 140;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0a0a0a',
        color: '#ededed',
        display: 'flex',
        flexDirection: 'column',
        padding: '64px 80px',
        fontFamily: 'Geist, sans-serif',
        position: 'relative',
      }}
    >
      {/* top: wordmark + meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 28, fontWeight: 600 }}
        >
          <div style={{ width: 14, height: 14, borderRadius: 7, background: '#52a8ff' }} />
          <span>released</span>
        </div>
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#a1a1a1', fontSize: 24 }}>
          {repo}
        </div>
      </div>

      {/* issue/PR headline (#79) — kind label + title, above the release tag */}
      {kindLabel !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 36 }}>
          <div style={{ color: '#52a8ff', fontSize: 26, fontWeight: 600, letterSpacing: 1 }}>
            {kindLabel}
          </div>
          {title !== null && (
            <div style={{ fontSize: 40, fontWeight: 600, marginTop: 12, lineHeight: 1.2 }}>
              {/* Cap at ~2 lines (80 chars): GitHub allows 256-char titles, which
                  would wrap 4+ lines, collapse the spacer, and clip the card's
                  bottom meta + tag under satori's fixed 630px canvas. Truncate on
                  a code-point boundary (Array.from) so an emoji straddling index
                  79 isn't split into a lone surrogate (renders as □). */}
              {title.length > 80 ? `${Array.from(title).slice(0, 79).join('')}…` : title}
            </div>
          )}
        </div>
      )}

      {/* spacer */}
      <div style={{ flex: 1 }} />

      {/* hero */}
      <div
        style={{
          color: '#a1a1a1',
          fontSize: 22,
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: 5, background: '#3fb950' }} />
        <span>First released in</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <div
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontWeight: 700,
            fontSize: tagFontSize,
            lineHeight: 1,
          }}
        >
          {tag}
        </div>
        {r.firstRelease && (
          <div
            style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 20,
              color: '#3fb950',
              background: '#1a3a22',
              padding: '8px 16px',
              borderRadius: 8,
              fontWeight: 600,
              letterSpacing: 1,
            }}
          >
            SHIPPED
          </div>
        )}
      </div>
      {date && (
        <div style={{ fontSize: 30, color: '#ededed', marginTop: 16, fontWeight: 500 }}>{date}</div>
      )}

      {/* spacer */}
      <div style={{ flex: 1 }} />

      {/* bottom meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        {/* One text node, not `commit {sha}` (two children): satori throws on a
            multi-child element with no `display: flex`, yielding a 0-byte PNG. */}
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 22 }}>
          {`commit ${sha}`}
        </div>
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 18 }}>
          released.blabberate.com
        </div>
      </div>
    </div>
  );
}

function PlaceholderCard(ctx: { owner: string; repo: string; sha?: string; number?: string }) {
  // Commit lookups identify by sha (`@ abc1234`); issue/PR by number (`#11`).
  const ident =
    ctx.number !== undefined ? ` #${ctx.number}` : ctx.sha ? ` @ ${ctx.sha.slice(0, 7)}` : '';
  const label = ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}${ident}` : 'released';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0a0a0a',
        color: '#ededed',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '64px',
        fontFamily: 'Geist, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          fontSize: 40,
          fontWeight: 600,
          marginBottom: 40,
        }}
      >
        <div style={{ width: 18, height: 18, borderRadius: 9, background: '#52a8ff' }} />
        <span>released</span>
      </div>
      <div style={{ fontSize: 28, color: '#a1a1a1', marginBottom: 12 }}>Looking up…</div>
      <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 24, color: '#6e6e6e' }}>
        {label}
      </div>
    </div>
  );
}
