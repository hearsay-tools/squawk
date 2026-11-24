import { normalizeHostname } from './capabilities.ts';

/** The bare hostname of a `Host` header — see `normalizeHostname`. `''` when the
 *  header is absent, which no allowlist matches. */
export function hostnameOfHost(host: string | undefined): string {
  return host ? normalizeHostname(host) : '';
}

/** The `hostname:port` authority of a `Host` header, e.g. `127.0.0.1:4321`.
 *
 *  The port is kept verbatim and is `''` when the header omits it — which is
 *  exactly when a browser also omits it from `Origin` (both drop the scheme's
 *  default port). That symmetry is what lets us compare the two without knowing
 *  our own scheme, which we cannot know behind a TLS-terminating proxy. */
export function authorityOfHost(host: string | undefined): string {
  if (!host) return '';
  const port = host.match(/^\[[^\]]*\]:(\d+)$/)?.[1] ?? host.match(/^[^:]*:(\d+)$/)?.[1] ?? '';
  return `${normalizeHostname(host)}:${port}`;
}

/** The `hostname:port` authority of an `Origin` header, or `null` when it is not
 *  a parseable http(s) URL (the opaque `"null"` origin of a sandboxed iframe, a
 *  `file://` page). `URL.port` is `''` for a scheme's default port, matching
 *  `authorityOfHost`. */
export function authorityOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${normalizeHostname(u.hostname)}:${u.port}`;
  } catch {
    return null;
  }
}

/** The hostname of an `Origin` header, or `null` when it is not a parseable URL
 *  (e.g. the opaque `"null"` origin of a sandboxed iframe). Normalized through
 *  the same path as `hostnameOfHost` so the two compare equal for IPv6 and for
 *  trailing-dot FQDNs. */
export function hostnameOfOrigin(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname);
  } catch {
    return null;
  }
}
