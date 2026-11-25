# Local development

End-to-end, from a fresh clone to a global `hsq` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 24.21.0+ and `git` (plus at least one logged-in agent CLI,
as in [Quick start](../README.md#quick-start)).

**2. Clone & install**

The npm global prefix must be writable by your user. On Unix, use Node installed
with nvm, or set a user-owned prefix (`npm config set prefix ~/.npm-global`) and
add `~/.npm-global/bin` to your `PATH`. On Windows, use a user-owned npm prefix
and add the prefix itself (reported by `npm prefix -g`) to `PATH`; npm puts
Windows executables directly there. Set `PATH` before these commands.

```bash
git clone https://github.com/hearsay-tools/squawk.git
cd squawk
npm install --global pnpm@12.11.2
pnpm install --frozen-lockfile
```

Dependency installation uses pnpm 12.11.2 (pinned in `packageManager`) and
`pnpm-lock.yaml`. Use pnpm for dependency changes; keep npm for the existing
build/test scripts. Workspace dependencies are linked locally and esbuild's
install hook is approved in `pnpm-workspace.yaml`. The store uses hardlinks when
the checkout and store share a filesystem. Publishing and end-user installation
continue to use npm. For this repository's Worktrees setup, use
`pnpm install --frozen-lockfile` after the checked-out base branch contains the migration.

**3. Build** — compiles the api-client and the server (`tsc → packages/cezar/dist/`) and the cockpit
(`vite build → packages/cezar/web/dist/`), then runs the pack gate:

```bash
npm run build
```

**4. Install as a global command** — build + put `hsq` on
your PATH pointing at *this checkout*:

```bash
npm run install-as-command            # live link (default) — see the change loop below
#   or: npm run install-as-command:global   # self-contained snapshot copy

```

Now `cd` into any other repo and run it:

```bash
cd ~/some-other-project
hsq              # cockpit for that repo, straight off your checkout
hsq --help       # the same command as `npx -p @hearsay-tools/squawk hsq`
```

**5. The change loop**

- **Link mode** (default): edit source → `npm run build` → the global command
  reflects it immediately. No relink needed. (It is a live symlink into this
  checkout — don't move or delete the checkout while it's linked.)
- **Snapshot mode** (`:global`): re-run `npm run install-as-command:global` to
  refresh the installed copy. It survives moving/deleting the checkout.

**6. Uninstall**

```bash
npm run uninstall-as-command    # removes hsq and the compatibility commands (either flavor)
```

**7. Troubleshooting**

- **`hsq: command not found`** after install → your npm global bin dir isn't on
  PATH. The script prints the exact dir; add it to your shell profile
  (Unix: `export PATH="$(npm prefix -g)/bin:$PATH"`; Windows: add the directory
  reported by `npm prefix -g` itself to `PATH`, without a `bin` suffix).
- **`EACCES` / permission denied** → your global prefix is root-owned. Point npm
  at a user-writable one and retry — **never** sudo:
  `npm config set prefix ~/.npm-global`.
- **Already installed the published `@wjarka/cezarion` globally?** The
  link/snapshot install replaces it; `uninstall-as-command` removes ours, and
  `npm i -g @hearsay-tools/squawk` brings the published one back.

### In-checkout scripts

```bash
npm run dev          # server (API :4321) + Vite dev server, opens the cockpit in the browser
npm run dev:server   # tsx packages/cezar/src/index.ts — the API server alone
npm run dev:web      # Vite dev server alone (proxies /api to :4321)
npm run build        # tsc → packages/cezar/dist/, vite build → packages/cezar/web/dist/, then the pack gate
npm run typecheck    # check all four workspaces without building
npm run typecheck:web # check web sources without building
npm test             # vitest — server + cockpit unit suites
npm run test:changed # iteration only: tests related to branch + working-tree changes
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
npm run test:e2e:local # full browser suite in four isolated, concurrent lanes
```

The four-lane local browser run needs roughly 8 GiB of RAM at peak. It keeps CI's
serial-per-shard policy unchanged. See [cockpit E2E testing](../packages/web/e2e/README.md#full-local-suite-in-four-lanes)
for lane isolation, logs, and cleanup.

Measure function complexity and CRAP for one or more files or directories with Squeal:

```bash
squeal code packages/contract/src/attention.ts --json
```

Drop `--json` for one line per function, or add `--base origin/main` for a one-shot
measurement of the functions a branch changed with fresh coverage. See
[Measure requested code](../.ai/skills/check-code-quality/references/measure.md)
(part of the [check-code-quality skill](../.ai/skills/check-code-quality/SKILL.md))
for the output fields, coverage limits and how to wait for pending CRAP scores.

The local pre-PR check is complexity only. Commit, then run the same gate as CI's
`complexity-gate` job:

```bash
node .ai/skills/check-code-quality/scripts/complexity-gate.mjs --base origin/main --head HEAD
```

It fails a changed function over complexity 20 that is new or more complex than at
the merge base. Equality passes. It reads no coverage and takes seconds. See the
[pre-PR procedure](../.ai/skills/check-code-quality/references/pre-pr.md).

CRAP is reported in CI, never locally before a merge: the `Report CRAP for changed
functions` job scores the changed functions from the pull request's Vitest coverage
and never fails a check. After the merge, each function over CRAP 30 gets a line in
the open `crap-follow-up` issue. See
[CRAP report for changed functions](sdlc/ci.md#crap-report-for-changed-functions).

For iteration, read Squeal's verdicts. Agents never run the test commands above by hand;
[AGENTS.md § Validation](../AGENTS.md#validation) names the Squeal commands and the few
exceptions. The [CI guide](sdlc/ci.md) holds the final-gate/evidence-reuse policy.

`npm run typecheck` checks all four workspaces from source without writing build
output. `npm run typecheck:web` checks the cockpit and reads the server route types
from this checkout. Run `pnpm install --frozen-lockfile` in each new worktree first.
Packaged CLI tests import built modules; CI checks them with
`npm run typecheck:package` after `npm run build`.

CI runs eight duration-balanced Vitest shards alongside the build and package checks.
See [CI verification](sdlc/ci.md) for the job graph and local commands.

The stack is deliberately small: **TypeScript** (strict, ESM), **Hono** + SSE for
the server, **Zod** at every boundary, **YAML** for workflows, and a **React 19 +
Vite + Tailwind v4 + shadcn/ui** cockpit shipped pre-built in `packages/cezar/web/dist/` — the
published package carries the built app, so `npx` users never run a bundler.
Every module is meant to be read in one sitting.

---
