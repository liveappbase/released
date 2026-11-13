// makeWorkerCache: verifies the synthetic cache-key URL uses the worker's own
// hostname (taken from the incoming request), NOT a non-routable `.invalid`
// hostname. Cloudflare's Cache API only reliably persists puts whose key URL
// is on a real, routable hostname — `cache.invalid` puts silently no-op or get
// evicted aggressively, which is what was causing the live "second hit was
// still cold" bug.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWorkerCache } from '../src/cache.js';

type FakeCache = {
  put: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
};

function installFakeCache(): FakeCache {
  const cache: FakeCache = {
    put: vi.fn(async () => undefined),
    match: vi.fn(async () => undefined),
  };
  (globalThis as unknown as { caches: { default: FakeCache } }).caches = { default: cache };
  return cache;
}

describe('makeWorkerCache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keys puts on the request hostname, never on cache.invalid', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');
    const cache = makeWorkerCache(req);
    await cache.put('mykey', { hello: 'world' }, 1800);

    expect(fake.put).toHaveBeenCalledOnce();
    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const url = new URL(putReq.url);
    expect(url.hostname).toBe('released-web.lukaso.workers.dev');
    expect(url.hostname).not.toContain('invalid');
    expect(url.pathname).toContain('mykey');
  });

  it('keys gets on the same URL shape as puts (round-trip)', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');
    const cache = makeWorkerCache(req);

    await cache.put('roundtrip-key', { answer: 42 }, 1800);
    await cache.get('roundtrip-key');

    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const [matchReq] = fake.match.mock.calls[0] as [Request];
    expect(matchReq.url).toBe(putReq.url);
  });

  it('uses the request hostname even when called with different request URLs (same key → same cache URL)', async () => {
    const fake = installFakeCache();
    const reqA = new Request('https://released-web.lukaso.workers.dev/lookup?q=x');
    const reqB = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');

    const cacheA = makeWorkerCache(reqA);
    const cacheB = makeWorkerCache(reqB);

    await cacheA.put('shared-key', { v: 1 }, 1800);
    await cacheB.get('shared-key');

    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const [matchReq] = fake.match.mock.calls[0] as [Request];
    expect(matchReq.url).toBe(putReq.url);
  });

  it('attaches public Cache-Control with the requested TTL', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/');
    const cache = makeWorkerCache(req);

    await cache.put('k1', { x: 1 }, 60);
    const [, putRes] = fake.put.mock.calls[0] as [Request, Response];
    expect(putRes.headers.get('cache-control')).toBe('public, max-age=60');
  });

  // Stale-if-error needs to know HOW OLD a cached entry is, independent of the
  // HTTP max-age (which is the long "hard" TTL that keeps the entry physically
  // alive so we can still serve it during an upstream outage). put() stamps a
  // wall-clock x-cached-at; getEntry() reads it back as an age.
  it('put stamps an x-cached-at header with the current time', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/');
    const cache = makeWorkerCache(req);
    const before = Date.now();
    await cache.put('k', { x: 1 }, 100);
    const [, putRes] = fake.put.mock.calls[0] as [Request, Response];
    const stamp = Number(putRes.headers.get('x-cached-at'));
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('getEntry returns the value plus an ageSeconds derived from x-cached-at', async () => {
    const fake = installFakeCache();
    const cachedAt = Date.now() - 42_000; // 42s ago
    fake.match.mockResolvedValueOnce(
      new Response(JSON.stringify({ x: 7 }), {
        headers: { 'content-type': 'application/json', 'x-cached-at': String(cachedAt) },
      }),
    );
    const cache = makeWorkerCache(new Request('https://released-web.lukaso.workers.dev/'));
    const entry = await cache.getEntry<{ x: number }>('k');
    expect(entry?.value).toEqual({ x: 7 });
    expect(entry?.ageSeconds).toBeGreaterThanOrEqual(41);
    expect(entry?.ageSeconds).toBeLessThanOrEqual(44);
    // The raw write-time stamp is reported too: `ageSeconds` is floored from a
    // read-time `Date.now()`, so an ordering test between two entries read at
    // different instants needs the stamp itself (resolve.ts writtenNoEarlierThan).
    expect(entry?.stampedAt).toBe(cachedAt);
  });

  it('getEntry returns null when there is no cached entry', async () => {
    installFakeCache(); // default match → undefined
    const cache = makeWorkerCache(new Request('https://released-web.lukaso.workers.dev/'));
    expect(await cache.getEntry('nope')).toBeNull();
  });

  it('getEntry treats a missing x-cached-at as age 0 (entry written by a prior version)', async () => {
    const fake = installFakeCache();
    fake.match.mockResolvedValueOnce(
      new Response(JSON.stringify({ x: 1 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const cache = makeWorkerCache(new Request('https://released-web.lukaso.workers.dev/'));
    const entry = await cache.getEntry('k');
    expect(entry?.ageSeconds).toBe(0);
    // ...and reports the stamp as absent rather than inventing one, so an
    // ordering test refuses the pair instead of comparing against a fake 0:
    // `writtenNoEarlierThan` (resolve.ts) returns false when either stamp is
    // null, so an unstamped marker/entry pair is always recomputed, never served.
    expect(entry?.stampedAt).toBeNull();
  });
});
