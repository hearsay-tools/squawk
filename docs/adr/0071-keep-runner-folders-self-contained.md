# Keep runner folders self-contained

Approved design: [self-contained runner folders](../../.ai/specs/2026-11-25-self-contained-runner-folders.md),
including the owner's seven decisions of 2026-11-25 (task `77826c8b`). Epic
hearsay-tools/squawk#4232, between step 4 and step 5 of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md). It completes the host-folder
plugin loader and runner kit of
[ADR 0070](0070-load-host-folder-plugins-and-export-the-runner-kit.md).

## Decision

Every bundled runner folder (`packages/cezar/src/runners/<id>/`, built into
`packages/cezar/dist/runners/<id>/`) stays self-contained so its built folder loads and runs
unchanged when copied into `<config>/plugins/` with no edit, no `npm install`, and no
`node_modules` ancestor. The six runners stay bundled in this repository; this record sets where
their files live, how they reach product helpers, and which guards keep them self-contained.
Paths below are under `packages/cezar/` unless noted.

### 1. Re-export `z` from the runner kit

- `@hearsay-tools/squawk/plugin` (`src/plugin/runner-kit.ts`) re-exports `z` from `zod`
  (`export { z } from 'zod'`).
- Runner code imports `z` from `@hearsay-tools/squawk/plugin` rather than directly from `zod`.
- A host-folder plugin has no install step, so it cannot resolve third-party packages from
  `node_modules`. The kit's main entry already loads `zod` transitively, so re-exporting `z` adds
  no module to the boot closure (Squeal rule-5 count on `src/plugin/index.ts`: 743 test files
  before and 743 after).

### 2. Expose the tool client to agent CLI processes through `HSQ_TOOL_CLIENT`

- `CiToolController.provision()` (`src/ci-wait/controller.ts`) writes `HSQ_TOOL_CLIENT` (with
  `CEZ_TOOL_CLIENT` fallback, via `productEnvEntries`) into every tool-enabled session environment.
- Its value is the `file:` URL of the running Squawk copy's tool client: `src/ci-wait/client.ts`
  under source and `dist/ci-wait/client.js` when built.
- Out-of-process scripts loaded by an agent CLI (`pi-ci-wait.mjs` and `omp-ci-wait.mjs`), where
  Squawk's in-process `registerHooks` resolver does not run, import the tool client from
  `HSQ_TOOL_CLIENT` instead of a path relative to themselves.
- `omp-ci-wait.mjs` keeps its source-checkout fallback to `dist/ci-wait/client.js` when importing
  `client.ts` fails in OMP's loader, deriving the fallback URL from `HSQ_TOOL_CLIENT`
  (`new URL('../../dist/ci-wait/client.js', clientUrl)`) rather than from its own file path.

### 3. Keep runner-owned `.mjs` assets inside the runner folder

- Product scripts loaded by an agent CLI live inside their runner's folder:
  - `src/runners/pi/extensions/{pi-ci-wait,pi-default-tools,pi-project-skills,pi-retry-degraded-service,pi-runaway-reply-guard}.mjs`
  - `src/runners/omp/omp-ci-wait.mjs`
  - `src/runners/opencode/opencode-task-scope.mjs`
- Runner code resolves its own assets with `new URL('./…', import.meta.url)` inside the folder.
- Because `tsc` copies no `.mjs` files, `postbuild` runs `scripts/copy-runner-assets.mjs` to copy
  every non-test `.mjs` file under `src/runners/<id>/` to the same relative path under
  `dist/runners/<id>/`. `.ai/scripts/build-e2e.sh` mirrors this step for the E2E build, and
  `check:pack` (`src/pack-check.ts`, `scripts/check-pack.mjs`) verifies that every copied runner
  asset is present in the release tarball.

### 4. Keep native mock CLIs in `scripts/`, resolved through `nativeMockPath`

- The six native mock CLIs and their shared helpers stay in `scripts/`.
- `@hearsay-tools/squawk/plugin/runtime` exports `nativeMockPath(mock)` (`src/core/native-mock.ts`).
  It resolves `RunnerMock.script` against the running installation's `scripts/` folder and throws
  an error naming the script when the installation does not ship it.
- Every dry-run site in runner code and `src/core/skill-probe.ts` calls `nativeMockPath(mock)`
  instead of constructing a relative path into `scripts/`.

### 5. Boot without bundled runners through a test-only option

- `bootRuntime` accepts an optional `bundledRunnersDir` alongside `pluginsDir`, and
  `loadBundledRunners(dir)` reads that folder when given. Only tests and the wrapper script pass
  it; no user-facing environment variable or CLI flag exists for it.
- `test/e2e/support/hsq-without-bundled.mjs` boots the built product with an empty bundled-runners
  folder and `<config>/plugins/`, then runs `dist/hsq.js` in the same process so the CLI reuses
  that boot. Copied bundled runners keep their real ids without key conflicts.

### 6. Enforce self-containment with two guards

- **Static guard (`cez/runner-folder-escape`).** In every non-test JS/TS file under
  `src/runners/<id>/` (`fixture/` and `__fixtures__/` aside), the rule (`src/lint/runner-folder-escape.ts`)
  forbids:
  - relative escapes out of the runner folder via `new URL(…, import.meta.url)`, `join`/`resolve`
    with literal `'..'` segments, or relative imports/exports/`require`;
  - non-relative package imports other than `node:*` built-ins and `@hearsay-tools/squawk/plugin*`.
  Each bundled runner has a shrink-only baseline file
  `src/lint/runner-folder-escape/<id>.baseline.json`. The initial 40 sites across the six runners
  drained to 0 entries (`[]`), and all six empty baselines remain checked by `npm run lint` and
  CI's baseline-growth gate. `cez/runner-core-import` stays unchanged alongside it.
- **Runtime copy-out guard (`test/e2e/runner-copy-out.test.ts`).** Packs and installs the release
  tarball into a temp consumer, copies every installed `dist/runners/<id>/` folder unchanged into
  a sandbox `<config>/plugins/<id>/` under `/tmp`, asserts that no `node_modules` folder exists in
  any ancestor directory (`assertNoNodeModulesAncestor`), verifies all six runners load as host
  plugins with 0 bundled runners and 0 failures, and runs a `HSQ_DRY_RUN=1` task on each runner
  through `hsq-without-bundled.mjs` with no expected failures.

### 7. Verify each copied runner on its real CLI

- Every bundled runner (`claude`, `codex`, `antigravity`, `pi`, `omp`, `opencode`) completed a
  live task on its real CLI after copying its built `dist/runners/<id>/` folder unchanged into a
  sandbox `<config>/plugins/<id>/` with no `node_modules` ancestor and booting through
  `hsq-without-bundled.mjs`. The spec's implementation record logs all six sanitized runs.

## Consequences

- **Bundled runners prove the outside-runner contract.** Any regression that introduces a
  product-relative path or a third-party dependency in a bundled runner fails `npm run lint`
  immediately and fails `runner-copy-out.test.ts` in packaged E2E.
- **Copied runners keep dry-run parity.** Because `nativeMockPath(mock)` resolves against the
  running installation's `scripts/`, a copied bundled runner runs under `HSQ_DRY_RUN=1`, while a
  runner naming a mock the installation lacks gets a clear error naming the missing script.
- **New bundled runners start clean.** Adding a bundled runner adds an empty
  `src/lint/runner-folder-escape/<id>.baseline.json`, puts any product `.mjs` assets inside
  `src/runners/<id>/`, and is covered automatically by `copy-runner-assets.mjs`, `check:pack`,
  and `runner-copy-out.test.ts`.
- **Deferred work stays out of scope.** Moving runners out of this repository, installing plugins
  from npm or git, stabilizing the plugin API, and adding new extension slots wait for later
  roadmap steps.

## Considered Options

- **Add a `@hearsay-tools/squawk/plugin/zod` subpath.** Rejected. The main entry already loads
  `zod`, so a new public subpath would add surface without shrinking boot closure.
- **Provide a kit helper that each runner calls to set `HSQ_TOOL_CLIENT`.** Rejected.
  `CiToolController.provision()` already builds the tool environment for every session, so setting
  `HSQ_TOOL_CLIENT` there covers every runner with no per-runner boilerplate.
- **Rewrite runner `.mjs` extensions as `.ts` for `tsc` to emit.** Rejected. Pi keys skill
  sources on `extension:pi-project-skills.mjs`, so changing the extension between source and
  `dist/` would break the catalog key.
- **Move each mock CLI into its runner folder.** Rejected. All six mocks share roughly 1,300 lines
  of helpers and third-party dependencies, and dozens of tests and lint rules expect
  `scripts/mock-*.mjs`.
- **Expose an environment variable to disable bundled runners.** Rejected. It would add a
  user-facing knob for a test-only requirement; `bootRuntime({ bundledRunnersDir })` stays
  internal to tests and `hsq-without-bundled.mjs`.

Implementation and reader rules: [plugins](../plugins.md), [runners area](../areas/runners.md),
[AGENT_PROTOCOL.md § 10](../../AGENT_PROTOCOL.md#10-adding-a-new-runner-the-open-mercatocezar387-pi-checklist),
and the spec's [implementation record](../../.ai/specs/2026-11-25-self-contained-runner-folders.md#implementation-record).

Coverage under `packages/cezar/`: `src/core/native-mock.test.ts`, `src/core/skill-probe.test.ts`,
`src/ci-wait/controller.test.ts`, `src/lint/runner-folder-escape.test.ts`, `src/pack-check.test.ts`,
`src/boot.test.ts`, `src/plugin/loader.test.ts`, `src/plugin/resolve-hook.test.ts`,
`test/e2e/runner-copy-out.test.ts`, and `test/e2e/package-cli.test.ts`.
