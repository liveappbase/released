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
//      A caller whose consumer asks only ONCE can opt out of the cold half of
//      that (`bypassBackOffWhenUnservable`) — backing off is cheap for a page a human
//      can reload and permanent for a crawler that unfurls once.
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
// Upper bound on the age of a prior we will hand to a consumer that PINS what we
// give it. web-og long-caches any non-null result for 24h (renderImage:
// `result ? longCache : shortCache`), so an answer served to it is stuck in the
// crawler's cache for a day and no later refresh can invalidate a PNG already
// rendered from it — a "not yet released" prior that has since shipped would
// show the wrong card until tomorrow. 30 minutes is what /internal used as its
// flat TTL before it shared this 24h slot, so bounding is never worse than the
// code it replaced.
//
// It bounds EVERY exit that hands back a prior. Sharing the 24h slot is exactly
// what made a 23h-old prior possible on the /internal path (`consumerPinsResult`,
// set by the OG route): before it, that route had a flat 30-minute TTL of its own
// and an entry that old could not exist. Public HTML
// routes leave the flag unset and keep stale-if-error UNBOUNDED: a human sees an
// explicit "stale as of" caveat and can reload, and their answer is not pinned
// anywhere, so serving through a long outage is the right degrade for them.
const MAX_STALE_PINNED = 30 * 60;

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

type PinnedPartialMarker = { pinnedPartial: true };
type NegMarker = { transient: true; kind: string; status?: number; anubis?: boolean };
function negKey(key: string): string {
  return `${key}:neg`;
}

/** Companion marker for `${key}`, written ONLY when a `consumerPinsResult`
 *  caller computed a partial itself. The result slot is shared across callers
 *  that do not agree on a soft deadline, so the entry alone cannot say whose
 *  truncation produced it; this marker can, and it expires on its own after
 *  `HARD_TTL_PARTIAL`. */
function partialKey(key: string): string {
  return `${key}:pinpartial`;
}

/** True when `mark` was written no earlier than `entry`.
 *
 *  Compare the STORED `x-cached-at` stamps, not the two `ageSeconds` values.
 *  `cache.getEntry` floors each age from a `Date.now()` sample taken when THAT
 *  entry was read, and the two reads are one Cache API round trip apart, so the
 *  floors can straddle a second boundary and invert the ordering for a pair that
 *  really was written entry-then-marker:
 *
 *      entry  stamped t=1000ms, read at 2990ms -> floor(1990/1000) = 1
 *      marker stamped t=1010ms, read at 3015ms -> floor(2005/1000) = 2
 *
 *  `2 <= 1` is false, so the caller would disown its own 2-second-old partial and
 *  run another full traversal — precisely the traversal this throttle exists to
 *  avoid, on the deadline-blowing repos it exists for. The write-time stamps say
 *  1010 >= 1000, which is the quantity the guard actually reasons about.
 *
 *  With either stamp missing (an entry written by a version that predates the
 *  `x-cached-at` header, or one whose header an intermediary dropped) the
 *  ordering is unprovable, so this says no and the partial is recomputed.
 *
 *  It deliberately does NOT fall back to comparing the two `ageSeconds`. That
 *  reads as the conservative choice and is the opposite of one: `cache.getEntry`
 *  reports `ageSeconds: 0` for an unstamped entry (cache.ts:65-66), so an
 *  unstamped pair evaluated `0 <= 0` -> true and the marker vouched for the entry
 *  unconditionally — someone else's truncation trusted rather than recomputed.
 *  Unreachable in production, where every write goes through
 *  `makeWorkerCache.put` and is stamped; reachable from a seeded fixture, which
 *  is exactly where a claim like this one gets believed. */
function writtenNoEarlierThan(mark: CacheEntry<unknown>, entry: CacheEntry<unknown>): boolean {
  if (mark.stampedAt === null || entry.stampedAt === null) return false;
  return mark.stampedAt >= entry.stampedAt;
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
  /** Opt-in for callers whose consumer only ever asks ONCE, so a soft failure
   *  becomes permanent for them (the OG crawler). When set, the shared negative
   *  back-off marker is honoured only if there is a prior we can actually SERVE
   *  — with nothing servable, an attempt beats handing back a placeholder that
   *  gets cached forever. A bypassed attempt that then FAILS does not re-stamp
   *  the marker (`!backedOff`, see the catch below), so opting in never resets
   *  the clock the public routes read; a failure on the ordinary path still
   *  writes it. Callers that can retry (the public HTML routes) omit this flag
   *  and keep backing off.
   *
   *  Be honest about the reachable behaviour. The only caller that sets this also
   *  sets `consumerPinsResult`, and `findRelease` emits just two entry shapes:
   *  TERMINAL (fresh forever, so it returns at the fresh exit above) and PARTIAL
   *  (handed back inside its own 60s throttle, recomputed after). Neither can reach the stale-serve on
   *  the back-off line below, so on that path the bypass is UNCONDITIONAL, not
   *  cold-only. That is accepted, not overlooked: a crawler asks once, so the
   *  alternative is a placeholder pinned long after the host recovers, and the
   *  cost is the unthrottled load documented at the fall-through. The
   *  `prior && !shouldRecompute(prior)` stale-serve is live for the public routes,
   *  which do not set either flag. */
  bypassBackOffWhenUnservable?: boolean;
  /** Opt-in for callers whose consumer CACHES whatever we hand back, for longer
   *  than we can correct (the OG crawler pins a rendered PNG for 24h).
   *
   *  What it does TODAY is entirely the PARTIAL handling at `shouldRecompute`
   *  below: someone else's truncated traversal is recomputed rather than served,
   *  and one this caller itself produced within `HARD_TTL_PARTIAL` is handed back
   *  so the caller can refuse it (internal.ts:285) without paying another
   *  traversal. A TERMINAL answer is servable at any age and is deliberately
   *  outside every bound. Refusing to PIN a partial is the caller's own job, not
   *  this flag's.
   *
   *  It ALSO bounds a PENDING prior (no `firstRelease`, no `partial`) at
   *  `MAX_STALE_PINNED`, so a day-old "not yet released" that has since shipped is
   *  never handed to a pinning consumer. Be honest about that arm: `findRelease`
   *  cannot currently emit that shape — its three value returns are the gallop hit
   *  (`find-release.ts:299`, always `partial`), the soft-deadline miss (`:316`,
   *  always `partial`) and the terminal answer (`:391`); a genuine "not yet
   *  released" is THROWN (`:326`) and `resolve.ts` returns it as `status:
   *  'not_yet'` without ever calling `cache.put`. So no PENDING entry exists to
   *  bound, and the arm is a defensive guard on a shape the TYPE permits (core
   *  keeps a matching fallback at `:486`), not a live protection. The failure it
   *  is named for is real but is fixed elsewhere: the 24h pin of a fresh answer is
   *  #151, and the `not_yet` 503 is #150. Do not read this bound as covering the
   *  OG path. (`HARD_TTL_PENDING` and `FRESH_WINDOW_PENDING` are dead for the same
   *  reason, and predate this PR.) */
  consumerPinsResult?: boolean;
  /** Override the in-isolate single-flight key, which otherwise IS `key`.
   *
   *  `singleFlight` hands every joiner the FIRST registrant's promise and runs
   *  only that owner's `load`, so two callers sharing a key also share a loader —
   *  including its deadlines. Callers on this same cache slot do not agree on
   *  those: badge.ts runs an 8s/9s findRelease so a slow repo returns a
   *  short-cached "checking…", while the permalink and /internal callers run the
   *  24s/28s defaults. Sharing a slot is deliberate (that is the whole point of a
   *  common key); sharing a TRUNCATION is not, so a caller whose consumer cannot
   *  caveat a partial passes its own flight key and always runs its own lookup.
   *  Concurrent calls from that same caller still collapse into one. */
  flightKey?: string;
}): Promise<Resolved> {
  const { cache, key, load, bypassBackOffWhenUnservable, consumerPinsResult } = args;
  const flightKey = args.flightKey ?? key;
  const now = args.now ?? Date.now;

  const prior = await cache.getEntry<LookupResult>(key);

  /** True when the partial in the slot is one THIS caller computed less than
   *  `HARD_TTL_PARTIAL` ago — the only case the throttle below is allowed to
   *  honour.
   *
   *  Aligning the key put `/internal` on the same slot as badge.ts and the
   *  permalink pages, and those callers do not agree on a soft deadline
   *  (badge.ts runs 8s/9s, everyone else 24s/28s). Round 11 stopped the
   *  truncation travelling through the in-isolate FLIGHT (`flightKey`); this
   *  stops it travelling through the CACHE, which is the same hole one hop
   *  later. Without it: a README badge on `/i/kubernetes/kubernetes/12345`
   *  makes camo fetch `badge.svg`, badge.ts's 8s deadline truncates and writes
   *  a partial to the byte-identical key, and an unfurl ten seconds later reads
   *  that partial as "recent", 503s it, and Slack pins the neutral placeholder
   *  — on a link where this route's own 24s deadline finds the answer. On
   *  `main` that could not happen, because /internal keyed on a key of its own.
   *
   *  Read once, here, and only when there IS a prior partial to throttle, so
   *  the common paths pay no extra cache read. `run()`'s re-read uses the same
   *  value: a partial that appeared in between is by definition not one this
   *  call throttled, and recomputing it is the safe direction. */
  let ownRecentPartial = false;
  if (consumerPinsResult && prior?.value.partial) {
    const mark = await cache.getEntry<PinnedPartialMarker>(partialKey(key));
    ownRecentPartial =
      mark?.value?.pinnedPartial === true &&
      mark.ageSeconds < HARD_TTL_PARTIAL &&
      // ...and the marker has to actually IDENTIFY the entry it vouches for, not
      // merely be young. `run()` writes the slot first and the marker second, so
      // for a pair this caller produced the marker can never be OLDER than the
      // entry. When it is, the slot was overwritten AFTER we marked it — by a
      // caller on the same key with a different deadline (badge.ts, 8s) — so the
      // partial sitting there is someone else's truncation wearing our marker.
      // Recompute it, which is exactly what the marker exists to make possible.
      writtenNoEarlierThan(mark, prior);
  }

  /** True when a cached entry must NOT be served to this caller and the lookup
   *  has to run again. Named for what it decides, not for pinning-safety: it is
   *  NOT the invariant "this entry may be pinned". A pinning caller still has to
   *  make its own call on what it does with a partial it is handed — see the
   *  refusal at internal.ts:285 — because inside the throttle window below this
   *  predicate deliberately returns false for one. Always false for callers that
   *  did not opt in, so the public HTML routes are unchanged. */
  const shouldRecompute = (entry: CacheEntry<LookupResult>): boolean => {
    if (!consumerPinsResult) return false;
    // TERMINAL (`firstRelease`, no `partial`) — always servable, at any age.
    // Which release first contains a commit cannot change, which is why
    // `isFresh()` treats it as fresh forever and `hardTtlFor()` keeps it 30
    // days. `MAX_STALE_PINNED` exists for the opposite case, a "not yet
    // released" prior that has since shipped; applying it here would discard
    // exactly the warm entries this route joined the public key to reuse,
    // paying a full findRelease per unfurl.
    if (entry.value.firstRelease && !entry.value.partial) return false;
    // PARTIAL (either shape) — a truncated traversal. With `firstRelease: null`
    // it means "we stopped looking", which web-og renders as a definite "not yet
    // released"; WITH a `firstRelease` it carries the gallop hit, and the bisect
    // that would confirm no EARLIER release contains the commit is what the
    // deadline cut short (find-release.ts:288-292). The result card renders that
    // caveat, web-og cannot. So the caller must refuse to PIN either shape — but
    // recomputing one this caller itself produced under its OWN deadline, within
    // its 60s TTL, would only reproduce it, so inside that window we hand it back
    // (the caller 503s it into a short-cached placeholder) instead of running a
    // full traversal on the shared token for every crawler. Someone ELSE's
    // partial earns no such trust: recompute it.
    if (entry.value.partial) return !ownRecentPartial;
    // PENDING (no `firstRelease`, no `partial`) — bounded by `MAX_STALE_PINNED`:
    // an answer older than that may have shipped since, and a PNG already
    // rendered from it cannot be invalidated. DEFENSIVE ONLY: `findRelease` emits
    // no such entry today (a real "not yet released" is thrown, never cached — see
    // the `consumerPinsResult` doc above), so this line does not fire in
    // production. It stays because the TYPE permits the shape and core keeps a
    // fallback branch that would return it (`find-release.ts:486`); it must not be
    // read as the bound that protects the OG path.
    return entry.ageSeconds >= MAX_STALE_PINNED;
  };
  if (prior && isFresh(prior) && !shouldRecompute(prior)) {
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
    if (prior && !shouldRecompute(prior)) return staleHit();
    if (!bypassBackOffWhenUnservable) {
      return {
        status: 'transient',
        kind: neg?.value.kind ?? 'provider_server_error',
        upstreamStatus: neg?.value.status,
        anubis: neg?.value.anubis,
      };
    }
    // Cold + opted out: fall through and attempt the load. This is NOT throttled.
    // singleFlight collapses only CONCURRENT calls, and only inside ONE isolate
    // (see its header), so during a host outage every cold unfurl — a different
    // colo, a different social platform, or simply a later one — runs its own
    // findRelease out to the hard deadline against the down host and re-stamps
    // the marker. NEG_TTL throttles the human page views on this key, not this
    // path. That cost is accepted deliberately: the crawler asks ONCE, so the
    // alternative is a placeholder pinned in its cache long after the host
    // recovers. Gating the bypass on a fraction of NEG_TTL would only move which
    // unfurls get the permanent placeholder, not stop them.
    //
    // What it must NOT also cost is the humans' recovery window. A bypassed load
    // that fails does NOT re-stamp the marker (see the catch below): re-stamping
    // would reset the age that the callers who DO honour the marker — the public
    // HTML routes, on this same shared key — read, so under a steady crawler
    // cadence (a link circulating on Slack unfurls roughly once a minute) the
    // marker would never reach NEG_TTL and a human would sit on the "checking..."
    // card for the whole outage rather than getting a fresh attempt each minute.
    // The marker now ages out on its own clock, as it does on `main`, where
    // /internal kept a negative marker of its own. #157 tracks the wider question
    // of what the unthrottled bypass should cost; this is the half the shared key
    // introduced.
  }

  try {
    const run = async () => {
      const re = await cache.getEntry<LookupResult>(key);
      if (re && isFresh(re) && !shouldRecompute(re)) return re.value;
      const r = await load();
      // The ENTRY's TTL is the caller-independent one, always. This slot is SHARED
      // with badge.ts and the permalink pages, so a TTL picked to suit this caller
      // is silently imposed on theirs. `hardTtlFor()` puts a gallop partial
      // (`firstRelease` set + `partial: soft_deadline`) on the terminal 30-day
      // branch; writing HARD_TTL_PARTIAL here instead would drop the PUBLIC routes'
      // effective TTL on that shape from 30 days to 60 seconds for as long as a
      // link is being unfurled — one OG unfurl replacing the month-long entry a
      // human page view just wrote, so the next page view pays another full
      // traversal and issue.tsx/pr.tsx's bot branch (`if (!cached) return
      // renderDeferred(...)`) falls back to the deferred card off a slot that was
      // warm a minute ago. That misclassification is a real defect — it is just not
      // this caller's to fix on someone else's entry. It is tracked in #155/#159,
      // and the public routes' semantics are deliberately untouched here.
      //
      // Be explicit about what this PR does change, which is not the
      // misclassification but WHO can trigger it. On `main` /internal keyed on a
      // key of its own, so only a human page view or a badge fetch could write a
      // gallop partial into the shared slot. Sharing the key makes an UNFURL a
      // writer of it: one Slack post of a deadline-blowing repo can now pin
      // `badge.svg` and the permalink to an unconfirmed gallop tag — rendered
      // with no caveat, because a badge has nowhere to put one — for the full 30
      // days, and each further unfurl restarts that clock. Accepting it here is a
      // scope call, not a claim that it is harmless: the fix belongs in
      // `hardTtlFor()`/`isFresh()`, on the public routes' side, where #155/#159
      // can be reviewed as the behaviour change to those routes that it is.
      //
      // What THIS caller needs — never trusting a partial for longer than
      // HARD_TTL_PARTIAL — rides on the companion marker below instead. The marker
      // is caller-private and expires on its own clock, and `shouldRecompute` reads
      // the MARKER, never the entry's TTL, so the 60s throttle window is exactly
      // what it was.
      const pinnedPartial = Boolean(consumerPinsResult && r.partial);
      await cache.put(key, r, hardTtlFor(r));
      // Record WHOSE truncation this was, so the throttle above honours it only for
      // this caller, and for no longer than HARD_TTL_PARTIAL. The entry may now
      // outlive the marker (a gallop partial keeps hardTtlFor's 30 days); that is
      // the safe direction — no marker means `ownRecentPartial` is false and the
      // partial is recomputed rather than served to a pinning consumer.
      if (pinnedPartial) {
        await cache.put(partialKey(key), { pinnedPartial: true }, HARD_TTL_PARTIAL);
      }
      return r;
    };
    const result = await singleFlight(flightKey, run);
    return { status: 'ok', result, stale: false, staleAsOf: null, cached: false };
  } catch (err) {
    if (err instanceof NotYetReleasedError) return { status: 'not_yet', error: err };
    if (isTransientError(err)) {
      // Throttle the next retry, then serve last-known-good if we have it.
      const upstreamStatus = upstreamStatusOf(err);
      const anubis = err instanceof ProviderJsonError && err.looksLikeAnubis;
      // ...but never re-stamp a marker this call walked straight past. `backedOff`
      // is still true here only on the bypass fall-through above, which means the
      // marker was already warm and this caller ignored it. Writing it again resets
      // its age for everyone reading the shared key, which is what would starve the
      // public routes' retry window (see the fall-through comment). Skipping the
      // write costs this caller nothing — it does not read the marker on this path,
      // and the warm marker it bypassed already records the host as down.
      if (!backedOff) {
        await cache.put(
          negKey(key),
          { transient: true, kind: err.kind, status: upstreamStatus, anubis },
          NEG_TTL,
        );
      }
      if (prior && !shouldRecompute(prior)) return staleHit();
      return { status: 'transient', kind: err.kind, upstreamStatus, anubis };
    }
    return { status: 'error', error: err };
  }
}
