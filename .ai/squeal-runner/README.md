# `squawk-runner` — Agent37 template for Squeal remote runs

`squawk-runner` is the Squawk-owned Agent37 workspace template used by Squeal remote VMs (hearsay-tools/squawk#4367).

## What the image contains

Built from `ubuntu:26.04` (Git 2.53, matching `squeal-runner`) with all tools baked outside `/home/node` because Agent37 mounts the instance's persistent disk over `/home/node` at runtime:

- Non-root user `node` (`uid=1000`, unlocked for SSH pubkey auth) with passwordless `sudo`.
- `tini` as PID 1 (`sleep infinity` command) so orphaned test and browser processes are reaped cleanly.
- Build and system tools needed by Squeal, Squawk tests, `.ai/scripts/test-env-up.sh`, and `.ai/scripts/resolve-browser-launch.mjs`: `bash`, `ca-certificates`, `curl`, `gnupg`, `git`, `build-essential`, `python3`, `python3-venv`, `file`, `jq`, `ripgrep`, `rsync`, `unzip`, `zip`, `xz-utils`, `procps`, `lsof`, `iproute2`, `ffmpeg`, and Liberation/DejaVu/Noto fonts.
- Google Chrome Stable (`/usr/bin/google-chrome`) and all Linux shared libraries it needs to launch headless as `node`.
- The pinned `agent-browser` binary in `/usr/local/bin/agent-browser`, matching `browser.agentBrowserVersion` in `.ai/scripts/test-env.inputs.json`.

Node itself is provisioned per worktree by Squeal to match the local host's exact Node version.

## Rebuilding and publishing a new revision

Keep `ARG AGENT_BROWSER_VERSION` in [Dockerfile](Dockerfile) aligned with `browser.agentBrowserVersion` in [test-env.inputs.json](../scripts/test-env.inputs.json). `scripts/squeal-remote-setup.test.mjs` and the build script both check that they match.

Run the cloud build script from the repository root:

```bash
node .ai/scripts/build-squawk-runner.mjs
```

- When your host routes `https://api.agent37.com` through an authenticating proxy, no token is needed in the environment.
- Without a proxy, set `AGENT37_API_KEY` in the environment before running the script.
- Pass `--name <template>` to publish under another workspace template name, or `--dry-run` to pack the context and check pin alignment without contacting Agent37.

Re-running the build publishes a new revision of `squawk-runner`. Existing Agent37 instances keep their old revision until updated or replaced.

## Configuring Squeal to use `squawk-runner`

Set `providerConfig.template` in your per-user `~/.config/squeal/remote.json` entry for this repository (outside git):

```json
{
  "repositories": {
    "https://github.com/hearsay-tools/squawk.git": {
      "provider": "agent37",
      "lanes": "all",
      "runners": "all",
      "providerConfig": {
        "region": "eu",
        "type": "vm",
        "template": "squawk-runner"
      }
    }
  }
}
```

When `providerConfig.template` changes, Squeal replaces the tracked VM on the next connect.

## Interaction with `squeal.config.json`

`squeal.config.json` configures two Squeal 0.1.656 settings alongside this template:

- `remote.setup` (`.ai/scripts/squeal-remote-setup.sh`): verifies pinned `agent-browser` and headless `google-chrome` once per VM (re-runs only when the script changes). On `squawk-runner`, this finishes in under two seconds. If `.ai/scripts/test-env.inputs.json` bumps `agentBrowserVersion` before the image is rebuilt, the script downloads the new pinned binary into `~/.cache/agent-tools/agent-browser/<version>/`. On a generic Linux VM with root or passwordless `sudo`, it installs `google-chrome-stable`.
- `requires.commands` (`{ "packages/web/e2e/*.e2e.ts": ["google-chrome"] }`): routes browser specs to the remote VM when `google-chrome` is present there, and keeps only `packages/web/e2e/*.e2e.ts` local on a remote that lacks Chrome (such as `squeal-runner` before `remote.json` is updated), without blocking unit tests on that remote.
