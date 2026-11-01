// Real-render gate (#94): renders every OG card shape under the Workers runtime
// (workerd, via @cloudflare/vitest-pool-workers) and asserts a valid non-empty
// PNG. The routing tests mock workers-og, so a satori throw — the #56 failure
// that shipped a blank dynamic OG card for several cycles — still returned 200
// + image/png with a 0-byte body and passed the gate. This file renders for
// real: any card that blanks (a satori throw, an unsupported property, a
// font-path change) fails the magic/byte assertions here, at the gate, before
// prod.
//
// Run under the workers pool: `vitest run --config vitest.workers.config.ts`.
// workers-og's wasm only loads through workerd's module graph (plain Node
// throws on the wasm import), so this file is excluded from the default
// (plain-Node) vitest config by its `.render.test.ts` name.
import type { LookupResult, RepoRef } from '@released/core';
import { expect, it } from 'vitest';
import { renderImage } from '../src/index.js';

// PNG signature. A 0-byte body (the #56 blank) has no byte 0, so this alone
// catches the original failure; the size floor catches a valid-but-tiny render.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// Real cards rasterize to tens of KB (prod unfurls are 28–43 KB). A blank or
// near-blank render is a few hundred bytes at most, so 5 KB cleanly separates a
// real card from a broken one with wide margin on either side.
const MIN_REAL_PNG_BYTES = 5_000;

function repo(host: string, projectPath: string): RepoRef {
  return { host, projectPath };
}

/** Asserts `res` is a real PNG: image/png content-type, the PNG magic header,
 *  and a body large enough to be a rasterized card (not a blank). */
async function expectValidCardPng(res: Response, label: string) {
  expect(res.status, `${label}: status`).toBe(200);
  expect(res.headers.get('content-type'), `${label}: content-type`).toMatch(/image\/png/);
  const buf = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    expect(buf[i], `${label}: PNG magic byte ${i}`).toBe(PNG_MAGIC[i]);
  }
  expect(
    buf.length,
    `${label}: ${buf.length}B is below the ${MIN_REAL_PNG_BYTES}B real-card floor`,
  ).toBeGreaterThan(MIN_REAL_PNG_BYTES);
}

/** Build a fully-typed LookupResult with the fields renderImage reads, defaulting
 *  the rest. Mirrors the canned fixtures in routing.test.ts but typed (those are
 *  `Record<string, unknown>` JSON). */
function result(
  over: Partial<LookupResult> & Pick<LookupResult, 'input' | 'canonicalSha'>,
): LookupResult {
  return {
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    urls: { repo: 'https://example.com/repo', commit: 'https://example.com/commit' },
    ...over,
  };
}

it('commit card (released): renders a real non-empty PNG', async () => {
  const res = renderImage(
    result({
      input: { kind: 'commit', repo: repo('github.com', 'facebook/react'), sha: 'a'.repeat(40) },
      canonicalSha: 'abc1234def5678',
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' },
    }),
    { owner: 'facebook', repo: 'react', sha: 'abc1234' },
  );
  await expectValidCardPng(res, 'released commit');
});

it('commit card (not yet released): renders a real non-empty PNG', async () => {
  const res = renderImage(
    result({
      input: { kind: 'commit', repo: repo('github.com', 'facebook/react'), sha: 'a'.repeat(40) },
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
    }),
    { owner: 'facebook', repo: 'react', sha: 'abc1234' },
  );
  await expectValidCardPng(res, 'not-yet commit');
});

it('issue card (#79): renders a real non-empty PNG with the title headline', async () => {
  const res = renderImage(
    result({
      input: { kind: 'issue', repo: repo('github.com', 'honojs/hono'), number: 11 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Logger builtin middleware',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
    }),
    { owner: 'honojs', repo: 'hono', number: '11' },
  );
  await expectValidCardPng(res, 'issue');
});

it('PR card (#79): renders a real non-empty PNG with the title headline', async () => {
  const res = renderImage(
    result({
      input: { kind: 'pr', repo: repo('github.com', 'honojs/hono'), number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
    }),
    { owner: 'honojs', repo: 'hono', number: '17' },
  );
  await expectValidCardPng(res, 'pr');
});

it('federated GitLab MR card: renders a real non-empty PNG (Merge request !N branch)', async () => {
  const res = renderImage(
    result({
      input: { kind: 'pr', repo: repo('gitlab.gnome.org', 'GNOME/glib'), number: 4321 },
      canonicalSha: 'a'.repeat(40),
      subject: 'glib: fix timezone parsing',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-05-01T00:00:00Z', url: '' },
    }),
    { owner: 'GNOME', repo: 'glib', number: '4321' },
  );
  await expectValidCardPng(res, 'federated MR');
});

it('placeholder card (null result): renders a real non-empty PNG', async () => {
  const res = renderImage(null, { owner: 'facebook', repo: 'react', sha: 'abc1234' });
  await expectValidCardPng(res, 'placeholder');
});

// Cache semantics against the REAL workers-og (the routing tests mock it, so
// they cannot see this). workers-og builds its response headers as
//   { 'Content-Type': …, 'Cache-Control': <its own 1-year default>, ...opts.headers }
// and object spread is case-SENSITIVE: a lowercase 'cache-control' from the
// caller does not replace the capitalized default, so BOTH keys reach
// `new Response`, where Headers merges them into one comma-joined value
// ("public, immutable, no-transform, max-age=31536000, public, max-age=60").
// Caches read the first max-age, so the short-cached cards — placeholder,
// cold-lookup, the deploy-window notFound render — were pinned immutable for a
// year instead of 60s and could never refresh. Assert the header EXACTLY: a
// substring match passes on the merged value and would not have caught this.
it('placeholder card: cache-control is EXACTLY the short cache (no 1-year default merged in)', () => {
  const res = renderImage(null, { owner: 'facebook', repo: 'react', sha: 'abc1234' });
  expect(res.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
});

it('result card: cache-control is EXACTLY the long cache (no 1-year default merged in)', () => {
  const res = renderImage(
    result({
      input: { kind: 'commit', repo: repo('github.com', 'facebook/react'), sha: 'a'.repeat(40) },
      canonicalSha: 'a'.repeat(40),
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-01-01T00:00:00Z', url: '' },
    }),
    { owner: 'facebook', repo: 'react', sha: 'abc1234' },
  );
  expect(res.headers.get('cache-control')).toBe(
    'public, no-transform, max-age=86400, s-maxage=86400',
  );
});
