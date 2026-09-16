// POST /api/lookup — single lookup. Used by client.js after form submit.
// Wraps findRelease with the in-isolate single-flight guard and the Cloudflare
// Cache API for cross-request reuse.

import {
  cacheKey,
  findRelease,
  type LookupInput,
  type LookupResult,
  type Provider,
  parseInput,
  ReleasedError,
} from '@released/core';
import type { Context } from 'hono';
import { setTrack, upstreamStatusOf } from '../analytics.js';
import { checkSameOrigin } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { singleFlight } from '../single-flight.js';

export async function lookupRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;

  // CSRF defense-in-depth: only same-origin (or server-to-server, no Origin).
  if (!checkSameOrigin(req)) {
    return new Response(JSON.stringify({ error: 'cross_origin' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { input?: string; ref?: string; strict?: boolean; includePrereleases?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonErr('invalid_body', 400);
  }
  if (!body.input || typeof body.input !== 'string') return jsonErr('missing_input', 400);
  const strict = body.strict === true;
  const includePrereleases = body.includePrereleases === true;

  let parsed: LookupInput;
  try {
    parsed = parseInput(body.input, body.ref);
  } catch (err) {
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
    return errorResponse(err);
  }
  setTrack(req, { host: parsed.repo.host, repo: parsed.repo.projectPath, kind: parsed.kind });

  let client: Provider;
  try {
    client = makeProvider(env, req, parsed.repo.host);
  } catch (err) {
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
    return errorResponse(err);
  }
  const cache = makeWorkerCache(req);
  // Mode-specific cache key so default / strict / +prereleases don't clobber.
  // Key includes host so github.com/foo/bar and gitlab.com/foo/bar don't collide.
  const k = await cacheKey(
    'res',
    `${parsed.repo.host}/${parsed.repo.projectPath}`,
    parsed.kind === 'pr'
      ? `pr#${parsed.number}`
      : parsed.kind === 'issue'
        ? `issue#${parsed.number}`
        : `sha:${parsed.sha}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );

  const cached = await cache.get<LookupResult>(k);
  if (cached) {
    setTrack(req, {
      cache: 'hit',
      outcome: cached.partial ? 'partial' : cached.firstRelease ? 'released' : 'not_yet',
    });
    return new Response(JSON.stringify({ result: cached, cacheHit: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  setTrack(req, { cache: 'miss' });

  try {
    const compute = async () => {
      // Within the flight, re-check cache to avoid duplicate compute under races.
      const reCached = await cache.get<LookupResult>(k);
      if (reCached) return reCached;
      const r = await findRelease(parsed, { client, strict, includePrereleases });
      // Don't cache partial (soft-deadline) results for the full 30min — that
      // would lock in a "didn't finish" answer. Short-cache (60s) so retries
      // see fresh state quickly. Successful results: full 30min.
      const ttl = r.partial ? 60 : 30 * 60;
      await cache.put(k, r, ttl);
      return r;
    };
    // A user-token lookup must not share a flight with an anonymous one (#164).
    const result = cache.shared ? await singleFlight(k, compute) : await compute();
    setTrack(req, {
      outcome: result.partial ? 'partial' : result.firstRelease ? 'released' : 'not_yet',
    });
    return new Response(JSON.stringify({ result, cacheHit: false }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ReleasedError) {
    const status = statusFor(err.kind);
    return new Response(JSON.stringify({ error: err.kind, message: err.message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({ error: 'internal', message: (err as Error)?.message ?? 'unknown' }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function jsonErr(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function statusFor(kind: string): number {
  switch (kind) {
    case 'non_github_url':
    case 'unsupported_host':
    case 'invalid_input':
    // A bare SHA with no repo is a client input error, not a server fault —
    // without this it fell through to the 500 default (verified on prod).
    case 'bare_sha':
    case 'bulk_limit':
      return 400;
    case 'pr_not_merged':
    case 'pr_not_found':
    case 'pr_merge_commit_unavailable':
    case 'commit_not_found':
    case 'no_releases':
    case 'not_yet_released':
    // Issue-input outcomes are the same "resolved, but no release answer"
    // family as their PR/commit siblings above — not server faults. Without
    // these cases they fell through to the 500 default (see #54).
    case 'issue_not_found':
    case 'issue_not_closed':
    case 'issue_closed_without_fix':
      return 404;
    case 'ambiguous_sha':
      return 422;
    case 'rate_limit':
      return 429;
    case 'github_server_error':
    case 'provider_server_error':
    case 'provider_json_error':
    case 'network_error':
    case 'lookup_timeout':
      return 503;
    default:
      return 500;
  }
}
