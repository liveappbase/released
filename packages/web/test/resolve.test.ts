// resolveLookup: the stale-if-error core. Verifies that a transient upstream
// failure never erases a known-good answer, that terminal "released" answers are
// served forever without touching upstream, and that a down upstream is not
// hammered (short negative cache / revalidation throttle).

import {
  type LookupInput,
  type LookupResult,
  NotYetReleasedError,
  PrNotFoundError,
  ProviderJsonError,
  ProviderServerError,
  type RepoRef,
} from '@released/core';
import { describe, expect, it, vi } from 'vitest';
import type { CacheEntry, WorkerCache } from '../src/cache.js';
import { isTransientError, resolveLookup } from '../src/resolve.js';

const REPO: RepoRef = { host: 'gitlab.gnome.org', projectPath: 'GNOME/gtk' };
const INPUT: LookupInput = { kind: 'pr', repo: REPO, number: 9951 };

function mkResult(opts: { released: boolean; partial?: boolean }): LookupResult {
  return {
    input: INPUT,
    canonicalSha: 'ffffffffffffffffffffffffffffffffffffffff',
    subject: 'macos: Fix #8213',
    firstRelease: opts.released
      ? { tag: '4.18.0', date: '2024-06-01T00:00:00Z', url: 'https://example/rel' }
      : null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    ...(opts.partial ? { partial: { reason: 'soft_deadline', candidatesTried: 3 } } : {}),
    urls: { repo: 'https://example/repo', commit: 'https://example/commit' },
  } as LookupResult;
}

/** In-memory WorkerCache whose entry ages are set explicitly by the test. */
function makeFakeCache() {
  const store = new Map<string, { value: unknown; ageSeconds: number }>();
  const cache: WorkerCache = {
    shared: true,
    async get<T>(key: string) {
      return (store.get(key)?.value as T) ?? null;
    },
    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      const e = store.get(key);
      return e ? { value: e.value as T, ageSeconds: e.ageSeconds } : null;
    },
    async put<T>(key: string, value: T) {
      store.set(key, { value, ageSeconds: 0 });
    },
  };
  return {
    cache,
    seed(key: string, value: unknown, ageSeconds: number) {
      store.set(key, { value, ageSeconds });
    },
    has: (key: string) => store.has(key),
    get: (key: string) => store.get(key),
  };
}

const KEY = 'res:gtk:pr#9951';
const negKey = `${KEY}:neg`;

describe('isTransientError', () => {
  it('treats 5xx / network / timeout / rate-limit as transient', () => {
    expect(isTransientError(new ProviderServerError('gitlab.gnome.org', 503, 'x'))).toBe(true);
  });
  it('treats not-found as permanent (a real answer)', () => {
    expect(isTransientError(new PrNotFoundError(9951))).toBe(false);
  });
  it('treats NotYetReleasedError as not transient (handled separately)', () => {
    expect(isTransientError(new NotYetReleasedError('abc1234', '2024-01-01'))).toBe(false);
  });
});

describe('resolveLookup — happy paths', () => {
  it('serves a fresh cached answer without calling upstream', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: true }), 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('a released answer is terminal — fresh forever, even when very old', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: true }), 60 * 60 * 24 * 20); // 20 days
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('cold miss computes, caches, and returns the fresh answer', async () => {
    const f = makeFakeCache();
    const result = mkResult({ released: true });
    const load = vi.fn(async () => result);
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ status: 'ok', stale: false });
    expect(f.has(KEY)).toBe(true);
  });
});

describe('resolveLookup — stale-if-error (the bug)', () => {
  it('serves the last-known-good answer (stale) when a stale entry fails to revalidate', async () => {
    const f = makeFakeCache();
    const known = mkResult({ released: true });
    f.seed(KEY, known, 7 * 60); // older than the 5-min freshness window for pending…
    // …but released answers are terminal, so they'd be fresh. Use a not-yet
    // partial prior to force a revalidation attempt instead:
    const pending = mkResult({ released: false, partial: true });
    f.seed(KEY, pending, 10); // partial fresh window is 60s
    // bump age past partial window so it revalidates
    f.seed(KEY, pending, 120);
    const load = vi.fn(async () => {
      throw new ProviderServerError('gitlab.gnome.org', 503, 'Service Unavailable');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(pending);
      expect(r.staleAsOf).toBeTypeOf('number');
    }
    // …and it records a throttle marker so the next request won't re-hammer.
    expect(f.has(negKey)).toBe(true);
  });

  it('does not hammer upstream while serving stale: a fresh neg marker skips the load', async () => {
    const f = makeFakeCache();
    const pending = mkResult({ released: false, partial: true });
    f.seed(KEY, pending, 120); // stale (past 60s partial window)
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 5); // tried 5s ago
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(true);
  });
});

describe('resolveLookup — cold + upstream down', () => {
  it('returns a transient status (not an error) and records a negative cache', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderServerError('gitlab.gnome.org', 503, 'Service Unavailable');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.kind).toBe('provider_server_error');
      // Carry the upstream HTTP status through to the route so analytics can
      // record WHY the host failed (5xx vs 429 vs challenge), not just that it did.
      expect(r.upstreamStatus).toBe(503);
    }
    expect(f.has(negKey)).toBe(true);
  });

  it('a fresh negative cache short-circuits to transient WITHOUT calling upstream', async () => {
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('transient');
  });

  it('an EXPIRED negative cache retries upstream', async () => {
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 120); // > 60s NEG_TTL
    const result = mkResult({ released: true });
    const load = vi.fn(async () => result);
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('ok');
  });
});

describe('resolveLookup — Anubis surfacing', () => {
  // gitlab.freedesktop.org sits behind Anubis: it returns 200 with an HTML
  // interstitial. We classify this as transient (since the cause is upstream),
  // but the UI needs to know it's Anubis so it can point users at the CLI
  // instead of a futile "Try again" button — retrying never beats Anubis from
  // a Cloudflare Worker (workerd's TLS fingerprint is the trigger).
  it('threads anubis=true on the transient status when load throws an Anubis ProviderJsonError', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderJsonError(
        200,
        '<title>Making sure you are not a bot!</title>',
        new Error('parse'),
      );
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.kind).toBe('provider_json_error');
      expect(r.anubis).toBe(true);
    }
  });

  it('threads anubis=false on transient when the JSON error is NOT Anubis (e.g. Cloudflare CF)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderJsonError(200, '<title>Just a moment...</title>', new Error('parse'));
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.anubis).toBeFalsy();
    }
  });

  it('preserves the anubis flag through a backed-off negative cache hit', async () => {
    // After the first Anubis failure the resolver writes a neg marker. The
    // next request must STILL surface anubis=true so the UI keeps pointing at
    // the CLI; otherwise the UX flips back to a misleading "Try again" during
    // the throttle window.
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_json_error', anubis: true }, 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('transient');
    if (r.status === 'transient') expect(r.anubis).toBe(true);
  });
});

describe('resolveLookup — real answers pass through', () => {
  it('NotYetReleasedError becomes a not_yet status (never a negative cache)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new NotYetReleasedError('fffffff', '2024-01-01', 0, 0, 'macos: Fix #8213');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('not_yet');
    expect(f.has(negKey)).toBe(false);
  });

  it('a permanent error (PR not found) becomes an error status (never a negative cache)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new PrNotFoundError(9951);
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('error');
    expect(f.has(negKey)).toBe(false);
  });
});

describe('resolveLookup — a non-shared (user-PAT) cache never coalesces (#164)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('an anonymous call concurrent with a PAT call on the same key computes its own answer', async () => {
    const shared = makeFakeCache();
    const pat = makeFakeCache();
    const patCache: WorkerCache = { ...pat.cache, shared: false };
    const anonCache: WorkerCache = { ...shared.cache, shared: true };
    const privateAnswer = mkResult({ released: true, partial: false });
    const publicAnswer = { ...mkResult({ released: false }), subject: 'public' } as LookupResult;
    const patGate = deferred<LookupResult>();
    const patLoad = vi.fn(() => patGate.promise);
    const anonLoad = vi.fn(async () => publicAnswer);

    const patP = resolveLookup({ cache: patCache, key: 'res:flight-164', load: patLoad });
    const anonP = resolveLookup({ cache: anonCache, key: 'res:flight-164', load: anonLoad });
    await new Promise((r) => setTimeout(r, 0));
    patGate.resolve(privateAnswer);
    const [, anon] = await Promise.all([patP, anonP]);

    expect(anonLoad).toHaveBeenCalledOnce();
    expect(anon).toMatchObject({ status: 'ok', result: { subject: 'public' } });
  });

  it('control: two shared calls on the same key still share one load', async () => {
    const f = makeFakeCache();
    const cache: WorkerCache = { ...f.cache, shared: true };
    const gate = deferred<LookupResult>();
    const load = vi.fn(() => gate.promise);
    const a = resolveLookup({ cache, key: 'res:flight-164-ctl', load });
    const b = resolveLookup({ cache, key: 'res:flight-164-ctl', load });
    await new Promise((r) => setTimeout(r, 0));
    gate.resolve(mkResult({ released: true }));
    await Promise.all([a, b]);
    expect(load).toHaveBeenCalledOnce();
  });
});
