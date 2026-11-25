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

---
