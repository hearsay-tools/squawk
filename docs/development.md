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
git clone https://github.com/hearsay-tools/cezarion.git
cd cezarion
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
pnpm metrics <file> # function complexity; add --test <test-file> for coverage and CRAP
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
npm run test:e2e:local # full browser suite in four isolated, concurrent lanes
```

The four-lane local browser run needs roughly 8 GiB of RAM at peak. It keeps CI's
serial-per-shard policy unchanged. See [cockpit E2E testing](../packages/web/e2e/README.md#full-local-suite-in-four-lanes)
for lane isolation, logs, and cleanup.

Calculate metrics for one JavaScript or TypeScript file, or select a function:

```bash
pnpm metrics packages/contract/src/attention.ts
pnpm metrics packages/contract/src/attention.ts --function deriveAttention
pnpm --silent metrics packages/contract/src/attention.ts --line 150 --json
pnpm metrics packages/contract/src/attention.ts --function deriveAttention --test packages/contract/src/attention.test.ts
pnpm metrics packages/contract/src/attention.ts --coverage coverage/coverage-final.json
```

Complexity follows ESLint's classic convention, including short-circuit operators,
optional chaining, default parameters and each non-default switch case. Functions,
methods and arrow functions have separate scores. Module and class initialization
are excluded. Use `Class.method` or `--line` when a name is ambiguous.

CRAP is `C² × (1 − coverage)³ + C`, using executable line coverage within each
function body. This is the line-coverage variant; the original proposal used
basis-path coverage. An empty function uses its call counter. Missing coverage
shows `unavailable`, or `null` for CRAP in JSON. It never assumes zero coverage.
The command discovers `coverage/coverage-final.json` from the source directory
up to the checkout root, then the current directory. An explicit `--coverage`
selects an Istanbul JSON report. Reports older than the source leave CRAP unavailable;
reports must describe the current source, so regenerate them after source changes.

Repeat `--test` to collect coverage from several Vitest test files. This runs only
the supplied tests in the unit projects, with two workers and a ten-minute limit.
Coverage files are temporary and are removed after the calculation. A failed test
run exits nonzero and produces no scores. Without `--test`, no tests run. Test logs
go to stderr, so `--json` stdout contains only the report. This tool belongs to the
checkout and is available after the normal dependency installation. Use
`pnpm --silent metrics ... --json` to also suppress pnpm's command banner.

The tool is bundled in the [check-code-quality skill](../.ai/skills/check-code-quality/SKILL.md).
Ask an agent to measure a file, function or module for a scoped stats report.
That path uses available coverage and reports missing CRAP without starting the
PR process. Ask explicitly for fresh coverage when needed.

The local pre-PR gate uses Squeal 0.1.423's one-shot changed-function check:

```bash
quality_report=$(mktemp "${TMPDIR:-/tmp}/code-quality.XXXXXXXX") || exit 2
squeal code --base origin/main --json > "$quality_report"
quality_status=$?
printf 'Report: %s; exit: %s\n' "$quality_report" "$quality_status"
```

It checks changed JS/TS functions, including test callbacks and nested functions,
with complexity at most 20 and CRAP at most 30. Equality passes. The default
budget is 600 seconds. The base commit supplies the policy.

A pass requires complete evidence: no skipped, incomplete or uncounted functions,
failed or unfinished tests, or exhausted budget. Exit 0 alone is insufficient
because a report can contain skipped functions. Exits 1, 3 and 2 mean violations,
incomplete measurement and usage/setup errors. Missing Squeal or unsupported
evidence blocks the PR. There is no bundled fallback or inherited-refactor
deferral. See the [pre-PR procedure](../.ai/skills/check-code-quality/references/pre-pr.md)
for report identity, completeness checks and reviewable evidence.

CI and explicit statistics commands keep their existing paths during this
local-first rollout. CI artifact reuse and supported exceptions await the
remaining work in hearsay-tools/squeal#167.

For iteration, run affected test files or `npm run test:changed` (inspect with
`-- --plan`; override the local main comparison with `-- --base=<ref>`).
The changed-test command includes staged, unstaged and untracked changes and
falls back to full Vitest on shared/configuration/unknown input or missing Git
history. It is not a substitute for final verification. See [AGENTS.md § Validation](../AGENTS.md#validation)
for targeted browser commands and the [CI guide](sdlc/ci.md) for the final-gate/evidence-reuse policy.

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
