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
import { hasUserToken } from './auth.js';

/** A cached value plus how long ago it was written (seconds). */
export type CacheEntry<T> = { value: T; ageSeconds: number };

export type WorkerCache = CacheStore & {
  /** Like get(), but also reports the entry's age so callers can judge staleness. */
  getEntry<T>(key: string): Promise<CacheEntry<T> | null>;
  /** False when the request carries a user token: nothing is read or written, and
   *  callers must not coalesce its compute with anyone else's (single-flight). */
  shared: boolean;
};

// A user-token lookup never touches the anonymous shared slot (#164).
const unsharedCache: WorkerCache = {
  shared: false,
  async get() {
    return null;
  },
  async getEntry() {
    return null;
  },
  async put() {},
};

export function makeWorkerCache(req: Request, ttlSecondsDefault = 1800): WorkerCache {
  if (hasUserToken(req)) return unsharedCache;
  const origin = new URL(req.url).origin;
  const keyUrl = (key: string) => `${origin}/__cache__/${encodeURIComponent(key)}`;
  const store = (caches as unknown as { default: Cache }).default;

  function match(key: string): Promise<Response | undefined> {
    return store.match(new Request(keyUrl(key)));
  }

  return {
    shared: true,

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
      await store.put(new Request(keyUrl(key)), res);
    },
  };
}
