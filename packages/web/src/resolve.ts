// Stale-if-error resolver — the cache policy that keeps a badge/permalink from
// flipping to "unknown" the moment an upstream host has a blip.
//
// Three ideas, all keyed off the same cached LookupResult the routes already use:
//
//   1. Terminal answers never expire. A "released" result (the first release
//      containing a commit) can never change, so once cached we serve it forever
//      and never touch upstream again — an outage can't erase it.
//   2. Stale-if-error. For non-terminal answers we keep a long HARD ttl but a
//      short freshness window. Past the window we try to revalidate; if upstream
//      is down we serve the last-known-good answer (marked stale) instead of an
//      error.
//   3. Don't hammer a down host. A transient failure writes a short-lived
//      "negative" marker; while it's warm we skip the upstream call entirely
//      (serving stale if we have it, otherwise a soft "checking…" transient).
//
// "not yet released" is a thrown NotYetReleasedError (not a cacheable result),
// so it surfaces as its own status and, during an outage with no prior, degrades
// to a transient ("checking…") rather than a hard error.

import {
  type LookupResult,
  NotYetReleasedError,
  ProviderJsonError,
  ReleasedError,
} from '@released/core';
import { upstreamStatusOf } from './analytics.js';
import type { CacheEntry, WorkerCache } from './cache.js';
import { singleFlight } from './single-flight.js';

// Freshness windows + hard TTLs (seconds).
const FRESH_WINDOW_PENDING = 5 * 60; // re-check non-released answers every 5 min
const HARD_TTL_RELEASED = 30 * 24 * 60 * 60; // terminal — keep ~30 days
const HARD_TTL_PENDING = 24 * 60 * 60; // long enough to stale-serve through an outage
const HARD_TTL_PARTIAL = 60; // partial is itself a soft state; don't trust it long
const NEG_TTL = 60; // back off this long when upstream is down

// Error kinds a later retry might succeed on → eligible for stale-serve (when we
// have a prior) or a short negative cache (when we don't). Everything else is a
// real answer (not found / not merged / unsupported / …) and is surfaced as-is.
const TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  'provider_server_error',
  'github_server_error',
  'provider_json_error',
  'network_error',
  'lookup_timeout',
  'rate_limit',
]);

export function isTransientError(err: unknown): err is ReleasedError {
  return err instanceof ReleasedError && TRANSIENT_KINDS.has(err.kind);
}

function hardTtlFor(r: LookupResult): number {
  if (r.firstRelease) return HARD_TTL_RELEASED;
  if (r.partial) return HARD_TTL_PARTIAL;
  return HARD_TTL_PENDING;
}

function isFresh(entry: CacheEntry<LookupResult>): boolean {
  // A "released" answer is terminal — never stale, never needs upstream again.
  if (entry.value.firstRelease) return true;
  if (entry.value.partial) return entry.ageSeconds < HARD_TTL_PARTIAL;
  return entry.ageSeconds < FRESH_WINDOW_PENDING;
}

type NegMarker = { transient: true; kind: string; status?: number; anubis?: boolean };
function negKey(key: string): string {
  return `${key}:neg`;
}

export type Resolved =
  | {
      status: 'ok';
      result: LookupResult;
      stale: boolean;
      staleAsOf: number | null;
      cached: boolean;
    }
  | { status: 'not_yet'; error: NotYetReleasedError }
  | { status: 'transient'; kind: string; upstreamStatus?: number; anubis?: boolean }
  | { status: 'error'; error: unknown };

/**
 * Resolve a lookup through the cache with stale-if-error semantics.
 * `load` performs the actual (uncached) computation — typically a findRelease().
 */
export async function resolveLookup(args: {
  cache: WorkerCache;
  key: string;
  load: () => Promise<LookupResult>;
  now?: () => number;
}): Promise<Resolved> {
  const { cache, key, load } = args;
  const now = args.now ?? Date.now;

  const prior = await cache.getEntry<LookupResult>(key);
  if (prior && isFresh(prior)) {
    return { status: 'ok', result: prior.value, stale: false, staleAsOf: null, cached: true };
  }

  const staleHit = (): Resolved => ({
    status: 'ok',
    result: (prior as CacheEntry<LookupResult>).value,
    stale: true,
    staleAsOf: now() - (prior as CacheEntry<LookupResult>).ageSeconds * 1000,
    cached: true,
  });

  // Did we try (and fail transiently) very recently? If so, don't pound the
  // upstream again yet — serve the last-known-good if we have one, else a soft
  // transient.
  const neg = await cache.getEntry<NegMarker>(negKey(key));
  const backedOff =
    Boolean(neg?.value?.transient) && (neg?.ageSeconds ?? Number.POSITIVE_INFINITY) < NEG_TTL;
  if (backedOff) {
    if (prior) return staleHit();
    return {
      status: 'transient',
      kind: neg?.value.kind ?? 'provider_server_error',
      upstreamStatus: neg?.value.status,
      anubis: neg?.value.anubis,
    };
  }

  try {
    const compute = async () => {
      const re = await cache.getEntry<LookupResult>(key);
      if (re && isFresh(re)) return re.value;
      const r = await load();
      await cache.put(key, r, hardTtlFor(r));
      return r;
    };
    const result = cache.shared ? await singleFlight(key, compute) : await compute();
    return { status: 'ok', result, stale: false, staleAsOf: null, cached: false };
  } catch (err) {
    if (err instanceof NotYetReleasedError) return { status: 'not_yet', error: err };
    if (isTransientError(err)) {
      // Throttle the next retry, then serve last-known-good if we have it.
      const upstreamStatus = upstreamStatusOf(err);
      const anubis = err instanceof ProviderJsonError && err.looksLikeAnubis;
      await cache.put(
        negKey(key),
        { transient: true, kind: err.kind, status: upstreamStatus, anubis },
        NEG_TTL,
      );
      if (prior) return staleHit();
      return { status: 'transient', kind: err.kind, upstreamStatus, anubis };
    }
    return { status: 'error', error: err };
  }
}
