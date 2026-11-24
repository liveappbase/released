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
  const store = new Map<string, { value: unknown; ageSeconds: number; stampedAt: number | null }>();
  const puts: { key: string; ttlSeconds?: number }[] = [];
  const cache: WorkerCache = {
    async get<T>(key: string) {
      return (store.get(key)?.value as T) ?? null;
    },
    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      const e = store.get(key);
      return e ? { value: e.value as T, ageSeconds: e.ageSeconds, stampedAt: e.stampedAt } : null;
    },
    async put<T>(key: string, value: T, ttlSeconds?: number) {
      puts.push({ key, ttlSeconds });
      store.set(key, { value, ageSeconds: 0, stampedAt: Date.now() });
    },
  };
  return {
    cache,
    /** Every `cache.put` in call order, with the TTL the caller asked for. The
     *  slot is shared across callers that do not agree on a deadline, so the TTL
     *  a write imposes on it is observable behaviour, not an implementation
     *  detail — asserting only the stored VALUE cannot see a caller shortening
     *  someone else's entry. */
    puts,
    /** `stampedAt` is the write-time `x-cached-at` the real cache stores. It is
     *  INDEPENDENT of `ageSeconds` here on purpose: production derives the two
     *  from different `Date.now()` samples, so a test has to be able to express a
     *  pair whose ages disagree with their true write order. Default it to a
     *  stamp consistent with the age, so existing tests are unaffected. */
    seed(key: string, value: unknown, ageSeconds: number, stampedAt?: number | null) {
      // `null` seeds an UNSTAMPED entry (one written before `x-cached-at`
      // existed, or whose header an intermediary dropped) — distinct from
      // omitting the argument, which derives the stamp from the age.
      store.set(key, {
        value,
        ageSeconds,
        stampedAt: stampedAt === undefined ? Date.now() - ageSeconds * 1000 : stampedAt,
      });
    },
    has: (key: string) => store.has(key),
    get: (key: string) => store.get(key),
  };
}

const KEY = 'res:gtk:pr#9951';
const negKey = `${KEY}:neg`;
const pinPartialKey = `${KEY}:pinpartial`;

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

// Round-6 review of #144. Earlier rounds bounded only one exit, so both
// stale-if-error exits — the back-off short-circuit and the transient catch —
// could still hand the OG crawler a prior of any age. Sharing
// the public routes' 24h slot is what made that reachable: before #143 this
// route had a flat 30-minute TTL, so a 23h-old prior could not exist on it.
// A pinned consumer renders whatever it gets into a PNG cached for a day.
describe('resolveLookup — a pinned consumer is never handed a prior past the bound', () => {
  const aged = () => mkResult({ released: false });

  it('back-off exit: attempts a fresh lookup instead of serving a 23h-old prior', async () => {
    const f = makeFakeCache();
    f.seed(KEY, aged(), 23 * 60 * 60); // inside HARD_TTL_PENDING (24h), way past the bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10); // a page view just failed
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(false);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
  });

  it('transient-catch exit: returns transient rather than the 23h-old prior', async () => {
    const f = makeFakeCache();
    f.seed(KEY, aged(), 23 * 60 * 60);
    const load = vi.fn(async () => {
      throw new ProviderServerError('github.com', 503, 'Service Unavailable');
    });

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('transient');
  });

  it('a prior INSIDE the bound is still stale-served to a pinned consumer', async () => {
    const f = makeFakeCache();
    // Deliberately NOT a `partial`: round 7 made those unpinnable at every exit
    // regardless of age, so a partial would no longer isolate the age bound.
    const pending = mkResult({ released: false });
    f.seed(KEY, pending, 10 * 60); // stale (past the 5-min freshness window), inside the 30-min bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(pending);
    }
  });

  it('public routes keep UNBOUNDED stale-if-error — the bound is opt-in only', async () => {
    const f = makeFakeCache();
    const old = aged();
    f.seed(KEY, old, 23 * 60 * 60);
    const load = vi.fn(async () => {
      throw new ProviderServerError('github.com', 503, 'Service Unavailable');
    });

    // Same 23h prior, same failure — but no consumerPinsResult: a human page is
    // not pinned anywhere and shows an explicit "stale as of" caveat, so serving
    // through a long outage stays the right degrade.
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(old);
    }
  });
});

// Round-7 review of #144. The round-6 bound was consulted only on the three
// STALE exits. The fresh-hit return above them never asked — and `isFresh()`
// calls a `partial` fresh for its whole 60s life. Aligning this route onto the
// public five-part key (this PR) is what made that reachable: `badge.ts` loads
// the identical key with an 8s soft deadline, so on a large repo it writes a
// `partial` (firstRelease `null`) that `/internal` then served as a plain 200.
// web-og renders `firstRelease?.tag ?? 'not yet released'` and long-caches any
// non-null result, so a RELEASED commit gets a "not yet released" card pinned
// for a day — the CLAUDE.md guardrail ("Partial state != not yet released")
// and the exact outcome `consumerPinsResult` exists to prevent.
describe('resolveLookup — a pinned consumer is never handed a cached PARTIAL', () => {
  // Round 8 narrows this ONE case, and only where it costs nothing: a partial
  // still inside its own 60s TTL is handed BACK rather than recomputed. It is not
  // thereby pinnable — the route refuses every `partial` (routes/internal.ts) and
  // 503s it into a neutral placeholder at max-age=60. Recomputing here instead is
  // what made the refusal unthrottled: no read path accepted the entry
  // resolveLookup had just written, so on a repo that reliably blows the 24s soft
  // deadline every unfurl ran another full traversal on the shared token, where
  // the flat 30-minute TTL this route replaced made zero upstream calls.
  it('fresh exit: hands back a 10s-old partial THIS caller wrote rather than re-run the lookup', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 10); // well inside the 60s partial freshness window
    f.seed(pinPartialKey, { pinnedPartial: true }, 10); // ...and this caller produced it
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    // Still flagged, so the pinning caller refuses it — the refusal just costs a
    // cache read now instead of a findRelease.
    if (r.status === 'ok') {
      expect(r.result.partial).toBeTruthy();
      expect(r.result.firstRelease).toBeNull();
    }
  });

  // find-release.ts returns a SECOND partial shape: a gallop hit the bisect never
  // confirmed is the earliest containing release (find-release.ts:293-305). Both
  // `hardTtlFor()` and `isFresh()` test `firstRelease` before `partial`, so that
  // shape is stored for 30 days and reported fresh forever — a pinning consumer
  // would get a possibly-wrong tag from an entry of any age, with no caveat and
  // no revalidation. (The terminal misclassification itself is on `main` and
  // affects the public routes too; the pin bound rejecting it on the way out is
  // what this PR owes.)
  // Round 14 review of #144. Round 13 bound the marker to the entry it vouches
  // for with `mark.ageSeconds <= prior.ageSeconds` — but those two ages are
  // floored from two DIFFERENT `Date.now()` samples, one Cache API round trip
  // apart, so the floors can straddle a second boundary and report the marker as
  // OLDER than an entry it was in fact written AFTER. The guard then disowns this
  // caller's own seconds-old partial and runs a full traversal — on exactly the
  // repos the throttle exists for. The stored `x-cached-at` stamps are the
  // quantity the ordering actually depends on.
  it('honours its own marker when the two READ ages straddle a second boundary', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    // The reviewer's arithmetic, seeded directly: entry written at t=1000 and
    // read back as 1s old; marker written 10ms LATER at t=1010 and read back as
    // 2s old, because its read happened 25ms further on.
    f.seed(KEY, truncated, 1, 1000);
    f.seed(pinPartialKey, { pinnedPartial: true }, 2, 1010);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.partial).toBeTruthy();
  });

  // Round 15 review of #144. The header claims the missing-stamp fallback goes
  // "the same conservative direction as before — an unprovable ordering
  // recomputes". It did the opposite: `cache.getEntry` reports `ageSeconds: 0`
  // for an entry with no `x-cached-at` (cache.ts:65-66), so a pair where BOTH
  // stamps are absent evaluated `0 <= 0` -> true and the unstamped marker
  // vouched for the unstamped entry unconditionally.
  it('recomputes when NEITHER the marker nor the entry carries a stamp', async () => {
    const f = makeFakeCache();
    const someoneElses = mkResult({ released: false, partial: true });
    // Both unstamped, so `ageSeconds` is 0 on both sides — the shape that made
    // the fallback vouch instead of recompute.
    f.seed(KEY, someoneElses, 0, null);
    f.seed(pinPartialKey, { pinnedPartial: true }, 0, null);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
  });

  // ...and one stamp present is just as unprovable as none: there is nothing to
  // compare the stamped side AGAINST, so this must recompute too.
  it('recomputes when only ONE side of the pair carries a stamp', async () => {
    const f = makeFakeCache();
    const someoneElses = mkResult({ released: false, partial: true });
    // The entry is unstamped and read as 5s old; the marker IS stamped and read
    // as 0s old. Ages alone say `0 <= 5` -> vouch, which is the same wrong
    // answer by a different route.
    f.seed(KEY, someoneElses, 5, null);
    f.seed(pinPartialKey, { pinnedPartial: true }, 0, 1000);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
  });

  // ...and the ordering test must still REJECT a slot genuinely overwritten after
  // the marker was written, or the fix above is just a way of deleting the guard.
  it('still disowns a partial written AFTER the marker (badge.ts overwrote the slot)', async () => {
    const f = makeFakeCache();
    const someoneElses = mkResult({ released: false, partial: true });
    // Marker at t=1000; the slot then overwritten at t=5000 by an 8s-deadline
    // caller on the same key. Ages alone would say the marker is the younger one.
    f.seed(KEY, someoneElses, 1, 5000);
    f.seed(pinPartialKey, { pinnedPartial: true }, 5, 1000);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('a gallop-only partial is not treated as terminal, however old', async () => {
    const f = makeFakeCache();
    const gallopOnly = { ...mkResult({ released: true }), partial: { reason: 'soft_deadline' } };
    f.seed(KEY, gallopOnly, 20 * 24 * 60 * 60); // 20 days — "fresh forever" today
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.partial).toBeUndefined();
  });

  it('...but a TERMINAL answer of the same age is still served, never recomputed', async () => {
    // The complement that stops the bound above from swallowing the warm entries
    // this route joined the public key to reuse.
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: true }), 20 * 24 * 60 * 60);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
  });

  it('stale exit: a partial inside the 30-min bound is still not pinnable', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 120); // past the 60s partial window, inside the 30-min bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('public routes still get the fresh partial — the guard is opt-in only', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 10);
    const load = vi.fn();

    // No consumerPinsResult: the result card renders `partial` as an explicit
    // best-effort caveat (CLAUDE.md), so a fresh partial is the right answer.
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result).toEqual(truncated);
  });
});

// A RELEASED answer is terminal: which release first contains a commit cannot
// change, which is why `isFresh()` treats it as fresh forever and `hardTtlFor()`
// gives it a 30-day TTL. `MAX_STALE_PINNED` exists for the opposite case — a
// "not yet released" prior that has since shipped — so applying its 30-minute
// age bound to a terminal answer discards exactly the warm entries `/internal/*`
// joined the public key to reuse (#143), and pays a full findRelease on the
// crawler's critical path for every unfurl more than 30 minutes after the last
// write.
describe('resolveLookup — a terminal RELEASED prior stays pinnable at any age', () => {
  it('fresh exit: serves a 2h-old released prior instead of recomputing', async () => {
    const f = makeFakeCache();
    const released = mkResult({ released: true });
    f.seed(KEY, released, 2 * 60 * 60); // the normal state of a 30-day slot
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.cached).toBe(true);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
  });

  it('back-off exit: an upstream outage still serves the 2h-old released prior', async () => {
    const f = makeFakeCache();
    const released = mkResult({ released: true });
    f.seed(KEY, released, 2 * 60 * 60);
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    // Without the terminal exemption this returns `transient`, which web-og
    // renders as the neutral placeholder at max-age=60 — and each unfurl during
    // the outage runs its own lookup out to the soft deadline against the down
    // host.
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('a 2h-old NOT-YET-released prior is still unpinnable — the bound it exists for', async () => {
    const f = makeFakeCache();
    const notYet = mkResult({ released: false });
    f.seed(KEY, notYet, 2 * 60 * 60);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });
});

// Round 15. Two defects the SHARED key introduced, both invisible to a test that
// looks only at what a single caller is handed back: the key is shared with
// badge.ts and the permalink pages, so what /internal writes to it — the entry's
// TTL, and the negative marker's age — is imposed on THEM.
describe('resolveLookup — a pinning caller does not rewrite the SHARED slot for everyone else', () => {
  const HARD_TTL_RELEASED = 30 * 24 * 60 * 60;
  const HARD_TTL_PARTIAL = 60;

  const galloped = () => mkResult({ released: true, partial: true });

  it('writes a gallop partial on the caller-independent TTL, not its own 60s throttle', async () => {
    const f = makeFakeCache();
    const load = vi.fn().mockResolvedValue(galloped());

    await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
      bypassBackOffWhenUnservable: true,
    });

    // The ENTRY keeps hardTtlFor()'s terminal branch — the same value a public
    // page view writes — so an unfurl cannot shorten the permalink's month-long
    // slot to a minute. Writing HARD_TTL_PARTIAL here reddens this.
    expect(f.puts.find((p) => p.key === KEY)?.ttlSeconds).toBe(HARD_TTL_RELEASED);
    // The caller's own distrust of the partial rides on the marker instead.
    expect(f.puts.find((p) => p.key === pinPartialKey)?.ttlSeconds).toBe(HARD_TTL_PARTIAL);
  });

  it('a public caller and a pinning caller write the IDENTICAL entry TTL', async () => {
    const pub = makeFakeCache();
    const pin = makeFakeCache();
    const load = vi.fn().mockResolvedValue(galloped());

    await resolveLookup({ cache: pub.cache, key: KEY, load });
    await resolveLookup({
      cache: pin.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
      bypassBackOffWhenUnservable: true,
    });

    const ttlOf = (f: ReturnType<typeof makeFakeCache>) =>
      f.puts.find((p) => p.key === KEY)?.ttlSeconds;
    expect(ttlOf(pin)).toBe(ttlOf(pub));
  });

  it('still recomputes its OWN partial once the marker has expired', async () => {
    const f = makeFakeCache();
    // A 30-day entry sitting in the slot, and a marker that has aged out.
    f.seed(KEY, galloped(), 5 * 60);
    f.seed(pinPartialKey, { pinnedPartial: true }, HARD_TTL_PARTIAL + 1);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
      bypassBackOffWhenUnservable: true,
    });

    // The longer entry TTL must not make a stale partial servable: the throttle
    // reads the MARKER. Making shouldRecompute trust the entry reddens this.
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.partial).toBeUndefined();
  });

  it('does NOT re-stamp a negative marker it bypassed — the humans keep their clock', async () => {
    const f = makeFakeCache();
    // An outage: a page view failed 55s ago, so the shared marker is 5s from
    // expiring and a human is 5s from their next real attempt.
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 55);
    const load = vi.fn().mockRejectedValue(new ProviderServerError('gitlab.gnome.org', 503, 'x'));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
      bypassBackOffWhenUnservable: true,
    });

    // The bypass still ran the load (that is its whole point)...
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('transient');
    // ...but left the marker's age alone. Removing the `!backedOff` guard reddens
    // this: the marker is rewritten at age 0 and the human's window restarts,
    // which under a once-a-minute unfurl cadence never lets it expire at all.
    expect(f.puts.some((p) => p.key === negKey)).toBe(false);
    expect(f.get(negKey)?.ageSeconds).toBe(55);
  });

  it('DOES stamp the marker when the slot was cold — the back-off still exists', async () => {
    const f = makeFakeCache();
    const load = vi.fn().mockRejectedValue(new ProviderServerError('gitlab.gnome.org', 503, 'x'));

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
      bypassBackOffWhenUnservable: true,
    });

    expect(r.status).toBe('transient');
    // Suppressing the write unconditionally would leave the key with NO back-off
    // whenever the crawler touches it first, and every human reload would pound
    // the down host. Guarding on `backedOff` keeps this arm live.
    expect(f.puts.some((p) => p.key === negKey)).toBe(true);
  });
});
