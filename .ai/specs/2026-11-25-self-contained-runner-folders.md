# Self-contained runner folders
Status: done

Epic hearsay-tools/squawk#4232. It runs between step 4 and step 5 of
[the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), and it completes the loader and
runner kit of [ADR 0070](../../docs/adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md).
[ADR 0071](../../docs/adr/0071-keep-runner-folders-self-contained.md) records the result.
Baseline: `main` at `56e5a0920`. The owner settled the seven open points of the epic on
2026-11-25 (task `77826c8b`). The work landed in nine slices (see
[Implementation record](#implementation-record) below; the working plan file was deleted on
close-out). Paths are under `packages/cezar/` unless noted.

## Goal

Each of the six bundled runners loads and runs from a copy of its built folder
(`dist/runners/<id>/`) in `<config>/plugins/`, with no edit and no `npm install`. After this
epic:

- no non-test file under `src/runners/<id>/` names a file outside its folder by a relative
  path, and no such file imports a package other than `node:*` and
  `@hearsay-tools/squawk/plugin*`;
- a lint rule holds both rules, and a package e2e test proves them on the built folders;
- the scripts that an agent CLI loads (the Pi and OMP extensions, the OpenCode plugin) live in
  their runner's folder and find Squawk's tool client through their environment;
- `HSQ_DRY_RUN=1` still runs every bundled runner on its mock CLI, and a copied runner keeps its
  dry run;
- each runner, loaded unchanged from `<config>/plugins/`, completes a task on its real CLI in a
  live run.

The six runners stay bundled. The epic changes where their files live and how they find the
product, not what they do.

## Out of scope

- Moving a runner out of this repository or out of the product.
- Installing plugins from npm or git, and a stable plugin API: a later epic (ADR 0070 § 7).
- Moving the runners' tests or the parity kits out of the repository.
- Moving the mock CLIs or their shared helpers out of `scripts/` (decision 4).
- New extension slots: roadmap step 5.
- Parity cells keyed to one runner: hearsay-tools/squawk#3998.

## Done when

- **Outcome:** every child issue is closed, this spec is `Status: done`, its `-plan.md` is
  deleted, the roadmap marks the epic done, and ADR 0070 (amended) or a new ADR records the
  result.
- **Proof:** `test/e2e/runner-copy-out.test.ts` copies the six installed `dist/runners/<id>/`
  folders unchanged into `<config>/plugins/`, starts Squawk with no bundled runner, and runs a
  `HSQ_DRY_RUN=1` task on each, with no expected failure left. The six
  `runner-folder-escape` baselines are empty. Each runner has a recorded live run from
  `<config>/plugins/` on its real CLI.
- **Failure:** a runner file that adds `new URL('../../../scripts/x.mjs', import.meta.url)`,
  `join(here, '..', '..', 'scripts')` or `import … from 'zod'` fails `cez/runner-folder-escape`.
  A runner folder that still needs a file outside it fails the copy-out test.

## Decisions

The owner accepted each proposal on 2026-11-25.

### 1. A runner gets `zod` from the kit

The kit's main entry, `@hearsay-tools/squawk/plugin`, re-exports `z`
(`export { z } from 'zod'` in `src/plugin/runner-kit.ts`). Runners import `z` from there.

Why: a host-folder plugin has no install step, so a declared dependency cannot be met. The
product already ships one `zod`. The kit's main entry already loads `zod`
(`runner-kit.ts` → `core/agent-env.ts` → `core/runner-registry.ts` → `core/runner-id-schema.ts`),
so the re-export adds no module to its closure. All 26 runner files that import `zod` use
`import { z } from 'zod'` and nothing else.

Rejected: a `@hearsay-tools/squawk/plugin/zod` subpath. It adds a public path for no smaller
closure.

### 2. A script in another process finds the tool client through `HSQ_TOOL_CLIENT`

`CiToolController.provision()` (`src/ci-wait/controller.ts`) adds `HSQ_TOOL_CLIENT` (written as
`HSQ_TOOL_SOCKET` is, through `productEnvEntries`) to the session env. Its value is the file URL
of the running copy's tool client: `src/ci-wait/client.ts` under source, `dist/ci-wait/client.js`
when built. `pi-ci-wait.mjs` and `omp-ci-wait.mjs` import the client from that URL and from no
path relative to their own file.

OMP keeps its source-checkout fallback. OMP's loader cannot resolve the workspace contract
package from a source checkout (`src/runners/omp/__fixtures__/README.md`, the 2026-10-05 rows),
so `omp-ci-wait.mjs` imports `client.ts` first and, when that import fails, the built
`dist/ci-wait/client.js` of the same checkout if it exists, as it does today. It finds that file
from the `HSQ_TOOL_CLIENT` URL (`new URL('../../dist/ci-wait/client.js', clientUrl)`), not from
its own location. When `dist/` is absent, it rethrows the source error.

Why: Pi has no MCP client, and OMP reads MCP servers only from files, with no per-session flag
(`.ai/specs/2026-10-02-omp-runner.md`), so Squawk's tools reach both as an `--extension`. The
extension runs in the agent CLI's process, where the resolve hook of ADR 0070 does not work.
`provision()` already builds the env of every session that asks for Squawk's tools, so every
runner gets the variable with no runner code. Pi loads `client.ts` from a source checkout
through its own loader, as it does today.

Rejected: a kit helper that each runner calls to add the variable. Every caller would repeat
what `provision()` already does.

### 3. The product scripts live in their runner's folder

| Script | New place |
|---|---|
| `pi-ci-wait.mjs`, `pi-default-tools.mjs`, `pi-project-skills.mjs`, `pi-retry-degraded-service.mjs`, `pi-runaway-reply-guard.mjs` | `src/runners/pi/extensions/` |
| `omp-ci-wait.mjs` | `src/runners/omp/` |
| `opencode-task-scope.mjs` | `src/runners/opencode/` |

File names do not change: Pi reports the skill source `extension:pi-project-skills.mjs`, and
`pi-skill-catalog.ts` and the mock skill data key on that name. `tsc` copies no `.mjs`, so a
`postbuild` step copies every non-test `.mjs` under `src/runners/<id>/` to the same path under
`dist/runners/<id>/`, and `check:pack` checks that each one is there. Runner code names a script
by `new URL('./extensions/<name>.mjs', import.meta.url)` or the like, inside its folder.

Rejected: rewriting the scripts as `.ts` for `tsc` to emit. The file name would differ between
source and `dist/`, which breaks the Pi catalog key.

### 4. The mock CLIs stay in the product, behind the kit

The six mock CLIs and their shared helpers stay in `scripts/`. A new kit function,
`nativeMockPath(mock)`, resolves `RunnerMock.script` against the running copy's `scripts/`
folder and throws an error that names the script when the file is absent. Every dry-run site in
runner code, and `core/skill-probe.ts`, calls it instead of building a path.

Why: the six mock CLIs share about 1,300 lines of helpers, and those helpers import product code
(`product-env.mjs`) and packages (`@modelcontextprotocol/sdk`, `tsx`). More than 40 test sites,
four lint rules and `.ai/scripts/simulate-sixth-runner.mjs` assume `scripts/mock-*.mjs`. A copied
runner keeps its dry run because the product it loads into ships its mock. A runner whose script
the product does not ship gets that error under `HSQ_DRY_RUN=1`.

Rejected: moving each mock CLI into its runner's folder, with the shared helpers reached through
a path in the mock's environment. About three times the work, and the same result for the six
bundled runners.

### 5. A test-only boot option names the bundled folder

`bootRuntime` takes `bundledRunnersDir`, next to `pluginsDir`. `loadBundledRunners` reads that
folder when it is given and `bundledRunnersDir()` otherwise. Only tests and the live-run wrapper
pass it. The wrapper (`test/e2e/support/hsq-without-bundled.mjs`) boots with an empty bundled
folder and the host plugin folder, then runs the CLI entry in the same process. `bootRuntime`
returns the same boot on a later call, so the CLI's own call reuses the wrapper's boot.

Why: a host plugin with a bundled runner's id is refused as a key conflict, so the copied
folders need a boot with no bundled runner to keep their own ids.

Rejected: an environment variable that the CLI reads. It adds a knob that a user could set.

### 6. Two guards: the copy-out test and `cez/runner-folder-escape`

The copy-out test is the real guard: it runs the built folders where a missed path fails. The
lint rule `cez/runner-folder-escape` gives the early signal. In a non-test file under
`src/runners/<id>/` it reports:

- a relative path that leaves the folder: `new URL('../…', import.meta.url)` that resolves
  outside it, a `join` or `resolve` call whose literal `'..'` segments climb out (the form of
  `claude-executable.ts:15`), and a relative import or dynamic import specifier that leaves it;
- an import of a package other than `node:*` and `@hearsay-tools/squawk/plugin*`.

Each runner has its own shrink-only baseline file,
`src/lint/runner-folder-escape/<id>.baseline.json`, so the runner slices change disjoint files.
Each starts with that runner's sites on the baseline commit. The copy-out test expects a runner
to fail while its baseline file holds an entry, and a runner that then passes fails the test.
The expected failures therefore shrink with the baselines, and `main` stays green.

`cez/runner-core-import` stays as it is: it checks imports of core modules, and the new rule
checks paths and packages.

### 7. Each runner gets a live run before its slice lands

Each runner slice runs its runner, copied unchanged from the built `dist/` into
`<config>/plugins/` and started through the wrapper of decision 5, on its real CLI, to a
finished task. The evidence names no host path, host name or login. A runner whose CLI or login
the acceptance host lacks blocks the close-out until the owner decides: a run on a host that has
it, or an approved change to the epic's live-run criterion.

## Evidence

The inventory on `main` at `24bf0ced0` is in the epic's Agent context comment. A recheck at
`56e5a0920` found:

- **Imports.** Runner files import only `node:*`, the kit and its subpaths, and `zod` (26 files:
  16 antigravity, 4 codex, 2 claude, 2 opencode, 1 omp, 1 pi).
- **Paths into `scripts/`.** Product scripts: `pi/pi-args.ts:7-9`, `pi/pi-runner.ts:468` and
  `:519`, `omp/omp-runner.ts:138` and `:157`, `opencode/opencode-task-scope.ts:5`. Mock CLIs:
  `antigravity/antigravity-runner.ts:21`, `antigravity/antigravity-skill-catalog.ts:148`,
  `claude/claude-executable.ts:15`, `codex/codex-app-server-transport.ts:22`,
  `omp/omp-runner.ts:192` and `:804-808`, `opencode/opencode-server-runner.ts:137`,
  `pi/pi-runner.ts:597`. `RunnerMock.script` holds a file name only, and core resolves it in
  `core/skill-probe.ts:26-29`.
- **Mock CLIs.** `scripts/` holds 43 `mock-*.mjs` files. All six mock CLIs import the same 24
  helper files (1,318 lines, `product-env.mjs` included), by a scan of their static and dynamic
  `./` imports. `mock-ask-answer.mjs` is shared by codex and opencode. Six helpers belong
  to one mock each.
- **Tool client.** `ci-wait/client.ts` imports `node:crypto`, `node:http`,
  `core/product-env.ts` and the contract's `agent-tools` and `wait-tools`, and through them
  `zod`. In `dist/`, the contract is inlined into `dist/contract/index.js` and `zod` stays
  external, so the client resolves `zod` from the installed product.
- **Build.** `build` is `tsc` (`rootDir: src`, `outDir: dist`). `postbuild` runs
  `scripts/inline-contract.mjs`. No step copies a non-TS file into `dist/`. The package ships
  `scripts/` because `files` lists it.
- **Package test.** `test/e2e/package-cli.test.ts:58` requires `scripts/pi-ci-wait.mjs`,
  `scripts/omp-ci-wait.mjs` and `scripts/opencode-task-scope.mjs` in the tarball, and `:82-83`
  imports the two ci-wait scripts from the installed package.

### Test selection (roadmap rule 5)

Slice A2 records `squeal status src/plugin/index.ts --json` (`.selection.testFiles`) before and
after the `z` re-export, and so does each slice that adds to the kit. The re-export must not
raise the count, because the main entry already loads `zod`. An answer whose `selection.reason`
is `unsynced` is incomplete and is taken again.

## Case tables

No case table of [the template](TEMPLATE.md#case-tables) applies. The epic adds no run state,
hold, lock, cross-run record, tool-grant mapping, worktree write or detached process. The tool
grants of each runner, and the extensions that carry them, stay as they are. Only the path that
names each extension changes.

## Implementation record

Epic hearsay-tools/squawk#4232. Every slice merged as one squash commit on `main`. The result is
[ADR 0071](../../docs/adr/0071-keep-runner-folders-self-contained.md) (with a completion pointer
in [ADR 0070](../../docs/adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md)).

| Slice | Issue | Pull request | Commit on `main` | Notes |
| --- | --- | --- | --- | --- |
| Wave 0 | hearsay-tools/squawk#4232 | hearsay-tools/squawk#4249 | `f52468131` | Spec, plan and child issues |
| A2 | hearsay-tools/squawk#4254 | hearsay-tools/squawk#4265 | `353fc9016` | `z` re-export in kit, `HSQ_TOOL_CLIENT` in `CiToolController.provision()`, `nativeMockPath(mock)`, `copy-runner-assets.mjs` + `check:pack` |
| A3 | hearsay-tools/squawk#4255 | hearsay-tools/squawk#4267 | `b3e5b58c9` | `cez/runner-folder-escape` lint rule and 6 per-runner baselines (40 initial sites) |
| A1 | hearsay-tools/squawk#4256 | hearsay-tools/squawk#4270 | `fd5a607f1` | `bootRuntime({ bundledRunnersDir })`, `hsq-without-bundled.mjs`, and `test/e2e/runner-copy-out.test.ts` |
| B1 | hearsay-tools/squawk#4257 | hearsay-tools/squawk#4277 | `f4c9ca786` | `claude` self-contained; `claude.baseline.json` emptied (`[]`); live run passed |
| B2 | hearsay-tools/squawk#4258 | hearsay-tools/squawk#4278 | `750aefd1d` | `codex` self-contained; `codex.baseline.json` emptied (`[]`); live run passed |
| B3 | hearsay-tools/squawk#4259 | hearsay-tools/squawk#4281 | `e78efe632` | `antigravity` self-contained; `antigravity.baseline.json` emptied (`[]`); live run passed |
| B4 | hearsay-tools/squawk#4260 | hearsay-tools/squawk#4285 | `448af8434` | `pi` + `omp` self-contained (`.mjs` assets moved into runner folders, `HSQ_TOOL_CLIENT`, E2E build mirror updated in `.ai/scripts/build-e2e.sh` and `.ai/scripts/test-env-up.sh`); `pi.baseline.json` and `omp.baseline.json` emptied (`[]`); both live runs passed |
| B5 | hearsay-tools/squawk#4261 | hearsay-tools/squawk#4286 | `085835eb6` | `opencode` self-contained (`opencode-task-scope.mjs` moved into runner folder); `opencode.baseline.json` emptied (`[]`); live run passed |
| E | hearsay-tools/squawk#4262 | Merged with E | Merged with E | Removed expected-failure branch from `runner-copy-out.test.ts`; updated docs, ADR 0071, roadmap and spec record; deleted plan |

### Measurements

- **Squeal selection (roadmap rule 5, Slice A2):** `packages/cezar/src/plugin/index.ts` selected
  **743 test files before → 743 test files after** (`selection.complete: true`, 0 growth) for the
  `z` re-export.
- **`runner-folder-escape` baselines:** 40 initial sites across the six runners drained to 0
  entries (`[]`) in all six files under `src/lint/runner-folder-escape/`.
- **Copy-out guard (`test/e2e/runner-copy-out.test.ts`):** all six installed `dist/runners/<id>/`
  folders load as `host` plugins with 0 bundled runners, 0 failures, no `node_modules` ancestor,
  and pass `HSQ_DRY_RUN=1` cleanly with no expected failure.

### Live acceptance runs

Each runner was copied unchanged from its built `dist/runners/<id>/` folder into a sandbox
`<config>/plugins/<id>/` with no `node_modules` ancestor and run through `hsq-without-bundled.mjs`
(0 bundled runners loaded; target runner loaded with `source: "host"`):

- **`claude` (Slice B1, hearsay-tools/squawk#4277):** Claude Code CLI `2.1.331`; completed a live
  task with exit 0 in 10.2 s (`status: "done"`).
- **`codex` (Slice B2, hearsay-tools/squawk#4278):** `codex-cli 0.164.0`; completed a live task
  with exit 0 in 8.9 s (`status: "done"`).
- **`antigravity` (Slice B3, hearsay-tools/squawk#4281):** `antigravity` (`gemini-3.8-flash`);
  completed a live task with exit 0 in 11.7 s (`status: "done"`, 41,516 tokens).
- **`pi` (Slice B4, hearsay-tools/squawk#4285):** `pi 1.6.0`; invoked `cezar_done` via
  `pi-ci-wait.mjs` and `HSQ_TOOL_CLIENT`; completed in 15.3 s (`status: "done"`, 26,212 tokens).
- **`omp` (Slice B4, hearsay-tools/squawk#4285):** `omp 18.13.1` (`zai/glm-4.5-air`); invoked
  `cezar_done` via `omp-ci-wait.mjs` and `HSQ_TOOL_CLIENT`; completed in 13.2 s (`status: "done"`,
  44,876 tokens).
- **`opencode` (Slice B5, hearsay-tools/squawk#4286):** `opencode v1.19.4`; completed a live task
  with exit 0 in 23.2 s (`status: "done"`, `cezar_done` accepted).
