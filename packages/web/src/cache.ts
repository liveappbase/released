// Cloudflare Cache API wrapper (CacheStore impl).
// Synthesizes a Request/Response pair keyed by a synthetic URL so the global
// Cache API stores it. Same cacheKey() generator as the CLI (from @released/core).
//
// IMPORTANT: the synthetic URL MUST be on the worker's own hostname.
// Cloudflare's Cache API silently no-ops (or evicts aggressively) for puts
// whose URL is on a non-routable hostname like cache.invalid — which was
// causing live "second hit was still cold" symptoms. Pass the incoming
// request into makeWorkerCache so we can derive `${origin}/__cache__/${key}`.
//
// Stale-if-error: put() stamps an `x-cached-at` wall-clock header so getEntry()
// can report an entry's age independently of the HTTP max-age. We store entries
// with a LONG hard TTL (so they survive an upstream outage) and decide freshness
// ourselves from the age — see resolve.ts.

import type { CacheStore } from '@released/core';
import { userTokenScope } from './auth.js';

/** A cached value plus how long ago it was written (seconds). */
export type CacheEntry<T> = { value: T; ageSeconds: number };

export type WorkerCache = CacheStore & {
  /** Like get(), but also reports the entry's age so callers can judge staleness. */
  getEntry<T>(key: string): Promise<CacheEntry<T> | null>;
  /** The single-flight key for `key`. A user-token request gets its own flight
   *  namespace, so it never coalesces with an anonymous or another user's compute. */
  flightKey(key: string): Promise<string>;
};

// A lookup made with the caller's own token may be a private repo's answer (#164).
// It is cached under `__cache__/u/<sha256 of the token>/`, apart from the anonymous
// slot that the public permalink, badge and OG routes read. Anonymous keys are
// URI-encoded, so they never contain a `/` and cannot collide with that prefix.
export function makeWorkerCache(req: Request, ttlSecondsDefault = 1800): WorkerCache {
  const origin = new URL(req.url).origin;
  const scope = userTokenScope(req);
  const keyUrl = async (key: string) =>
    `${origin}/__cache__/${await scope}${encodeURIComponent(key)}`;
  const store = (caches as unknown as { default: Cache }).default;

  async function match(key: string): Promise<Response | undefined> {
    return store.match(new Request(await keyUrl(key)));
  }

  return {
    async flightKey(key: string): Promise<string> {
      return `${await scope}${key}`;
    },

    async get<T>(key: string): Promise<T | null> {
      const res = await match(key);
      if (!res) return null;
      try {
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },

    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      const res = await match(key);
      if (!res) return null;
      let value: T;
      try {
        value = (await res.json()) as T;
      } catch {
        return null;
      }
      const stamped = Number(res.headers.get('x-cached-at'));
      const ageSeconds =
        Number.isFinite(stamped) && stamped > 0
          ? Math.max(0, Math.floor((Date.now() - stamped) / 1000))
          : 0;
      return { value, ageSeconds };
    },

    async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const ttl = ttlSeconds ?? ttlSecondsDefault;
      const res = new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${ttl}`,
          'x-cached-at': String(Date.now()),
        },
      });
      await store.put(new Request(await keyUrl(key)), res);
    },
  };
}
