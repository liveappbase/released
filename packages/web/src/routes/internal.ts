// Service-Binding-only endpoints (D23) that feed the web-og PNG renderer.
//   GET /internal/result/:owner/:repo/:sha     — GitHub (legacy/canonical)
//   GET /internal/h/:host/r/:projectPath/:sha  — federated (any host, #12)
// web-og calls these via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.

import { cacheKey, findRelease, type LookupInput, type LookupResult } from '@released/core';
import type { Context } from 'hono';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { singleFlight } from '../single-flight.js';

/** Marker header set by the web-og Service Binding to identify itself.
 *  Cloudflare Service Binding requests can also be checked via the routing
 *  metadata; we use a shared-secret-style marker as an extra guard for v1. */
const SVC_HEADER = 'x-released-internal';

/** True when the caller presented the Service-Binding marker secret.
 *  Fails CLOSED when INTERNAL_SECRET is unset: a missing secret must DENY,
 *  never fall back to a guessable default (the legacy 'web-og' constant), or
 *  /internal/* would open to anyone who guesses it. Prod and `wrangler dev`
 *  (via .dev.vars) always set it; set with `wrangler secret put INTERNAL_SECRET`,
 *  matching web-og's. */
function isServiceBinding(c: Context): boolean {
  const env = (c.env ?? {}) as Env;
  const secret = env.INTERNAL_SECRET;
  if (!secret) return false;
  const marker = c.req.raw.headers.get(SVC_HEADER);
  return !!marker && marker === secret;
}

/** Resolve the LookupResult JSON for a lookup input. Cache-first, then compute
 *  via the (relay-aware) provider. Host-aware cache key so OG renders share slots
 *  with the public routes' `${host}/${projectPath}` prefix; the input kind+id
 *  distinguishes the slot (`sha:` / `issue:` / `pr:`), mirroring the commit
 *  endpoint's `sha:${sha}` scheme. */
async function resolveResult(c: Context, input: LookupInput): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const { host, projectPath } = input.repo;

  const idPart = input.kind === 'commit' ? `sha:${input.sha}` : `${input.kind}:${input.number}`;
  const k = await cacheKey('res', `${host}/${projectPath}`, idPart);
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);
  if (result) {
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Cache miss: compute. The web-og caller chose to wait for this on its side.
  // Anubis-protected hosts get a relay-backed fetch (see makeProvider/relay.ts).
  try {
    const client = makeProvider(env, req, host);
    const compute = async () => {
      const re = await cache.get<LookupResult>(k);
      if (re) return re;
      const r = await findRelease(input, { client });
      await cache.put(k, r, 30 * 60);
      return r;
    };
    // A user-token lookup must not share a flight with an anonymous one (#164).
    result = cache.shared ? await singleFlight(k, compute) : await compute();
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error)?.message ?? 'failed' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** Parse a permalink :number param into a positive int, or null if invalid. */
function parseNumber(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET /internal/result/:owner/:repo/:sha — GitHub-only (legacy/canonical). */
export async function internalResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/h/:host/r/:projectPath/:sha — federated (any host, #12).
 *  projectPath is URL-encoded into a single segment, matching the /h/ permalink
 *  routes. Hono already percent-decodes c.req.param() (safe try/catch), so do
 *  NOT decodeURIComponent again — that's a redundant double-decode that throws
 *  URIError on a malformed escape (bad%25 → bad% → throws) → HTTP 500. */
export async function internalFederatedResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const sha = c.req.param('sha');
  if (!host || !projectPath || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host, projectPath },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/issue/:owner/:repo/:number — GitHub issue (#79). Resolves the
 *  issue (→ its closing commit(s) → release) so the returned result carries
 *  subject = the issue title, which web-og renders on the title-aware OG card. */
export async function internalIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/pr/:owner/:repo/:number — GitHub PR (#79). Resolves the PR to
 *  its merge commit so subject = the PR title. */
export async function internalPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/h/:host/i/:projectPath/:number — federated issue (#79). */
export async function internalFederatedIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host, projectPath },
    number,
  });
}

/** GET /internal/h/:host/p/:projectPath/:number — federated PR/MR (#79). */
export async function internalFederatedPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host, projectPath },
    number,
  });
}
