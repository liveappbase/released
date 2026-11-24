// Light integration tests using Hono's app.fetch directly.
// No Cloudflare runtime needed — Hono apps are plain Request handlers.

import { cacheKey } from '@released/core';
import { describe, expect, it, vi } from 'vitest';

// Polyfill the Workers-only `caches.default` for these tests so cache.ts works.
const cacheStore = new Map<string, Response>();
(
  globalThis as unknown as {
    caches: { default: { match: typeof Cache.prototype.match; put: typeof Cache.prototype.put } };
  }
).caches = {
  default: {
    async match(req: Request | string) {
      const url = typeof req === 'string' ? req : req.url;
      const stored = cacheStore.get(url);
      return stored ? stored.clone() : undefined;
    },
    async put(req: Request | string, res: Response) {
      const url = typeof req === 'string' ? req : req.url;
      cacheStore.set(url, res);
    },
  } as unknown as Cache,
};

const { default: app } = await import('../src/index.js');

// A shared secret that is deliberately NOT the public 'web-og' default, so the
// /internal/* tests exercise the real web↔web-og handshake, not the fallback.
const INTERNAL_SECRET = 'test-shared-secret';

// Seed the result-cache slot the federated /internal/h/... route reads, keyed to
// the GNOME/gimp fixture every host-keyed test below uses. `result` is an
// intentionally partial fixture — only the fields the route deserializes — so it's
// typed `unknown`, not LookupResult (a full LookupResult isn't required to exercise
// the route, and the seeded fixtures below don't populate one).
async function seedFederatedResult(sha: string, result: unknown) {
  const key = await cacheKey('res', 'gitlab.gnome.org/GNOME/gimp', `sha:${sha}`, 'cull', 'nopre');
  cacheStore.set(
    `https://released.example/__cache__/${encodeURIComponent(key)}`,
    new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }),
  );
}

describe('web Worker — basic routing', () => {
  it('serves the homepage with the EXAMPLE result (real, click-to-verify)', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Is your commit shipped?');
    expect(body).toContain('EXAMPLE');
    // Real example: honojs/hono @ f82aba8 → v4.12.11
    expect(body).toContain('v4.12.11');
    expect(body).toContain('honojs/hono');
    expect(body).toContain('f82aba8');
    // "Run it yourself" link must point at /lookup with the github URL.
    expect(body).toContain('Run it yourself');
    expect(body).toMatch(/\/lookup\?q=.*github\.com.*honojs.*hono.*f82aba8/);
  });

  it('healthz returns ok', async () => {
    const res = await app.fetch(new Request('https://released.example/healthz'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('version reports the deployed Cloudflare version metadata', async () => {
    const res = await app.fetch(new Request('https://released.example/version'), {
      CF_VERSION_METADATA: {
        id: '8a9f0b3c-1234-4abc-9def-000000000000',
        tag: 'abc1234',
        timestamp: '2026-06-26T00:00:00Z',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Loop observability: short cache so a deploy is reflected promptly.
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { id: string; tag: string; timestamp: string };
    expect(body.id).toBe('8a9f0b3c-1234-4abc-9def-000000000000');
    expect(body.tag).toBe('abc1234');
    expect(body.timestamp).toBe('2026-06-26T00:00:00Z');
  });

  it('version degrades to nulls when the binding is absent (dev/tests)', async () => {
    const res = await app.fetch(new Request('https://released.example/version'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string | null };
    expect(body.id).toBeNull();
  });

  // Loading-state contract: on form submit the user must get visible
  // feedback within ~16ms so they don't think the click was lost. The
  // homepage form is a full-page-nav (GET /lookup → 302 → /r/...) and the
  // /r/... compute can take 4-10s on cold cache. We hook submit with a
  // tiny inline script that:
  //   (1) marks the form opted-in via `data-loading-form`
  //   (2) the shared CLIENT_JS in Layout finds those forms and on submit
  //       adds a `.loading` class + swaps the button label to "Looking up…"
  // This test asserts the contract: the form is opted in AND the script
  // that handles it is on the page.
  it('homepage form is opted into the loading-state handler', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    // (1) form has the opt-in attribute (attribute order is renderer-defined)
    expect(body).toMatch(/<form[^>]*data-loading-form[^>]*>/);
    expect(body).toMatch(/<form[^>]*action="\/lookup"[^>]*>/);
    // (2) inline script targets the opted-in attribute
    expect(body).toContain('data-loading-form');
    // (3) loading-state copy is present (the script swaps to this)
    expect(body).toContain('Looking up');
  });

  it('GET /lookup?q=... redirects to the canonical permalink', async () => {
    const res = await app.fetch(
      new Request('https://released.example/lookup?q=github.com/facebook/react/commit/abc1234'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/r/facebook/react/c/abc1234');
  });

  it('GET /lookup?q=<malformed> bounces back to / with bad= AND reason= params', async () => {
    const res = await app.fetch(new Request('https://released.example/lookup?q=garbage-input'));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('bad=garbage-input');
    expect(loc).toContain('reason=invalid_input');
  });

  it('GET /lookup?q=<federated own-URL with a malformed %> bounces, never 500s', async () => {
    // Same bug class as the public-route double-decode: recognizeOwnUrl() runs
    // OUTSIDE the try/catch and calls decodeURIComponent() (own-url.fed) on the
    // captured project path. A stray/typo'd "%" (e.g. a mangled pasted link)
    // throws URIError before the catch → bare 500 instead of the bounce-to-form.
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' + encodeURIComponent('gitlab.gnome.org/p/x%2G/1'),
      ),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('/?')).toBe(true);
    expect(loc).toMatch(/bad=/);
    expect(loc).toMatch(/reason=/);
  });

  it('GET /lookup?q=<gitlab.com URL> redirects to the federated permalink (post-federation)', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.com/foo/bar/-/commit/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    // Federated path: /h/{host}/r/{projectPathEnc}/c/{sha}
    expect(res.headers.get('location')).toBe('/h/gitlab.com/r/foo%2Fbar/c/abc1234');
  });

  it('GET /lookup?q=<GitHub issue URL> redirects to the /i/ issue permalink (#54)', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://github.com/honojs/hono/issues/1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/i/honojs/hono/1234');
  });

  it('GET /lookup?q=<GitLab issue URL> redirects to the federated /i/ permalink (#54)', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.gnome.org/GNOME/gimp/-/issues/9876'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/h/gitlab.gnome.org/i/GNOME%2Fgimp/9876');
  });

  it('GET /lookup?q=<unknown gitlab host> bounces with reason=unsupported_host', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.example.com/x/y/-/commit/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=unsupported_host');
  });

  it('GET /lookup?q=<bitbucket URL> bounces with reason=unsupported_host', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://bitbucket.org/atlassian/jira/commits/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=unsupported_host');
  });

  it('homepage placeholder mentions GitHub forms first, GitLab abbreviated last (GitHub-default constraint)', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // GitHub forms are positions 1-3, GitLab is position 4. This locks in the
    // design-review decision so a future contributor doesn't "fairly" re-order.
    expect(body).toMatch(
      /placeholder="github\.com[^"]*owner\/repo[^"]*o\/r#PR[^"]*gitlab\.gnome\.org/,
    );
    // Field label generalizes to pull/merge.
    expect(body).toContain('Commit URL, SHA, or pull/merge request');
  });

  it('unsupported_host error copy lists supported hosts AND names EXTRA_GITLAB_HOSTS', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/?bad=' +
          encodeURIComponent('https://gitlab.example.com/x/y') +
          '&reason=unsupported_host',
      ),
    );
    const body = await res.text();
    expect(body).toContain('gitlab.gnome.org');
    expect(body).toContain('EXTRA_GITLAB_HOSTS');
  });

  it('GET /h/:host/p/:projectPath/:number routes to the prRoute handler (federation)', async () => {
    // Mock the outbound GitLab call so the test doesn't hit the real network.
    // The MR exists but is not merged — exercises the "Merge request not merged"
    // rendering path, which is where the federation-aware label + URL matter most.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org')) {
        return new Response(
          JSON.stringify({
            state: 'opened',
            merge_commit_sha: null,
            squash_commit_sha: null,
            sha: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/2466'),
      );
      const body = await res.text();
      expect(res.status).toBe(200); // "Not merged yet" is a real answer, not an error
      // Federation-aware vocabulary in the rendered page:
      expect(body).toContain('Merge request'); // not "Pull request"
      expect(body).toContain('!2466'); // GitLab uses ! prefix, not #
      // Link routes back to the GitLab host (not github.com).
      expect(body).toContain('gitlab.gnome.org/GNOME/gimp/-/merge_requests/2466');
      // Security headers still fire.
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GitLab MR result form pre-fills the FULL URL (round-trips through parseInput, not the GitHub shorthand)', async () => {
    // Regression: the `owner/repo#N` shorthand is GitHub-only. If a GitLab
    // MR result rendered the input as `Infrastructure/gimp-macos-build#398`,
    // re-submitting that form would route to github.com/Infrastructure/...
    // and return "PR not found". Pre-fill must be a host-aware URL.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        // Merged MR with FF sha so the algorithm advances past PR-resolution.
        if (url.includes('/merge_requests/398')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          // GitlabProvider.containingTags shortcut: tag contains the commit.
          // Must come BEFORE the /repository/commits/ branch — refs is a subpath.
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          // One tag so the algorithm has something to bisect (then returns
          // "not yet released" → renders the result page with the form).
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/compare')) {
          // Tag CONTAINS the commit (empty commits → "behind" → contains).
          // The success path is where the form-with-pre-fill renders.
          return new Response(JSON.stringify({ commits: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/releases/')) {
          // No Release object → null body.
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request(
          'https://released.example/h/gitlab.gnome.org/p/Infrastructure%2Fgimp-macos-build/398',
        ),
      );
      const body = await res.text();
      // The input field must be pre-filled with a URL that parses back to the
      // SAME GitLab MR — not the `owner/repo#N` shorthand (GitHub-only).
      expect(body).toMatch(
        /<input[^>]*name="q"[^>]*value="https:\/\/gitlab\.gnome\.org\/Infrastructure\/gimp-macos-build\/-\/merge_requests\/398"/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('homepage with ?bad=... surfaces a visible error banner + pre-fills the input', async () => {
    const res = await app.fetch(
      new Request('https://released.example/?bad=garbage&reason=invalid_input'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // JSX escapes the apostrophe to &#39; — match either form.
    expect(body).toMatch(/Couldn(['&#39;]+|&apos;)t parse that/);
    expect(body).toContain('input: garbage');
    // The input field should be pre-filled with the bad value so user can edit.
    expect(body).toMatch(/<input[^>]*value="garbage"/);
    // Error pages must not be cacheable (or the next visit shows stale error UI).
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('homepage without ?bad shows no error banner', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    expect(body).not.toMatch(/Couldn(['&#39;]+|&apos;)t parse that/);
  });

  it('permalink with a non-parseable sha redirects through homepage error UI', async () => {
    const res = await app.fetch(new Request('https://released.example/r/o/r/c/not-a-sha-at-all'));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/?bad=');
    expect(loc).toContain('reason=');
  });

  it('POST /api/lookup rejects cross-origin requests', async () => {
    const res = await app.fetch(
      new Request('https://released.example/api/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ input: 'facebook/react@abc1234' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/lookup-bulk rejects > MAX_BULK with 400', async () => {
    const inputs = Array.from(
      { length: 11 },
      (_, i) => `facebook/react@abc12${i.toString().padStart(2, '0')}`,
    );
    const res = await app.fetch(
      new Request('https://released.example/api/lookup-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bulk_limit');
  });

  it('GET /internal/result/... rejects requests without the service-binding header', async () => {
    const res = await app.fetch(
      new Request('https://released.example/internal/result/facebook/react/abc1234'),
    );
    expect(res.status).toBe(404);
  });

  // Federated internal route (issue #12): the parallel host-aware endpoint that
  // feeds web-og's federated OG renderer (issue #8).
  it('GET /internal/h/:host/r/:projectPath/:sha rejects requests without the service-binding header', async () => {
    const res = await app.fetch(
      new Request('https://released.example/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/abc1234'),
    );
    expect(res.status).toBe(404);
  });

  it('GET /internal/h/:host/r/:projectPath/:sha returns the host-keyed cached result', async () => {
    cacheStore.clear();
    const sha = 'a'.repeat(40);
    const seeded = {
      input: { kind: 'commit', repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' }, sha },
      canonicalSha: sha,
      firstRelease: { tag: 'GIMP_2_10_36', sha: 't', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    };
    // Seeds the host-keyed slot the route reads (see seedFederatedResult) — proves
    // the route decodes the URL-encoded projectPath and keys the cache by host,
    // without hitting any provider.
    await seedFederatedResult(sha, seeded);
    // Real handshake: caller presents the shared INTERNAL_SECRET, and the env has
    // it set (as prod / `wrangler dev` via .dev.vars do). The value is NOT 'web-og',
    // so this can't pass via the legacy default fallback.
    const res = await app.fetch(
      new Request(`https://released.example/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/${sha}`, {
        headers: { 'x-released-internal': INTERNAL_SECRET },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof seeded;
    expect(body.firstRelease?.tag).toBe('GIMP_2_10_36');
    expect(body.input.repo.host).toBe('gitlab.gnome.org');
  });

  // Defense-in-depth (backlog "internal.ts fail-open default"): if INTERNAL_SECRET
  // were ever unset/misconfigured, isServiceBinding() must DENY rather than fall
  // back to the public 'web-og' constant — otherwise /internal/* opens to anyone
  // who guesses the default. Prod always sets the secret; this guards the misconfig.
  it('GET /internal/h/... fails CLOSED when INTERNAL_SECRET is unset (no web-og fallback)', async () => {
    cacheStore.clear();
    const sha = 'a'.repeat(40);
    await seedFederatedResult(sha, {
      input: {
        kind: 'commit',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
        sha,
      },
      firstRelease: { tag: 'GIMP_2_10_36', sha: 't', date: '2024-02-01T00:00:00Z', url: '' },
    });
    // INTERNAL_SECRET deliberately unset; caller spoofs the public default.
    const res = await app.fetch(
      new Request(`https://released.example/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/${sha}`, {
        headers: { 'x-released-internal': 'web-og' },
      }),
    );
    expect(res.status).toBe(404);
  });

  // Defense-in-depth companion to the fail-closed test above: even when
  // INTERNAL_SECRET is correctly set, a caller presenting the WRONG marker
  // value must be DENIED. The exact-match comparison (marker === secret) is
  // otherwise only exercised positively (the success test). The no-header
  // tests never reach the comparison, and the unset-secret test returns on its
  // early branch — so without this case a regression weakening the check to
  // "any non-empty marker" would leave the whole suite green.
  it('GET /internal/h/... rejects a wrong marker value when INTERNAL_SECRET is set', async () => {
    cacheStore.clear();
    const sha = 'a'.repeat(40);
    await seedFederatedResult(sha, {
      input: {
        kind: 'commit',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
        sha,
      },
      firstRelease: { tag: 'GIMP_2_10_36', sha: 't', date: '2024-02-01T00:00:00Z', url: '' },
    });
    // Secret IS set; caller sends a non-empty but WRONG marker. The cache is
    // seeded, so a fail-OPEN check would return 200 — a 404 here proves the
    // exact-match guard fired rather than a mere cache miss.
    const res = await app.fetch(
      new Request(`https://released.example/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/${sha}`, {
        headers: { 'x-released-internal': 'web-og' },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(404);
  });

  it('GET /r/:o/:r/c/:sha for an unfurl bot with no cache returns a deferred-render card with short TTL', async () => {
    cacheStore.clear();
    const res = await app.fetch(
      new Request('https://released.example/r/facebook/react/c/abc1234', {
        headers: { 'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)' },
      }),
    );
    expect(res.status).toBe(200);
    // NOT a long cache — must be short so the bot retries.
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const body = await res.text();
    expect(body).toContain('Looking up');
    // #53: even on a cold cache the deferred card advertises the DYNAMIC
    // per-commit OG image (not the generic placeholder). web-og resolves the
    // commit itself and falls back to its own placeholder if it can't.
    expect(body).toMatch(
      /<meta property="og:image" content="[^"]*\/r\/facebook\/react\/c\/abc1234\.png/,
    );
    expect(body).not.toMatch(/<meta property="og:image" content="[^"]*\/placeholder\.png/);
  });
});

// #92 follow-up: a cold-cache unfurl of an issue/PR permalink must advertise the
// DYNAMIC title-aware card (the /i/ or /p/ image web-og resolves itself), NOT the
// generic placeholder — mirroring the commit deferred guard above. Without this,
// the FIRST share of any uncomputed issue/PR unfurls blank-generic even though
// the resolved (warm) page shows the right card.
describe('issue/PR deferred (cold-share) OG image — #92 follow-up', () => {
  it('GET /i/:o/:r/:n for an unfurl bot with no cache advertises the dynamic /i/ card, not placeholder', async () => {
    cacheStore.clear();
    const res = await app.fetch(
      new Request('https://released.example/i/honojs/hono/555', {
        headers: { 'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const body = await res.text();
    expect(body).toContain('Looking up');
    expect(body).toMatch(/<meta property="og:image" content="[^"]*\/i\/honojs\/hono\/555\.png/);
    expect(body).not.toMatch(/<meta property="og:image" content="[^"]*\/placeholder\.png/);
  });

  it('GET /p/:o/:r/:n for an unfurl bot with no cache advertises the dynamic /p/ card, not placeholder', async () => {
    cacheStore.clear();
    const res = await app.fetch(
      new Request('https://released.example/p/honojs/hono/555', {
        headers: { 'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const body = await res.text();
    expect(body).toContain('Looking up');
    expect(body).toMatch(/<meta property="og:image" content="[^"]*\/p\/honojs\/hono\/555\.png/);
    expect(body).not.toMatch(/<meta property="og:image" content="[^"]*\/placeholder\.png/);
  });
});

// Issue #1: nav + footer linked to /how-it-works but no route existed. It was a
// 301 to the README; now it's a real, indexable content page (an SEO usage-loop
// entry point). Full coverage lives in seo.test.ts; this just locks in that it
// is no longer a redirect.
// #79: issue/PR internal endpoints feed web-og's title-aware OG card. They
// mirror the commit endpoints (/internal/result, /internal/h/.../r) but resolve
// an issue/PR input so the returned result carries subject = the issue/PR title
// (findReleaseForIssue / the pr path set it) and input.kind/number — which the
// OG card renders as "Issue #N" / "PR #N" + the title. Same service-binding
// guard (fail closed) and host-aware cache key as the commit endpoints.
describe('web Worker — issue/PR internal endpoints (#79)', () => {
  it('GET /internal/issue/:owner/:repo/:number rejects without the service-binding header', async () => {
    const res = await app.fetch(
      new Request('https://released.example/internal/issue/honojs/hono/11'),
    );
    expect(res.status).toBe(404);
  });

  it('GET /internal/issue/:owner/:repo/:number returns the cached issue result with subject = title', async () => {
    cacheStore.clear();
    const seeded = {
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Logger builtin middleware',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    };
    // Seed the slot the route reads. Since #143 that is the SAME key the public
    // /i/ permalink writes: cacheKey('res', `${host}/${projectPath}`,
    // `issue#${number}`, 'cull', 'nopre') — see routes/internal.ts.
    const key = await cacheKey('res', 'github.com/honojs/hono', 'issue#11', 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(JSON.stringify(seeded), { headers: { 'content-type': 'application/json' } }),
    );
    const res = await app.fetch(
      new Request('https://released.example/internal/issue/honojs/hono/11', {
        headers: { 'x-released-internal': INTERNAL_SECRET },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof seeded;
    expect(body.input.kind).toBe('issue');
    expect(body.subject).toBe('Logger builtin middleware');
    expect(body.firstRelease?.tag).toBe('v0.0.11');
  });

  it('GET /internal/pr/:owner/:repo/:number returns the cached PR result', async () => {
    cacheStore.clear();
    const seeded = {
      input: { kind: 'pr', repo: { host: 'github.com', projectPath: 'honojs/hono' }, number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    };
    const key = await cacheKey('res', 'github.com/honojs/hono', 'pr#17', 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(JSON.stringify(seeded), { headers: { 'content-type': 'application/json' } }),
    );
    const res = await app.fetch(
      new Request('https://released.example/internal/pr/honojs/hono/17', {
        headers: { 'x-released-internal': INTERNAL_SECRET },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof seeded;
    expect(body.input.kind).toBe('pr');
    expect(body.subject).toBe('Add logger builtin');
  });

  it('GET /internal/h/:host/i/:projectPath/:number returns the host-keyed cached issue result', async () => {
    cacheStore.clear();
    const seeded = {
      input: {
        kind: 'issue',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/glib' },
        number: 1234,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Fix a GLib crash',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    };
    // Proves the route keys the cache by host on the (Hono-decoded) projectPath.
    const key = await cacheKey('res', 'gitlab.gnome.org/GNOME/glib', 'issue#1234', 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(JSON.stringify(seeded), { headers: { 'content-type': 'application/json' } }),
    );
    const res = await app.fetch(
      new Request('https://released.example/internal/h/gitlab.gnome.org/i/GNOME%2Fglib/1234', {
        headers: { 'x-released-internal': INTERNAL_SECRET },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof seeded;
    expect(body.input.repo.host).toBe('gitlab.gnome.org');
    expect(body.subject).toBe('Fix a GLib crash');
  });

  // Regression: a `%25` (lone percent) in the federated projectPath. Hono
  // already percent-decodes c.req.param() (safe try/catch), so an explicit
  // decodeURIComponent here is a redundant DOUBLE-decode: `bad%25` → Hono
  // decodes to `bad%` → decodeURIComponent("bad%") throws URIError. The throw
  // is in the route-handler argument, outside resolveResult's try/catch, with
  // no app.onError → HTTP 500 on a Service-Binding route. web-og masks it to a
  // placeholder, so a `%`-bearing project path never resolves its OG card and
  // web logs a 500. The route must NOT re-decode the already-decoded param.
  it('GET /internal/h/:host/i/:projectPath/:number does not 500 on a `%25` (lone-percent) path', async () => {
    cacheStore.clear();
    const seeded = {
      input: {
        kind: 'issue',
        repo: { host: 'gitlab.gnome.org', projectPath: 'bad%' },
        number: 1,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Fix',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    };
    // Seed the slot the FIXED route keys on (Hono already decoded bad%25 → bad%).
    const key = await cacheKey('res', 'gitlab.gnome.org/bad%', 'issue#1', 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(JSON.stringify(seeded), { headers: { 'content-type': 'application/json' } }),
    );
    const res = await app.fetch(
      new Request('https://released.example/internal/h/gitlab.gnome.org/i/bad%25/1', {
        headers: { 'x-released-internal': INTERNAL_SECRET },
      }),
      { INTERNAL_SECRET },
    );
    expect(res.status).toBe(200);
  });

  it('GET /internal/issue/... fails CLOSED when INTERNAL_SECRET is unset (no web-og fallback)', async () => {
    cacheStore.clear();
    const key = await cacheKey('res', 'github.com/honojs/hono', 'issue#11', 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(
        JSON.stringify({
          input: {
            kind: 'issue',
            repo: { host: 'github.com', projectPath: 'honojs/hono' },
            number: 11,
          },
          firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    // INTERNAL_SECRET deliberately unset; caller spoofs the public default.
    const res = await app.fetch(
      new Request('https://released.example/internal/issue/honojs/hono/11', {
        headers: { 'x-released-internal': 'web-og' },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('/how-it-works is a content page (no longer a redirect)', () => {
  it('serves a 200 HTML page, not a 301', async () => {
    const res = await app.fetch(new Request('https://released.example/how-it-works'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// Issue #3: homepage advertised "Look up several at once →" linking to /bulk,
// but the /bulk UI was never built (only the API). Link removed until the page
// exists; tracked in issue #3.
describe('homepage no longer links to /bulk (issue #3)', () => {
  it('does not link to /bulk or show the "Look up several at once" CTA', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    expect(body).not.toContain('href="/bulk"');
    expect(body).not.toContain('Look up several at once');
  });
});

describe('homepage popular-projects chips removed', () => {
  it('does NOT render the popular-projects chip section or its click handler', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The chip section, its label, and the per-project buttons are gone.
    expect(body).not.toContain('projects-section');
    expect(body).not.toContain('aria-labelledby="popular-projects-label"');
    expect(body).not.toContain('class="project-chip"');
    expect(body).not.toContain('data-alias=');
    // The delegated chip-click handler is gone too.
    expect(body).not.toContain('.project-chip');
  });
});

describe('bare-SHA error banner', () => {
  it('shows the bare-SHA message with no project chips', async () => {
    const res = await app.fetch(
      new Request('https://released.example/?bad=8c0ef808ea&reason=bare_sha'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // The prompt-for-a-repo UX is kept (BareShaError is not part of the
    // popular-projects feature).
    expect(body).toContain('looks like a SHA, but I need a repo too');
    // The removed popular-projects chips do not appear in the banner.
    expect(body).not.toContain('class="error-chips"');
    expect(body).not.toContain('aria-labelledby="popular-projects-label-err"');
    expect(body).not.toContain('data-alias=');
  });
});

describe('homepage CSP', () => {
  it('emits a strict CSP with a nonce', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[0-9a-f]{32}'/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The "img-src" allows the og.{domain} worker.
    expect(csp).toMatch(/img-src .*data: https:\/\/og\./);
  });
});

// Copy UI: a paste-able link / auto-updating badge, available even before a
// release lands. The badge URL is the permalink with `/badge.svg` appended.
describe('permalink copy UI + badge embed', () => {
  it('exposes the "as Badge" copy button and the client builds a badge.svg snippet', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // The button is present (in the shared CopyActions row)…
    expect(body).toContain('data-copy="badge"');
    // …and the client copy handler builds the `…/badge.svg` markdown…
    expect(body).toContain("'/badge.svg)](' + perma + ')'");
    // …and weaves the human headline (subject) into the non-link formats.
    expect(body).toContain('r.subject');
  });

  it('released MR page: readable .pr-banner links + a live badge preview', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/601')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
              title: 'Port build to macOS arm64',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/601'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // The "Resolved …" banner now uses a class with explicit link colors.
      expect(body).toContain('class="pr-banner"');
      expect(body).toContain('.pr-banner a {'); // the readable-link CSS shipped
      // Badge button + the live copy-preview panel (populated client-side).
      expect(body).toContain('data-copy="badge"');
      expect(body).toContain('data-copy-preview');
      expect(body).toContain('copy-preview-badge');
      // The MR title flows into the inline result payload (subject), so the
      // copy formats can be self-describing.
      expect(body).toContain('Port build to macOS arm64');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('not-yet-released MR page: copy actions + auto-update hint + inline result data', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/602')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
              title: 'Add experimental cache layer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_0_0',
                commit: { id: 'tagsha', committed_date: '2024-05-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/602'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Not yet released');
      // Copy affordances work even when unreleased.
      expect(body).toContain('data-copy="badge"');
      expect(body).toContain('flips to the version automatically');
      // The client copy handler needs the result payload injected…
      expect(body).toContain('window.__RELEASED_RESULT__ =');
      // …and the MR title rides along (via NotYetReleasedError.subject).
      expect(body).toContain('Add experimental cache layer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Hint placement: the "broaden the search" hint (strict / prereleases) is a
// next-step, so it renders BELOW the "Not yet released" answer, not above it.
describe('not-yet hint placement', () => {
  it('renders the StrictHint AFTER the "Not yet released" card', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/603')) {
          return new Response(
            JSON.stringify({ state: 'merged', sha: 'ffheadsha1234567890abcdef1234567890abcdef' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          // A 2020 tag, >90 days before the 2024 commit → culled by the date
          // margin → NotYetReleasedError carries culledTagCount > 0 → StrictHint.
          return new Response(
            JSON.stringify([
              { name: 'OLD_1_0', commit: { id: 'oldsha', committed_date: '2020-01-01T00:00:00Z' } },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/603'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      const answerAt = body.indexOf('Not yet released');
      const hintAt = body.indexOf('skipped by the 90-day date cull');
      expect(answerAt).toBeGreaterThan(-1);
      expect(hintAt).toBeGreaterThan(-1);
      // The answer must come before the hint in document order.
      expect(answerAt).toBeLessThan(hintAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Status badges: an auto-updating SVG embeddable in MR/PR markdown. Shares the
// permalink's lookup + cache; released answers cache long, everything else short
// so the badge flips once a release lands.
describe('status badge — /…/badge.svg', () => {
  it('renders an SVG with the version tag + green color, long cache, when released', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/501')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/501/badge.svg'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('<svg');
      expect(body).toContain('GIMP_3_2_0');
      expect(body).toContain('#3fb950'); // --ship green
      // Released is terminal → long cache.
      expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders a "not yet" gold badge with short cache when merged but unreleased', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/502')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          // No tag contains the merge commit → "not yet released".
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_0_0',
                commit: { id: 'tagsha', committed_date: '2024-05-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/502/badge.svg'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('not yet');
      expect(body).toContain('#d29922'); // --warn gold
      // Non-terminal → short cache so the proxy re-fetches and the badge flips.
      expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders an "unknown" badge (no network) for a malformed SHA', async () => {
    const res = await app.fetch(
      new Request('https://released.example/r/facebook/react/c/not-a-sha/badge.svg'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('unknown');
    expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
  });

  it('renders "checking…" (NOT "unknown") when upstream is down and nothing is cached', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('upstream down', { status: 503 }),
    ) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951/badge.svg'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // A transient outage must not look like a permanent failure.
      expect(body).toContain('checking');
      expect(body).not.toContain('unknown');
      // Short cache so the proxy re-fetches and the badge recovers.
      expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// The recovery UX: a down upstream with no cached answer must NOT dead-end the
// user on a 404 whose only action throws away their lookup.
describe('upstream-down recovery UX (the bug)', () => {
  it('MR permalink during an outage shows a "Try again" card that reloads the SAME permalink', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('upstream down', { status: 503 }),
    ) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9952'),
      );
      const body = await res.text();
      expect(res.status).toBe(503);
      // Names the host and offers retry…
      expect(body).toContain('gitlab.gnome.org');
      expect(body).toMatch(/Try again/i);
      // …on the SAME permalink (so the lookup isn't lost).
      expect(body).toContain('/h/gitlab.gnome.org/p/GNOME%2Fgtk/9952');
      // Short cache so a refresh after recovery actually re-checks.
      expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records the UPSTREAM status in analytics (double3) so an outage is diagnosable, not just visible', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    // Upstream returns 502; the worker renders its own 503 "try again" page. The
    // worker→client status (502 vs 503) hides what the host actually did — double3
    // is the only place the real upstream status survives.
    globalThis.fetch = vi.fn(
      async () => new Response('bad gateway', { status: 502 }),
    ) as typeof fetch;
    const points: { blobs?: string[]; doubles?: number[] }[] = [];
    const env = {
      ANALYTICS: { writeDataPoint: (dp: (typeof points)[number]) => points.push(dp) },
    } as unknown as Parameters<typeof app.fetch>[1];
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9954'),
        env,
      );
      expect(res.status).toBe(503); // transient outage page
      expect(points).toHaveLength(1);
      const dp = points[0];
      expect(dp?.blobs?.[1]).toBe('gitlab.gnome.org'); // host
      expect(dp?.blobs?.[3]).toBe('error'); // outcome
      expect(dp?.doubles?.[0]).toBe(503); // worker→client status
      expect(dp?.doubles?.[2]).toBe(502); // UPSTREAM status — the diagnostic signal
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a genuine error page offers BOTH "Try again" and "Start over"', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org')) {
        // 404 on the MR → PrNotFoundError → a real (permanent) error page.
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9953'),
      );
      const body = await res.text();
      expect(res.status).toBe(404);
      expect(body).toMatch(/Try again/i);
      expect(body).toContain('Start over');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /lookup recognizes our own pasted permalink fragment and redirects to it', async () => {
    // The exact thing the user did: copy the tail of the URL into the box.
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('gitlab.gnome.org/p/GNOME%2Fgtk/9951'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951');
  });

  it('GET /lookup recognizes a full pasted permalink URL and redirects to it', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951');
  });
});

// The pagination fix, end to end: a maintenance-branch MR whose containing tag is
// NOT in the (capped) /repository/tags page, but IS resolvable via the single-tag
// endpoint. The rendered page must report that tag as the first release.
describe('containing tag outside the fetched window (pagination fix)', () => {
  it('resolves a containing tag via /repository/tags/<name> and shows it as first release', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/9876')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
              title: 'macos: backport fix',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // Containing-tags shortcut: the commit is in an OLD maintenance tag only.
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'GTK_3_24_OLD' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // Single-tag endpoint (must be checked before the list endpoint): the
        // out-of-window maintenance tag, dated AFTER the commit so it isn't culled.
        if (url.includes('/repository/tags/GTK_3_24_OLD')) {
          return new Response(
            JSON.stringify({
              name: 'GTK_3_24_OLD',
              commit: { id: 'oldsha', committed_date: '2024-02-01T00:00:00Z' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // Tag LIST (the capped window) — does NOT include GTK_3_24_OLD.
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GTK_4_16_0',
                commit: { id: 'newsha', committed_date: '2024-09-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgtk/9876'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // The out-of-window maintenance tag is reported as the first release…
      expect(body).toContain('GTK_3_24_OLD');
      // …and the page is NOT the "not yet released" state.
      expect(body).not.toContain('Not yet in a release');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  // ---- Anubis-protected host UX --------------------------------------------
  // gitlab.freedesktop.org sits behind Anubis (techaro.lol): the API returns
  // 200 + HTML interstitial. The generic "Can't reach … Try again" UI is wrong
  // here — retrying never beats Anubis from workerd. The route must surface a
  // CLI hint with the exact command to copy.
  it('Anubis interstitial → page shows the CLI hint, no "Try again" button', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.freedesktop.org')) {
        return new Response(
          '<!doctype html><html lang="en"><head><title>Making sure you\'re not a bot!</title><link rel="stylesheet" href="/.within.website/x/xess/xess.min.css"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request(
          'https://released.example/h/gitlab.freedesktop.org/r/mesa%2Fmesa/c/6a16319133d3',
        ),
      );
      const body = await res.text();
      // Anubis-specific phrasing replaces the generic "Can't reach" headline.
      expect(body).toContain('Anubis');
      // The CLI command — exactly what users should run, with the upstream URL.
      expect(body).toContain('npx git-released');
      expect(body).toContain('gitlab.freedesktop.org/mesa/mesa/-/commit/6a16319133d3');
      // No "Try again" button — retrying never works against Anubis.
      expect(body).not.toContain('Try again');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ---- Unmerged-PR badge UX -------------------------------------------------
  // An unmerged PR is the moment when an embeddable badge is most useful:
  // paste it in the PR description, it auto-flips through "not yet" → the
  // version tag as the PR merges and ships. The page must surface the badge
  // copy actions, and the badge endpoint must say "not yet" (gold) rather
  // than the generic "unknown" — otherwise the proxy locks a dead UI in.
  // The slack format is plain text — Slack mrkdwn doesn't re-fetch. If we bake
  // "not yet released" into the copied message it stale-locks forever once the
  // commit eventually ships. The fix: the not-yet branch points to the
  // permalink with a "live release status" label and never asserts a state.
  it('slack copy snippet for not-yet results does NOT bake in transient state', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // The inlined CLIENT_JS is the source of truth for copy formats; we assert
    // against the script string directly so the regression bites at build time
    // rather than after a paste in production.
    expect(body).not.toContain("'not yet released'");
    expect(body).not.toContain('not yet released <');
    // New phrasing: link label promises the user can click for current state.
    expect(body).toContain('live release status');
  });

  it('open unmerged PR page surfaces the badge copy actions + inline result', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/repos/BerriA/litellm/pulls/29205')) {
        return new Response(
          JSON.stringify({
            merged: false,
            state: 'open',
            merge_commit_sha: null,
            title: 'feat: something',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(new Request('https://released.example/p/BerriA/litellm/29205'));
      expect(res.status).toBe(200);
      const body = await res.text();
      // The "Copy & embed badge" disclosure with the three format buttons.
      expect(body).toContain('Copy &amp; embed badge');
      expect(body).toContain('data-copy="badge"');
      expect(body).toContain('data-copy="slack"');
      expect(body).toContain('data-copy="link"');
      // The synthetic LookupResult must be inlined so the client JS picks
      // it up (window.__RELEASED_RESULT__). canonicalSha is "" because the
      // PR isn't merged — there is no merge commit yet.
      expect(body).toContain('window.__RELEASED_RESULT__');
      expect(body).toMatch(/"kind":"pr"/);
      expect(body).toMatch(/"number":29205/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('closed-without-merging PR page does NOT show badge actions (will never flip)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/repos/foo/bar/pulls/99')) {
        return new Response(
          JSON.stringify({ merged: false, state: 'closed', merge_commit_sha: null, title: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(new Request('https://released.example/p/foo/bar/99'));
      expect(res.status).toBe(200);
      const body = await res.text();
      // No flip will ever happen — don't dangle a useless badge.
      expect(body).not.toContain('Copy &amp; embed badge');
      expect(body).not.toContain('data-copy="badge"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('badge.svg for an open unmerged PR returns "not yet" gold (short-cached, auto-flips)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/repos/foo/bar/pulls/42')) {
        return new Response(
          JSON.stringify({ merged: false, state: 'open', merge_commit_sha: null, title: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(new Request('https://released.example/p/foo/bar/42/badge.svg'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('not yet');
      // --warn gold (BADGE_COLORS.notYet)
      expect(body).toContain('#d29922');
      // Short cache so a merge+ship triggers re-fetch within minutes.
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc).toContain('max-age=300');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('badge.svg for a closed (never-merged) PR stays "unknown" (no false promises)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/repos/foo/bar/pulls/77')) {
        return new Response(
          JSON.stringify({ merged: false, state: 'closed', merge_commit_sha: null, title: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(new Request('https://released.example/p/foo/bar/77/badge.svg'));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('unknown');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Cold-load UX: a cache-miss commit permalink must not blank-wait. It streams a
// "Looking up…" shell first, then swaps in the fully-rendered page. (Warm/
// terminal cache hits still render synchronously — covered by other tests.)
describe('cold lookup streams a shell then swaps in the page', () => {
  it('streams the Looking-up shell then appends the resolved page (progressive)', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    // Upstream down → resolves to the transient page; deterministic, no success
    // mock needed. The point under test is the STREAMING wrapper, not the answer.
    globalThis.fetch = vi.fn(
      async () => new Response('upstream down', { status: 503 }),
    ) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/r/GNOME%2Fgtk/c/6a16319133d3'),
      );
      // Streamed responses commit 200 before the outcome is known.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      // (1) the instant shell is sent first
      expect(body).toContain('data-lookup-shell');
      expect(body).toContain('Looking up');
      // (2) progressive append: a style hides the shell, no document.write
      expect(body).toContain('[data-lookup-shell]{display:none}');
      expect(body).not.toContain('document.write');
      // (3) the resolved (transient) page is appended into the same document
      expect(body).toContain('gitlab.gnome.org');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('referer attribution (blob11)', () => {
  it('records the referring host on a request so traffic is attributable', async () => {
    const points: { blobs?: string[] }[] = [];
    const env = {
      ANALYTICS: { writeDataPoint: (dp: (typeof points)[number]) => points.push(dp) },
    } as unknown as Parameters<typeof app.fetch>[1];
    const res = await app.fetch(
      new Request('https://released.example/', {
        headers: { referer: 'https://news.ycombinator.com/item?id=1' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    // blob11 (index 10) is the referring host — hostname only, no path/query.
    expect(points[0]?.blobs?.[10]).toBe('news.ycombinator.com');
  });
});

// Bulk route (CUJ 7). The route's OWN logic — same-origin guard, body
// validation, parse-error threading at the original index, and the by-host
// grouping + original-order re-threading that is the whole reason the file
// exists — was previously untested at the HTTP level (only the >MAX_BULK
// reject path was). These cover it.
describe('POST /api/lookup-bulk — route logic', () => {
  it('rejects cross-origin requests with 403', async () => {
    const res = await app.fetch(
      new Request('https://released.example/api/lookup-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ inputs: ['facebook/react@abc1234'] }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cross_origin');
  });

  it('rejects an unparseable JSON body with 400 invalid_body', async () => {
    const res = await app.fetch(
      new Request('https://released.example/api/lookup-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'this is not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('rejects a non-array inputs field with 400 missing_inputs', async () => {
    const res = await app.fetch(
      new Request('https://released.example/api/lookup-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: 'facebook/react@abc1234' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_inputs');
  });

  it('returns 200 with a per-input error for every unparseable input (order + length preserved)', async () => {
    // No input parses → no provider call. The route must still answer 200 with a
    // structured per-input error at each index, NOT a top-level 4xx.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const inputs = ['not a ref !!!', '@@@bogus', 'http://'];
      const res = await app.fetch(
        new Request('https://released.example/api/lookup-bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputs }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { kind?: string }[] };
      expect(body.results).toHaveLength(inputs.length);
      for (const r of body.results) expect(r.kind).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('groups inputs by host, runs each host, and re-threads results into original input order', async () => {
    // Two DIFFERENT GitLab hosts plus a parse failure in the middle. The route
    // splits the two valid inputs into separate per-host provider groups, runs
    // them, and must re-thread each answer back to its ORIGINAL index — with the
    // parse failure landing at index 1. This is the route's signature behavior
    // (mixed-provider bulk, issue #10 territory) and was uncovered.
    const glSha = 'a'.repeat(40);
    const gnomeSha = 'b'.repeat(40);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/v4/')) {
        const isGnome = url.includes('gitlab.gnome.org');
        const tag = isGnome ? 'GNOME_1_0' : 'gl-v1.0.0';
        const tagSha = isGnome ? 'gnometagsha' : 'gltagsha';
        const fullSha = isGnome ? gnomeSha : glSha;
        // /refs?type=tag is a subpath of /repository/commits/:sha — match it FIRST.
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: tag }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/')) {
          return new Response(
            JSON.stringify({ id: fullSha, committed_date: '2024-01-01T00:00:00Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          // Tag dated after the commit so the date cull keeps it as a candidate.
          return new Response(
            JSON.stringify([
              { name: tag, commit: { id: tagSha, committed_date: '2024-02-01T00:00:00Z' } },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          // No Release object — firstRelease still comes from the containing tag.
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const inputs = [
        `https://gitlab.com/acme/widget/-/commit/${glSha}`,
        'not a valid ref !!!',
        `https://gitlab.gnome.org/gnome/gtk/-/commit/${gnomeSha}`,
      ];
      const res = await app.fetch(
        new Request('https://released.example/api/lookup-bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputs }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: {
          kind?: string;
          firstRelease?: { tag: string } | null;
          input?: { repo: { host: string } };
        }[];
      };
      expect(body.results).toHaveLength(3);
      // Index 0 — gitlab.com result threaded back to its original slot.
      expect(body.results[0]?.kind).not.toBe('error');
      expect(body.results[0]?.input?.repo.host).toBe('gitlab.com');
      expect(body.results[0]?.firstRelease?.tag).toBe('gl-v1.0.0');
      // Index 1 — the parse failure stays at its original index.
      expect(body.results[1]?.kind).toBe('error');
      // Index 2 — gitlab.gnome.org result, NOT swapped with index 0.
      expect(body.results[2]?.kind).not.toBe('error');
      expect(body.results[2]?.input?.repo.host).toBe('gitlab.gnome.org');
      expect(body.results[2]?.firstRelease?.tag).toBe('GNOME_1_0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces a partial from ONE host group while keeping the other host’s answer (issue #10)', async () => {
    // Multi-host bulk runs an independent findReleasesBulk per host group, so a
    // partial (rate-limit / deadline) can come from any group. Pre-fix the route
    // dropped each group's `partial` entirely — a rate-limited GitLab host would
    // silently look like a clean "not released" result. The route must surface
    // the partial AND still return the other host's real answer.
    const okSha = 'c'.repeat(40);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // gitlab.gnome.org is rate-limited: 429 with remaining=0 → RateLimitError
      // → findReleasesBulk returns partial.reason = 'rate_limit_exhausted'.
      if (url.includes('gitlab.gnome.org')) {
        return new Response(JSON.stringify({ message: 'rate limited' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'ratelimit-remaining': '0',
            'ratelimit-limit': '60',
            'ratelimit-reset': '1700000000',
          },
        });
      }
      // gitlab.com resolves cleanly via the containing-tag shortcut.
      if (url.includes('gitlab.com') && url.includes('/api/v4/')) {
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'gl-v2.0.0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/')) {
          return new Response(
            JSON.stringify({ id: okSha, committed_date: '2024-01-01T00:00:00Z' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'gl-v2.0.0',
                commit: { id: 'gltag2', committed_date: '2024-02-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const inputs = [
        `https://gitlab.com/acme/widget/-/commit/${okSha}`,
        `https://gitlab.gnome.org/gnome/gtk/-/commit/${'d'.repeat(40)}`,
      ];
      const res = await app.fetch(
        new Request('https://released.example/api/lookup-bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputs }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { kind?: string; firstRelease?: { tag: string } | null }[];
        partial?: { reason: string; pendingCount: number; resetAt?: number };
      };
      // The clean host's answer survives the other host's rate-limit.
      expect(body.results[0]?.kind).not.toBe('error');
      expect(body.results[0]?.firstRelease?.tag).toBe('gl-v2.0.0');
      // The partial is now reported at the top level, not silently dropped.
      expect(body.partial?.reason).toBe('rate_limit_exhausted');
      expect(body.partial?.resetAt).toBe(1700000000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('web Worker — issue permalink route (#54)', () => {
  // The GitHub issue resolver is ONE GraphQL POST; mock it so no real network.
  function mockIssueGraphql(issue: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/graphql')) {
        return new Response(JSON.stringify({ data: { repository: { issue } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it('GET /i/:owner/:repo/:number renders the calm "still open" card for an open issue', async () => {
    const restore = mockIssueGraphql({
      title: 'Crash on startup',
      state: 'OPEN',
      stateReason: null,
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    });
    try {
      const res = await app.fetch(new Request('https://released.example/i/honojs/hono/1234'));
      const body = await res.text();
      // An open issue is a real, calm answer — not an error.
      expect(res.status).toBe(200);
      expect(body).toContain('Still open');
      // Links back to the issue on the provider, not a PR.
      expect(body).toContain('github.com/honojs/hono/issues/1234');
      // Short-cached so it flips once the issue is closed + fixed.
      expect(res.headers.get('cache-control')).toContain('max-age=300');
      // Security headers still fire.
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    } finally {
      restore();
    }
  });

  it('GET /i/:owner/:repo/:number renders "Closed (not planned)" for a won\'t-fix issue', async () => {
    const restore = mockIssueGraphql({
      title: 'Please add Windows 7 support',
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    });
    try {
      const res = await app.fetch(new Request('https://released.example/i/honojs/hono/42'));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('Closed (not planned)');
      expect(res.headers.get('cache-control')).toContain('max-age=300');
    } finally {
      restore();
    }
  });

  it('GET /i/:owner/:repo/:number renders "Closed without a fix" when no closer is linked', async () => {
    const restore = mockIssueGraphql({
      title: 'Flaky test sometimes',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    });
    try {
      const res = await app.fetch(new Request('https://released.example/i/cli/cli/7'));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('Closed without a fix');
    } finally {
      restore();
    }
  });

  it('GET /i/:owner/:repo/:number 302s a non-numeric issue number back to the form', async () => {
    const res = await app.fetch(new Request('https://released.example/i/honojs/hono/not-a-number'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('reason=invalid_input');
  });
});

// Issue status badge + share/OG re-enable (#54 PR2b). PR2 shipped the issue
// permalink but deferred its badge route + the in-page share actions; without a
// `/i/.../badge.svg` route the embedded badge would 404. These lock in the
// follow-up: the issue badge endpoint, and the resolved/not-yet issue pages now
// surfacing the same share + per-commit OG card the PR pages do.
describe('issue status badge — /i/.../badge.svg (#54 PR2b)', () => {
  // The GitHub issue resolver is ONE GraphQL POST; mock it so no real network.
  function mockIssueGraphql(issue: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/graphql')) {
        return new Response(JSON.stringify({ data: { repository: { issue } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it('badge.svg for a still-open issue returns "not yet" gold (short-cached, auto-flips)', async () => {
    cacheStore.clear();
    const restore = mockIssueGraphql({
      title: 'Crash on startup',
      state: 'OPEN',
      stateReason: null,
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    });
    try {
      const res = await app.fetch(
        new Request('https://released.example/i/honojs/hono/1234/badge.svg'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('not yet');
      expect(body).toContain('#d29922'); // --warn gold (BADGE_COLORS.notYet)
      // Short cache so a later fix+ship triggers re-fetch + flip.
      expect(res.headers.get('cache-control') ?? '').toContain('max-age=300');
    } finally {
      restore();
    }
  });

  it('badge.svg for a closed-without-fix issue stays "unknown" (will never flip)', async () => {
    cacheStore.clear();
    const restore = mockIssueGraphql({
      title: 'Flaky test sometimes',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    });
    try {
      const res = await app.fetch(new Request('https://released.example/i/cli/cli/7/badge.svg'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('unknown');
      expect(res.headers.get('cache-control') ?? '').toContain('max-age=300');
    } finally {
      restore();
    }
  });

  it('badge.svg for a non-numeric issue number returns "unknown" without hitting upstream', async () => {
    const res = await app.fetch(
      new Request('https://released.example/i/honojs/hono/not-a-number/badge.svg'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('unknown');
  });

  it('federated badge.svg route is registered for issues (GitLab open issue → "not yet")', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects') && url.includes('/issues/9876')) {
        return new Response(JSON.stringify({ state: 'opened', title: 'Still broken' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/i/GNOME%2Fgimp/9876/badge.svg'),
      );
      // A registered route resolves to an SVG; an unregistered one would 404.
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(await res.text()).toContain('not yet');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resolved issue page surfaces share + per-commit OG card (#54 PR2b)', () => {
  // A fully-resolved GitHub issue: the closing PR's merge commit IS a tagged
  // commit, so the release algorithm needs exactly one `compare` (identical).
  const FIX_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  function json(obj: unknown): Response {
    return new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  function mockResolvedIssue() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reqBody = typeof init?.body === 'string' ? init.body : '';
      if (url.includes('api.github.com/graphql')) {
        // Two distinct GraphQL queries hit the same endpoint; branch on the body.
        if (reqBody.includes('closedByPullRequestsReferences')) {
          return json({
            data: {
              repository: {
                issue: {
                  title: 'Memory leak under load',
                  state: 'CLOSED',
                  stateReason: 'COMPLETED',
                  timelineItems: { nodes: [] },
                  closedByPullRequestsReferences: {
                    nodes: [{ merged: true, mergeCommit: { oid: FIX_SHA } }],
                  },
                },
              },
            },
          });
        }
        // Tags query.
        return json({
          data: {
            repository: {
              refs: {
                nodes: [
                  {
                    name: 'v1.0.0',
                    target: {
                      __typename: 'Commit',
                      oid: FIX_SHA,
                      committedDate: '2024-01-02T00:00:00Z',
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (url.includes(`/commits/${FIX_SHA}`)) {
        return json({
          sha: FIX_SHA,
          commit: { committer: { date: '2024-01-01T00:00:00Z' }, message: 'fix: plug the leak' },
        });
      }
      if (url.includes('/compare/')) {
        return json({ status: 'identical' });
      }
      if (url.includes('/releases/tags/')) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it('GET /i/:o/:r/:n for a released issue shows the badge/share actions + a title-aware OG image', async () => {
    cacheStore.clear();
    const restore = mockResolvedIssue();
    try {
      const res = await app.fetch(new Request('https://released.example/i/honojs/hono/555'));
      expect(res.status).toBe(200);
      const body = await res.text();
      // Released card.
      expect(body).toContain('First released in');
      expect(body).toContain('v1.0.0');
      // Share actions are now enabled (the deferred `hideShare` is gone).
      expect(body).toContain('Copy &amp; embed badge');
      expect(body).toContain('data-copy="badge"');
      // OG image is the title-aware issue card (#79), keyed by the issue
      // number — not the per-commit /r/.../c/:sha card and not the placeholder.
      expect(body).toMatch(/<meta property="og:image" content="[^"]*\/i\/honojs\/hono\/555\.png/);
      expect(body).not.toMatch(/<meta property="og:image" content="[^"]*\/r\/honojs\/hono\/c\//);
      expect(body).not.toMatch(/<meta property="og:image" content="[^"]*\/placeholder\.png/);
    } finally {
      restore();
    }
  });
});

// Regression: a `%25` (lone percent) in the federated projectPath on the PUBLIC
// permalink + badge routes. Hono already percent-decodes c.req.param() (safe
// try/catch — verified by repro against installed Hono 4.12.27: `bad%25` arrives
// as `bad%`), so an explicit decodeURIComponent in repoFromParams is a redundant
// DOUBLE-decode: decodeURIComponent("bad%") throws URIError. The throw is inside
// repoFromParams, which each route calls with no try/catch, and there is no
// app.onError → HTTP 500 on a public surface. repoFromParams must NOT re-decode
// the already-decoded param.
//
// The decode is host-agnostic, so these use gitlab.com (NOT an Anubis host):
// Anubis hosts route provider fetches through the GitlabRelay Durable Object,
// whose binding is absent in unit tests, so makeProvider would 500 before the
// cache check — unrelated noise. gitlab.com constructs without the relay.
describe('public federated routes — malformed `%` projectPath must not 500', () => {
  // Seed the cache slot the FIXED route keys on (Hono already decoded bad%25 →
  // bad%), so the route short-circuits to the cached answer instead of fetching.
  async function seedBadPercent(slot: string, input: object) {
    cacheStore.clear();
    const key = await cacheKey('res', 'gitlab.com/bad%', slot, 'cull', 'nopre');
    cacheStore.set(
      `https://released.example/__cache__/${encodeURIComponent(key)}`,
      new Response(
        JSON.stringify({
          input,
          canonicalSha: 'a'.repeat(40),
          firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
          urls: { repo: 'r', commit: 'c' },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  }

  it('GET /h/:host/r/:projectPath/c/:sha (commit permalink) — `bad%25` does not 500', async () => {
    await seedBadPercent('sha:abc1234', {
      kind: 'commit',
      repo: { host: 'gitlab.com', projectPath: 'bad%' },
      sha: 'abc1234',
    });
    const res = await app.fetch(
      new Request('https://released.example/h/gitlab.com/r/bad%25/c/abc1234'),
    );
    expect(res.status).toBe(200);
  });

  it('GET /h/:host/r/:projectPath/c/:sha/badge.svg (commit badge) — `bad%25` does not 500', async () => {
    await seedBadPercent('sha:abc1234', {
      kind: 'commit',
      repo: { host: 'gitlab.com', projectPath: 'bad%' },
      sha: 'abc1234',
    });
    const res = await app.fetch(
      new Request('https://released.example/h/gitlab.com/r/bad%25/c/abc1234/badge.svg'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<svg');
  });

  it('GET /h/:host/i/:projectPath/:number (issue permalink) — `bad%25` does not 500', async () => {
    await seedBadPercent('issue#1', {
      kind: 'issue',
      repo: { host: 'gitlab.com', projectPath: 'bad%' },
      number: 1,
    });
    const res = await app.fetch(new Request('https://released.example/h/gitlab.com/i/bad%25/1'));
    expect(res.status).toBe(200);
  });

  it('GET /h/:host/p/:projectPath/:number (PR/MR permalink) — `bad%25` does not 500', async () => {
    await seedBadPercent('pr#1', {
      kind: 'pr',
      repo: { host: 'gitlab.com', projectPath: 'bad%' },
      number: 1,
    });
    const res = await app.fetch(new Request('https://released.example/h/gitlab.com/p/bad%25/1'));
    expect(res.status).toBe(200);
  });
});

afterEachClear();
function afterEachClear() {
  // No-op helper since vitest's beforeEach/afterEach are picked up at top-level;
  // we explicitly clear cacheStore in tests that need it.
  vi.spyOn; // satisfy import
}
