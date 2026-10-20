// The server binds 127.0.0.1, so the peer address is always loopback. What binding cannot stop is
// a page on another site reaching it through the user's browser: DNS rebinding (a foreign host name
// resolving to 127.0.0.1) and cross-site form or fetch submissions that would start paid runs.
// Every request must therefore name a loopback host, and every state-changing request must come
// from the workbench's own origin.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AccessRequest {
  method: string;
  host: string | null;
  origin: string | null;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; status: 403; reason: string };

function loopbackHost(host: string | null): string | null {
  if (!host) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(host.toLowerCase());
  if (!match?.[1] || !LOOPBACK_HOSTS.has(match[1])) return null;
  return host.toLowerCase();
}

function deny(reason: string): AccessDecision {
  return { allowed: false, status: 403, reason };
}

export function checkLocalAccess(request: AccessRequest): AccessDecision {
  const host = loopbackHost(request.host);
  if (!host) return deny("Host must be a loopback address");
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true };
  // Browsers send Origin on every cross-origin request and on same-origin non-GET fetches, so a
  // missing Origin is treated as untrusted; local scripts must send the workbench origin explicitly.
  if (!request.origin) return deny("State-changing requests require an Origin");
  let origin: URL;
  try {
    origin = new URL(request.origin);
  } catch {
    return deny("Malformed Origin");
  }
  if (origin.protocol !== "http:" || origin.host !== host)
    return deny("Cross-origin state-changing request");
  return { allowed: true };
}

export function accessRequest(request: Request): AccessRequest {
  return {
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
  };
}

/** For route handlers outside the proxy matcher: a 403 response, or null when access is allowed. */
export function rejectNonLocal(request: Request): Response | null {
  const decision = checkLocalAccess(accessRequest(request));
  return decision.allowed
    ? null
    : Response.json({ error: decision.reason }, { status: decision.status });
}
