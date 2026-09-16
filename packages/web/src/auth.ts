// Web auth: resolves the provider API token used for an outbound API call.
// Precedence per provider:
//   GitHub: X-User-Github-Token header > GITHUB_TOKEN secret > none
//   GitLab: X-User-Gitlab-Token header > GITLAB_TOKEN_<HOST> secret > none
//           (GITLAB_TOKEN is gitlab.com's PAT and is ONLY used for gitlab.com —
//            a per-instance PAT must never be sent to a different GitLab host)
// Also implements same-origin Origin-header check as defense-in-depth on /api/*.

import type { Env } from './env.js';

/** Pick the token to use for outbound GitHub calls for this request. */
export function resolveToken(env: Env | undefined, req: Request): string | undefined {
  const userPat = req.headers.get('x-user-github-token');
  if (userPat?.trim()) return userPat.trim();
  if (env?.GITHUB_TOKEN?.trim()) return env.GITHUB_TOKEN.trim();
  return undefined;
}

/** True when the caller brought their own provider token (either header). Such a
 *  lookup may be a private repo's answer, so it must stay out of the anonymous
 *  shared result cache (#164). Blank headers are ignored, as in the resolvers. */
export function hasUserToken(req: Request): boolean {
  return Boolean(
    req.headers.get('x-user-github-token')?.trim() ||
      req.headers.get('x-user-gitlab-token')?.trim(),
  );
}

/** Resolve a provider API token for a given host. Honors per-host Worker secrets
 *  (GITLAB_TOKEN_<HOST>) so different self-hosted GitLab instances can use
 *  different PATs. */
export function resolveProviderToken(
  env: Env | undefined,
  req: Request,
  host: string,
): string | undefined {
  if (host === 'github.com') return resolveToken(env, req);
  // GitLab path
  const userPat = req.headers.get('x-user-gitlab-token');
  if (userPat?.trim()) return userPat.trim();
  if (env) {
    const hostKey = `GITLAB_TOKEN_${host.toUpperCase().replace(/[.-]/g, '_')}` as const;
    const hostSecret = (env as Record<string, string | undefined>)[hostKey];
    if (hostSecret?.trim()) return hostSecret.trim();
    // GITLAB_TOKEN is gitlab.com's PAT. Only send it to gitlab.com — forwarding
    // it to another instance leaks the secret and 401s (PATs are instance-scoped).
    if (host === 'gitlab.com' && env.GITLAB_TOKEN?.trim()) return env.GITLAB_TOKEN.trim();
  }
  return undefined;
}

/** Parse EXTRA_GITLAB_HOSTS env var into a string[] (trimmed, empty entries dropped). */
export function extraGitlabHostsFromEnv(env: Env | undefined): readonly string[] {
  const raw = env?.EXTRA_GITLAB_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Returns true if the request's Origin matches the worker's own origin (same-origin)
 *  or the request has no Origin header (which is the case for server-to-server,
 *  curl, and unfurl bots). Returns false ONLY when a cross-origin browser is
 *  trying to call /api/*. */
export function checkSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // not a browser cross-origin call
  try {
    const reqUrl = new URL(req.url);
    const originUrl = new URL(origin);
    return reqUrl.origin === originUrl.origin;
  } catch {
    return false;
  }
}

/** User-Agent allowlist for unfurl bots (Slackbot, Twitterbot, etc.).
 *  These get the special deferred-render card on cache miss with no budget. */
const UNFURL_BOTS = [
  /Slackbot/i,
  /Twitterbot/i,
  /facebookexternalhit/i,
  /LinkedInBot/i,
  /Discordbot/i,
  /TelegramBot/i,
];

export function isUnfurlBot(req: Request): boolean {
  const ua = req.headers.get('user-agent');
  if (!ua) return false;
  return UNFURL_BOTS.some((re) => re.test(ua));
}

// The loop's synthetic liveness probe (bin/liveness-probe.mjs) drives real
// end-to-end lookups every cycle to exercise CUJ #1. Those lookups hit the same
// public routes a visitor would, so without a marker they're indistinguishable
// from real traffic — and when one trips the soft deadline against unauthenticated
// GitHub it lands in Analytics Engine as a `lookup_timeout` SYSTEM error, polluting
// the very error history the loop reads back to decide if the app is healthy. The
// probe self-identifies by user-agent; we read it here only to derive a boolean
// marker (recorded as analytics blob12) — the UA string itself is never stored, so
// the privacy posture is unchanged. Keep this prefix in sync with the `ua` default
// in bin/liveness-probe.mjs (`liveapp-liveness-probe/<n>`).
export function isLivenessProbe(req: Request): boolean {
  return req.headers.get('user-agent')?.startsWith('liveapp-liveness-probe/') ?? false;
}
