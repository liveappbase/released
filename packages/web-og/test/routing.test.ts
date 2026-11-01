// Routing tests for web-og. We mock `workers-og`'s ImageResponse — the actual
// PNG rendering depends on WASM and the Workers runtime, which we verify with
// `wrangler dev` rather than in vitest.

import { OG_TEMPLATE_VERSION } from '@released/core';
import { describe, expect, it, vi } from 'vitest';

// The last satori node tree handed to ImageResponse. The real PNG render is
// WASM-bound and verified via `wrangler dev`, not here — but the node tree the
// card builds from a LookupResult is pure logic, so we capture and assert on it.
let lastRenderedNode: unknown;

vi.mock('workers-og', () => ({
  // Mock ImageResponse as a Response subclass — cleaner than `return new
  // Response(...)` from a constructor (which trips lint/correctness/
  // noConstructorReturn and relies on the JS oddity where a constructor's
  // returned object overrides `this`).
  ImageResponse: class extends Response {
    constructor(node: unknown, init?: { headers?: Record<string, string> }) {
      lastRenderedNode = node;
      // Mirror workers-og's real header construction, including its own
      // capitalized 'Cache-Control' default and the case-SENSITIVE spread of
      // the caller's `headers` after it. The old mock passed `init.headers`
      // straight through, which made every cache-control assertion below
      // unfalsifiable: prod merged the library's 1-year immutable default in
      // front of ours, while these tests read back exactly what the caller
      // passed and stayed green.
      super('PNG-BYTES', {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, immutable, no-transform, max-age=31536000',
          ...(init?.headers ?? {}),
        },
      });
    }
  },
}));

const { default: app } = await import('../src/index.js');

// Walk a hono/jsx node tree ({ tag, props: { children }, ... }) and collect
// every string/number leaf. Lets us assert what TEXT a card renders without a
// real WASM render. Prefer props.children (the canonical path) over the
// mirrored top-level `children` so leaves aren't double-counted.
function collectText(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') {
      if (n.length > 0) out.push(n);
      return;
    }
    if (typeof n === 'number') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === 'object') {
      const o = n as { props?: { children?: unknown }; children?: unknown };
      if (o.props && 'children' in o.props) walk(o.props.children);
      else if ('children' in o) walk(o.children);
    }
  };
  walk(node);
  return out;
}

// Satori (the renderer inside workers-og) throws — and the streamed PNG comes
// back as a 0-byte body AFTER a 200 + image/png header is already flushed — if
// any element has more than one child node without `display: flex` (or `none`).
// That exact footgun shipped the entire dynamic OG card as a blank image in
// production: `<div>commit {sha}</div>` is two children (the literal "commit "
// and the {sha} expression). It's invisible to a status/content-type check, and
// the real WASM render isn't exercised in vitest — so we encode satori's rule as
// a structural assertion over the captured node tree, which IS pure logic. Walk
// every element; one with >1 non-empty child must declare a flex/none display.
// Returns the offending element tags (empty = valid).
function satoriDisplayViolations(node: unknown): string[] {
  const bad: string[] = [];
  const childCount = (children: unknown): number => {
    const arr = Array.isArray(children) ? children : [children];
    let n = 0;
    for (const c of arr) {
      if (c == null || typeof c === 'boolean') continue;
      if (typeof c === 'string') {
        if (c.length > 0) n++;
      } else n++; // number or element
    }
    return n;
  };
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number')
      return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === 'object') {
      const o = n as {
        tag?: unknown;
        props?: { style?: Record<string, unknown>; children?: unknown };
        children?: unknown;
      };
      const children = o.props && 'children' in o.props ? o.props.children : o.children;
      if (typeof o.tag === 'string') {
        const display = o.props?.style?.display;
        if (childCount(children) > 1 && display !== 'flex' && display !== 'none') {
          bad.push(`<${o.tag}> (display=${JSON.stringify(display ?? null)})`);
        }
      }
      walk(children);
    }
  };
  walk(node);
  return bad;
}

function makeEnv(svcRes?: Response): { WEB: { fetch: typeof fetch } } {
  return {
    WEB: {
      fetch: vi.fn(async () => svcRes ?? new Response('not in cache', { status: 404 })),
    } as unknown as { fetch: typeof fetch },
  };
}

describe('web-og routing', () => {
  it('healthz works', async () => {
    const res = await app.fetch(new Request('https://og.example/healthz'), makeEnv());
    expect(res.status).toBe(200);
  });

  it('rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(new Request('https://og.example/r/o/r/c/abc1234.svg'), makeEnv());
    expect(res.status).toBe(404);
  });

  it('calls the WEB service binding with the internal secret header', async () => {
    const env = makeEnv(
      new Response(
        JSON.stringify({
          input: {
            kind: 'commit',
            repo: { owner: 'facebook', repo: 'react' },
            sha: 'a'.repeat(40),
          },
          canonicalSha: 'a'.repeat(40),
          firstRelease: { tag: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
        }),
      ),
    );
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    // The service binding was called.
    expect(env.WEB.fetch).toHaveBeenCalled();
    // The cache-control should be the LONG one because we got a real result.
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=86400, s-maxage=86400',
    );
  });

  it('returns a placeholder PNG with SHORT cache when the service binding misses', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // Federated OG (issue #8): the /h/:host/r/:projectPath path renders unfurls for
  // GitLab results, mirroring the federated permalink scheme in web/src/index.ts.
  it('federated: calls the host-aware internal endpoint with the encoded projectPath', async () => {
    const sha40 = 'a'.repeat(40);
    const env = makeEnv(
      new Response(
        JSON.stringify({
          input: {
            kind: 'commit',
            repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
            sha: sha40,
          },
          canonicalSha: sha40,
          firstRelease: { tag: 'GIMP_2_10_36', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
        }),
      ),
    );
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/r/GNOME%2Fgimp/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const calledUrl = String(calls[0]?.[0]);
    expect(calledUrl).toBe('https://web/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/a1b2c3d');
    // Real result → long cache.
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=86400, s-maxage=86400',
    );
  });

  it('federated: rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.com/r/g%2Fp/c/abc1234.svg'),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('federated: placeholder with SHORT cache when the binding misses', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.com/r/g%2Fp/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // The deploy-window version gate is NOT specific to /placeholder.png: `web`
  // links EVERY card as `<url>.png?v=${OG_TEMPLATE_VERSION}` (og-meta.tsx), and
  // release.yml deploys `web` before `web-og`, so during the window this build
  // is asked for `?v=og.vNEXT` on the dynamic routes too — the ones whose
  // content actually differs per commit/issue/PR. Long-caching a version-busted
  // URL rendered from the OLD template pins a stale card for 24h with no second
  // URL left to bust, so a version this build cannot render forces SHORT_CACHE.
  const VERSIONED_CARD_ROUTES = [
    ['github commit', '/r/facebook/react/c/a1b2c3d.png'],
    ['federated commit', '/h/gitlab.gnome.org/r/GNOME%2Fgimp/c/a1b2c3d.png'],
    ['github issue', '/i/facebook/react/11.png'],
    ['github PR', '/p/facebook/react/4834.png'],
    ['federated issue', '/h/gitlab.com/i/gitlab-org%2Fgitlab-runner/39607.png'],
    ['federated PR', '/h/gitlab.com/p/gitlab-org%2Fgitlab-runner/6867.png'],
  ] as const;

  // A real (non-null) result, so the route takes the LONG cache branch — the
  // only branch the version gate can change.
  function realResultEnv(): ReturnType<typeof makeEnv> {
    const sha40 = 'a'.repeat(40);
    return makeEnv(
      new Response(
        JSON.stringify({
          input: { kind: 'commit', repo: { owner: 'facebook', repo: 'react' }, sha: sha40 },
          canonicalSha: sha40,
          firstRelease: { tag: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
        }),
      ),
    );
  }

  for (const [label, path] of VERSIONED_CARD_ROUTES) {
    it(`${label}: a version this build cannot render falls back to the SHORT cache`, async () => {
      const res = await app.fetch(
        new Request(`https://og.example${path}?v=og.vNEXT`),
        realResultEnv(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
    });

    it(`${label}: the CURRENT template version still gets the LONG cache`, async () => {
      const res = await app.fetch(
        new Request(`https://og.example${path}?v=${OG_TEMPLATE_VERSION}`),
        realResultEnv(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(
        'public, no-transform, max-age=86400, s-maxage=86400',
      );
    });
  }

  // No `v` at all is not a URL `web` emits, but it is also not evidence of a
  // template mismatch (a hand-typed or pre-#55 crawler URL) — it keeps the
  // result-based default rather than being punished into the short cache.
  it('dynamic card: an unversioned request keeps the LONG cache for a real result', async () => {
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      realResultEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=86400, s-maxage=86400',
    );
  });

  // `Headers.set` replaces workers-og's whole default value, which silently
  // dropped the `no-transform` that shipped on every OG response before the
  // override fix. These PNGs are the byte-exact social card `web` links; a
  // transforming edge (Polish/Mirage or any proxy) must not recompress them.
  it('cache-control keeps no-transform on both the long and the short cache', async () => {
    const long = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      realResultEnv(),
    );
    const short = await app.fetch(new Request('https://og.example/placeholder.png'), makeEnv());
    expect(long.headers.get('cache-control')).toContain('no-transform');
    expect(short.headers.get('cache-control')).toContain('no-transform');
  });

  // The static /placeholder.png is the ONE null-result render that is NOT
  // transient: it is byte-identical on every request (no owner/repo/sha), and
  // `web` only ever links it with `?v=${OG_TEMPLATE_VERSION}`
  // (packages/web/src/ui/og-meta.tsx), so a template change busts the URL
  // rather than needing the TTL to expire. Short-caching it would re-run a
  // ~700ms satori+resvg wasm render every 60s for an image that can never
  // differ. It opts into the long cache explicitly — the null-result default
  // stays SHORT for the genuinely transient callers (binding miss, notFound).
  it('/placeholder.png: the static route gets the LONG cache, not the null-result short cache', async () => {
    const res = await app.fetch(
      new Request(`https://og.example/placeholder.png?v=${OG_TEMPLATE_VERSION}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=86400, s-maxage=86400',
    );
    expect(collectText(lastRenderedNode)).toContain('Looking up…');
  });

  // ...but only for a version THIS build can render. `release.yml` deploys
  // `web` BEFORE `web-og`, so on a template bump `web` is already emitting
  // `?v=og.vNEXT` while this Worker is still the OLD build. Long-caching that
  // URL would pin a stale-template card for 24h at every scraper that unfurled
  // during the deploy window — and the busting URL is already spent, so there
  // is no second URL to bump. An unrenderable version falls back to the SHORT
  // cache and self-heals 60s after web-og lands.
  it('/placeholder.png: a version this build cannot render falls back to the SHORT cache', async () => {
    const res = await app.fetch(
      new Request('https://og.example/placeholder.png?v=og.vNEXT'),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // An unversioned hit is not a URL `web` ever emits (og-meta.tsx always
  // appends `?v=`), so it gets no long-cache guarantee either.
  it('/placeholder.png: an unversioned request gets the SHORT cache', async () => {
    const res = await app.fetch(new Request('https://og.example/placeholder.png'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // Deploy-order safety: an unmatched .png (a stale crawler URL, or a permalink
  // OG URL hit during the web→web-og deploy window before web-og ships the
  // matching route) renders a placeholder PNG, not a 404 text body — so a social
  // unfurl fetcher always gets a valid image.
  it('notFound: an unmatched .png renders a short-cached placeholder PNG, not 404', async () => {
    const res = await app.fetch(new Request('https://og.example/totally/unknown.png'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
  });

  it('notFound: a non-.png path still 404s', async () => {
    const res = await app.fetch(new Request('https://og.example/totally/unknown'), makeEnv());
    expect(res.status).toBe(404);
  });
});

// The card the OG worker builds from a LookupResult branches on whether the
// commit is released. Both states ship as the social unfurl for a permalink, so
// the TEXT each one renders is user-facing and was previously unasserted (the
// routing tests only checked status + cache headers). We capture the satori node
// tree and assert its text leaves.
describe('web-og card content', () => {
  function resultEnv(result: Record<string, unknown>): { WEB: { fetch: typeof fetch } } {
    return makeEnv(new Response(JSON.stringify(result)));
  }
  const baseInput = {
    kind: 'commit',
    repo: { owner: 'facebook', repo: 'react', projectPath: 'facebook/react' },
    sha: 'a'.repeat(40),
  };

  it('released commit: shows the tag, the SHIPPED badge, the date and repo', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('First released in');
    expect(text).toContain('v18.2.0');
    expect(text).toContain('SHIPPED');
    expect(text).toContain('2024-03-15'); // date sliced to YYYY-MM-DD
    expect(text).toContain('facebook/react');
    expect(text.join(' ')).toContain('abc1234'); // 7-char short sha
    // Not the not-yet-released copy.
    expect(text).not.toContain('not yet released');
  });

  it('unreleased commit (firstRelease null): says "not yet released", NO SHIPPED, NO date', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('not yet released');
    // The SHIPPED badge and the date are gated on `firstRelease` — both gone.
    expect(text).not.toContain('SHIPPED');
    expect(text.some((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))).toBe(false);
    // Pending-cached: "not yet released" is a pending state that has to flip
    // when the release lands, so it is NOT long-cacheable just because a
    // result came back (#151). Lifetime coverage lives in its own describe.
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=300, s-maxage=300',
    );
  });

  it('placeholder card (binding miss): shows "Looking up…" and the owner/repo label', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('released');
    expect(text).toContain('Looking up…');
    expect(text.join(' ')).toContain('facebook/react @ abc1234');
  });

  // Regression for the 0-byte dynamic OG render: every card that ships as a real
  // unfurl must satisfy satori's "explicit display for multi-child elements"
  // rule, or it renders a 200 + empty PNG (blank social preview). Asserted for
  // BOTH card branches (released + not-yet) since both reach the dynamic path.
  it('released card: node tree has no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('not-yet-released card: node tree has no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('placeholder card: node tree has no satori multi-child display violations', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });
});

// #79: issue/PR permalinks get a title-aware OG card. web-og adds /i/ and /p/
// image routes (mirroring the permalink scheme) that fetch the result resolved
// AS an issue/PR (so result.subject = the issue/PR title, not the commit
// subject) and render an "Issue #N" / "PR #N" headline above the release tag.
describe('web-og issue/PR cards (#79)', () => {
  function resultEnv(result: Record<string, unknown>): { WEB: { fetch: typeof fetch } } {
    return makeEnv(new Response(JSON.stringify(result)));
  }

  it('issue route: calls /internal/issue/:owner/:repo/:number and renders the title + tag', async () => {
    const env = resultEnv({
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
    });
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toBe('https://web/internal/issue/honojs/hono/11');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Issue #11');
    expect(text).toContain('Logger builtin middleware'); // the title (subject)
    expect(text).toContain('v0.0.11');
    expect(text).toContain('honojs/hono');
    // Real result → long cache.
    expect(res.headers.get('cache-control')).toBe(
      'public, no-transform, max-age=86400, s-maxage=86400',
    );
  });

  it('pr route: calls /internal/pr/:owner/:repo/:number and renders "PR #N" + title', async () => {
    const env = resultEnv({
      input: { kind: 'pr', repo: { host: 'github.com', projectPath: 'honojs/hono' }, number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(new Request('https://og.example/p/honojs/hono/17.png'), env);
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe('https://web/internal/pr/honojs/hono/17');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('PR #17');
    expect(text).toContain('Add logger builtin');
    expect(text).toContain('v0.0.11');
  });

  it('federated issue route: calls /internal/h/:host/i/:projectPath/:number', async () => {
    const env = resultEnv({
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
    });
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/GNOME%2Fglib/1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      'https://web/internal/h/gitlab.gnome.org/i/GNOME%2Fglib/1234',
    );
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Issue #1234');
    expect(text).toContain('Fix a GLib crash');
  });

  it('issue route: placeholder with SHORT cache on binding miss shows owner/repo #N', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
    expect(text.join(' ')).toContain('honojs/hono #11');
  });

  it('issue card: no satori multi-child display violations', async () => {
    const env = resultEnv({
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
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('pr card: no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: { kind: 'pr', repo: { host: 'github.com', projectPath: 'honojs/hono' }, number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/p/honojs/hono/17.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('issue route: rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.svg'), makeEnv());
    expect(res.status).toBe(404);
  });

  // A federated MR shares the permalink page's "Merge request !N" noun/sigil
  // (the page pulls them from provider.terms; web-og has no provider terms, so
  // the PR branch must branch on host). Covers the federated PR route end-to-end
  // too — previously a copy of the issue route with nothing asserting it.
  it('federated MR route: calls /internal/h/:host/p/:projectPath/:number and renders "Merge request !N"', async () => {
    const env = resultEnv({
      input: {
        kind: 'pr',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/glib' },
        number: 5678,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Merge the GLib fix',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/p/GNOME%2Fglib/5678.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      'https://web/internal/h/gitlab.gnome.org/p/GNOME%2Fglib/5678',
    );
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Merge request !5678');
    expect(text).toContain('Merge the GLib fix');
    expect(text).toContain('2.88.2');
    expect(text).not.toContain('PR #5678');
  });

  // Regression: a malformed %-escape in the federated projectPath (e.g. `foo%2`)
  // must render the placeholder, not throw. Hono's c.req.param() already decodes
  // safely (try/catch), so an explicit decodeURIComponent is a redundant
  // double-decode that throws URIError on malformed input → HTTP 500 before the
  // placeholder can render. A crawler's og:image fetch must get a PNG, not a 500.
  it('federated issue route: a malformed %-escape renders a placeholder, not a 500', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/foo%2/9.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
  });

  // The %-escape need not be malformed — a lone `%` arrives via the valid
  // encoding `%25`, which Hono decodes to `%`. The OLD code then
  // decodeURIComponent'd that `%` again and threw URIError → 500. Pinned so the
  // fix (no redundant double-decode) stays intact for this exact repro.
  it('federated issue route: a `%25` (lone percent) path renders a placeholder, not a 500', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/bad%25/1.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // A verbose issue/PR title (GitHub allows 256 chars) must not overflow the
  // 630px card. The title renders at fontSize 40 above a flex:1 spacer; ~4+
  // lines collapse the spacer and satori clips the bottom (SHA + domain) and
  // crowds the tag/date. Cap it with an ellipsis so it can't overflow.
  it('issue card: a long title is truncated with an ellipsis, never overflowing', async () => {
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'X'.repeat(200),
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    // The card still satisfies satori's layout rules.
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
    const joined = collectText(lastRenderedNode).join('');
    expect(joined).toContain('…'); // truncated
    expect(joined).not.toContain('X'.repeat(80)); // capped short of 80 chars
    expect(joined).toContain('X'.repeat(70)); // but kept most of the title
  });

  // Truncation must cut on a Unicode code-point boundary, not a UTF-16 code-unit
  // boundary: slicing at index 79 can split an emoji surrogate pair (🎉 is two
  // code units), leaving a lone high surrogate that satori/resvg renders as □.
  it('issue card: truncating an emoji at the boundary leaves no lone surrogate', async () => {
    // 78 plain chars + a 2-code-unit emoji at positions 78–79 + a trailing char
    // → title.length === 81 (> 80, so it truncates), and index 79 falls inside
    // the surrogate pair. `title.slice(0, 79)` would keep the high surrogate.
    const title = 'X'.repeat(78) + '🎉' + 'Y';
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: title,
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    const joined = collectText(lastRenderedNode).join('');
    expect(joined).toContain('…');
    // No lone surrogate (U+D800–U+DFFF) leaks into the rendered text.
    expect(/[\u{D800}-\u{DFFF}]/u.test(joined)).toBe(false);
  });
});

// #151: the cache lifetime keys on whether a result was RECEIVED, not on
// whether the answer it renders can still change. Both non-terminal shapes —
// "not yet released" (firstRelease null) and a soft-deadline `partial` — are
// real LookupResults, so both took the 24h cache. The not-yet card is the one
// card whose whole job is to flip when the release lands; a partial is an
// unconfirmed answer from a truncated traversal. Pinning either for a day in
// every crawler's cache is the OG analogue of the badge invariant the project
// already states (released → long, not-yet/checking → short).
describe('web-og cache lifetime keys on terminality, not presence (#151)', () => {
  const LONG = 'public, no-transform, max-age=86400, s-maxage=86400';
  // A pending answer is backed by `/internal`'s own 30-minute result cache
  // (`cache.put(k, r, 30 * 60)` in packages/web/src/routes/internal.ts), so a
  // 60s edge TTL cannot buy freshness the upstream does not have — it just
  // re-runs the ~700ms satori+resvg render up to 60x/hour per URL while
  // `/internal` hands back byte-identical JSON. 300s matches what badge.ts
  // already uses for the same pending state and is still 6x fresher than the
  // data behind it.
  const PENDING = 'public, no-transform, max-age=300, s-maxage=300';
  // PENDING stays separate from the placeholder's 60s SHORT_CACHE because the
  // two answer different questions: SHORT_CACHE is "how fast should a FAILED
  // render retry" (binding miss, unrenderable template version), PENDING is
  // "how fast can this ANSWER change". Collapsing them by bumping SHORT_CACHE
  // to 300 reddens the 14 existing placeholder-lifetime tests above, which is
  // the guard for that direction.

  const baseInput = {
    kind: 'commit',
    repo: { owner: 'facebook', repo: 'react', projectPath: 'facebook/react' },
    sha: 'a'.repeat(40),
  };
  const released = { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' };

  async function fetchCard(result: Record<string, unknown>): Promise<Response> {
    return await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      makeEnv(new Response(JSON.stringify(result))),
    );
  }

  // Scope this one honestly, and only to the BARE shape. `firstRelease: null`
  // with NO `partial` is what core does not currently emit: `find-release.ts:316`
  // is its only null return and always carries `partial: soft_deadline`, and a
  // genuine not-yet-released commit throws `NotYetReleasedError`, which
  // `/internal` turns into a 503. So this is a DEFENSIVE unit guard on the
  // lifetime rule for a shape the type permits (and core keeps a fallback branch
  // for at `:486`) — it is not evidence about a state production reaches today.
  // It says nothing about `null` WITH a `partial`, which IS reachable and has its
  // own copy guard below. (The same distinction is already drawn on
  // `pendingFixture` in web's internal-cache-origin tests.)
  it('DEFENSIVE: a bare not-yet-released result is PENDING-cached (300s), not pinned', async () => {
    const res = await fetchCard({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    expect(res.status).toBe(200);
    // The card really does render the flippable copy — so this is the card
    // whose lifetime matters, not an unrelated shape.
    expect(collectText(lastRenderedNode)).toContain('not yet released');
    expect(res.headers.get('cache-control')).toBe(PENDING);
  });

  // The REACHABLE not-yet-released path, end to end, and the one #151 actually
  // asked to be pinned down: `/internal` 503s `NotYetReleasedError`, `fetchResult`
  // returns null, and web-og renders the neutral placeholder at SHORT_CACHE. This
  // documents what production does today — including that the card does NOT say
  // the commit is unreleased, which is #150 and out of scope here. If #150 is
  // fixed by making `/internal` return a result instead of a 503, this test goes
  // red and points at the lifetime decision that has to be made with it.
  it('a not-yet-released commit reaches web-og as a 503 → placeholder, short-cached (#150)', async () => {
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      makeEnv(new Response('{"error":"not yet released"}', { status: 503 })),
    );
    expect(res.status).toBe(200);
    // Not the "not yet released" card — the neutral placeholder.
    expect(collectText(lastRenderedNode)).toContain('Looking up…');
    expect(collectText(lastRenderedNode)).not.toContain('not yet released');
    expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  // The REACHABLE route into the "not yet released" card, and the one the
  // docstring on `isTerminal` used to disclaim. A blown soft deadline with no
  // gallop hit returns `firstRelease: null` + `partial` as a normal VALUE
  // (`find-release.ts:312-322`); `/internal` caches it and answers 200, so
  // `fetchResult` hands web-og a real result and `ResultCard` renders
  // `firstRelease?.tag ?? 'not yet released'`. Asserting the COPY as well as the
  // lifetime is the point: the shape reaches this card on `main` today, and #144
  // (503 on every partial) then #156 (render it with a caveat) both move that
  // route without changing what the lifetime must be. If either lands without
  // deciding this card's lifetime deliberately, this test is what says so.
  it('a soft-deadline partial with NO release renders the not-yet copy, PENDING-cached', async () => {
    const res = await fetchCard({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      partial: { reason: 'soft_deadline', candidatesTried: 12 },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    expect(res.status).toBe(200);
    expect(collectText(lastRenderedNode)).toContain('not yet released');
    // Not LONG: an unconfirmed traversal must stay revalidatable. Not the
    // placeholder's SHORT_CACHE either — this is a rendered answer, not a failed
    // render.
    expect(res.headers.get('cache-control')).toBe(PENDING);
  });

  it('partial result is PENDING-cached even though it carries a firstRelease', async () => {
    const res = await fetchCard({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: released,
      partial: { reason: 'soft_deadline', candidatesTried: 12 },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    expect(res.status).toBe(200);
    // A galloped answer under a blown soft deadline is not confirmed earliest,
    // so it must stay revalidatable rather than pinned for a day.
    expect(res.headers.get('cache-control')).toBe(PENDING);
  });

  // Complement. Without it, "short-cache everything" passes the two above and
  // silently re-renders every settled card once a minute. (Proven: forcing
  // isTerminal to false reddens this and 10 pre-existing long-cache tests.)
  it('terminal released result keeps the LONG cache', async () => {
    const res = await fetchCard({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: released,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    expect(res.status).toBe(200);
    expect(collectText(lastRenderedNode)).toContain('SHIPPED');
    expect(res.headers.get('cache-control')).toBe(LONG);
  });
});
