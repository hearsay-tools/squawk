import { randomUUID } from 'node:crypto';
import type { InstallContext } from '../types.ts';
import { shquote } from '../steps.ts';

/** nginx -v prints its version banner on stderr. Unknown versions use the compatible syntax. */
export function supportsStandaloneHttp2(version: string | null): boolean {
  const match = version && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 1 || (major === 1 && (minor! > 25 || (minor === 25 && patch! >= 1)));
}

export async function installedNginxVersion(ctx: InstallContext): Promise<string | null> {
  const result = await ctx.runner.capture('nginx', ['-v']);
  if (result.code !== 0) return null;
  return /nginx\/(\d+\.\d+\.\d+)/.exec(`${result.stderr}\n${result.stdout}`)?.[1] ?? null;
}

/** Add HTTP/2 only to Certbot's TLS listeners, preserving its trailing comments. */
export function enableHttp2OnTlsListenerSed(vhostPath: string): string {
  const program = `/^[[:space:]]*listen[[:space:]].*443.*[[:space:]]ssl([[:space:]]|;)/{/http2/!s/;/ http2;/;}`;
  return `sed -i -E ${shquote(program)} ${shquote(vhostPath)}`;
}

/** Roll back the file if validation or reload fails; mark only a completed edit. */
export function enableHttp2OnTlsCommand(vhostPath: string, marker: string): string {
  const backup = `${vhostPath}.cezar-http2-${randomUUID()}`;
  return `cp -p ${shquote(vhostPath)} ${shquote(backup)} && ` +
    `if ${enableHttp2OnTlsListenerSed(vhostPath)} && nginx -t && systemctl reload nginx && ` +
    `printf '\n%s\n' ${shquote(marker)} >> ${shquote(vhostPath)}; then ` +
    `rm -f ${shquote(backup)} || true; ` +
    `else cp -p ${shquote(backup)} ${shquote(vhostPath)} && rm -f ${shquote(backup)} && ` +
    `nginx -t && systemctl reload nginx; false; fi`;
}

/**
 * The nginx server block: auth_basic identity + SSE-safe proxy to loopback.
 * `serverName` defaults to the catch-all `_`; the SSL step rewrites it to the
 * real domain so the `certbot --nginx` plugin can find this vhost to edit.
 */
export function nginxVhost(port: number, serverName = '_', htpasswd = '/etc/cezar/htpasswd', nginxVersion: string | null = null): string {
  // Older nginx rejects `http2 on;` outright. Its SSL step adds `http2` to
  // Certbot's TLS listener instead, retaining multiplexing for SSE streams.
  const http2 = supportsStandaloneHttp2(nginxVersion)
    ? `\n    # Multiplex long-lived SSE streams over one TLS connection.\n    http2 on;\n`
    : '';
  return `# Managed by cezar server-install — do not edit by hand.
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};

${http2}
    auth_basic "cezar";
    auth_basic_user_file ${htpasswd};

    # Streamable HTTP MCP endpoint authenticates via bearer token, not nginx Basic Auth.
    location = /api/v1/mcp {
        auth_basic off;
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Squawk streams SSE (run events). Never buffer it, or the cockpit goes mute.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
    }
}
`;
}
