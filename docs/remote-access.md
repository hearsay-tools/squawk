# Remote access (host Squawk on a server)

Squawk runs on `localhost` by default. To reach the cockpit from another machine —
a shared team box, a VPS, your phone — put an **authenticated public front** in
front of it. The built-in installer does this interactively, per **platform
strategy**, and never escalates silently: every privileged command is printed
and verified, and it ends with a real authenticated end-to-end check.

```bash
npx -p @hearsay-tools/squawk hsq server-install   --platform ubuntu-vps   # stand it up
npx -p @hearsay-tools/squawk hsq server-deploy    --platform ubuntu-vps   # roll out a new version (reload the service)
npx -p @hearsay-tools/squawk hsq server-uninstall --platform ubuntu-vps   # reverse it

# host a SECOND cockpit for another domain on the same box (ubuntu-vps):

npx -p @hearsay-tools/squawk hsq server-install   --platform ubuntu-vps --domain shop.example.com
```

On `ubuntu-vps` a single host can run several independent cockpits — add
`--domain <host>` and each gets its own port, nginx site, login and service; a
new domain never resumes or clobbers the first install.

**Already running a reverse proxy?** If Dokploy, Coolify, Caddy or your own
nginx already owns `:80/:443`, Squawk's would fight it for the ports. Install the
service only and let your proxy front it:

```bash
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps \
  --external-proxy --domain Squawk.example.com --bind-host 172.17.0.1
```

`--bind-host` is only needed when the proxy runs in a **container** (Traefik
can't reach the host's loopback); a host-installed proxy uses the `127.0.0.1`
default. In this mode **your proxy must enforce authentication** — Squawk has
none of its own. [Details →](server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy)

| Provider | `--platform` | Public front | Guide |
|----------|--------------|--------------|-------|
| Ubuntu / Debian VPS | `ubuntu-vps` | nginx + Let's Encrypt HTTPS, htpasswd login, systemd | [Step-by-step →](server-install/ubuntu-vps.md) |
| Ubuntu + existing proxy | `ubuntu-vps --external-proxy` | your Dokploy/Traefik/Caddy front; Squawk ships the service only | [Step-by-step →](server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) |
| macOS + ngrok | `macosx-ngrok` | ngrok tunnel + `--basic-auth`, launchd | [Step-by-step →](server-install/macosx-ngrok.md) |

See the **[Remote access overview](server-install/README.md)** for how it
works and how to redeploy new versions. A remote cockpit keeps Agent config and
worktree setup read-only; to edit them from the browser, see
**[Remote settings administration](server-install/remote-settings.md)**.
A remote cockpit loads [plugins](plugins.md) from the server's `<config>/plugins/`
only: the browser cannot add or remove one, and health sends no plugin paths.

## Streamable HTTP MCP endpoint (`/api/v1/mcp`)

Multi-host orchestrators can drive a hosted cockpit over Streamable HTTP at
`POST /api/v1/mcp` using host-managed bearer tokens (hearsay-tools/squawk#4402):

```bash
hsq mcp token create --name fleet --port 4321            # prints raw hsq_mcp_... token once
hsq mcp token create --name ci --port 4321 --project app # optional project scope
hsq mcp token list                                       # metadata only; never hashes or tokens
hsq mcp token revoke <id>                                # takes effect on next request
```

Tokens are stored per listen port as SHA-256 hashes in `<config>/mcp-tokens/<port>.json`
(mode `0600`) and are withdrawn automatically on `server-uninstall` and fresh installs on
that port. When no token is configured (and `HSQ_MCP_TOKEN` is unset), `/api/v1/mcp`
returns `404`.

- **Built-in `ubuntu-vps` nginx:** The generated vhost sets `auth_basic off;`,
  `proxy_buffering off;`, and `proxy_read_timeout 3600s;` on `location = /api/v1/mcp`
  while keeping HTTP Basic Auth on `/` and all other cockpit routes.
- **External TLS reverse proxies (Traefik, Caddy, custom nginx):** Always terminate TLS
  at the proxy, bypass Basic Auth **only** for exact path `/api/v1/mcp` so
  `Authorization: Bearer <token>` reaches Squawk, disable response buffering for SSE
  streaming (`proxy_buffering off` / `flush_interval -1`), and set a long read timeout
  (e.g. `3600s`) for `task_wait` calls. Keep proxy authentication enforced on every other
  path.

---
