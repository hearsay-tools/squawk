# Self-contained runner folders: plan
Status: active

The slices of [the spec](2026-11-25-self-contained-runner-folders.md), epic
hearsay-tools/squawk#4232. Each slice is one child issue and one pull request into `main`.
`main` stays usable after each one. Paths are under `packages/cezar/` unless noted.

## Order

```text
A0 (this spec and plan)
├── A2 kit and core ─────────────┐
└── A3 static guard ── A1 harness ┴── B1 claude, B2 codex, B3 antigravity, B4 pi + omp, B5 opencode ── E close-out
```

A2 and A3 run in parallel. A1 starts when A3 has merged; A2 may still run. B1 to B5 start when
A1 and A2 have merged, and run in parallel: their files are disjoint. E starts when B1 to B5
have merged.

## Slices

| Slice | Changes | Files | After |
|---|---|---|---|
| A2 Kit and core | `export { z } from 'zod'` in the kit's main entry. `HSQ_TOOL_CLIENT` in `CiToolController.provision()`, written through `productEnvEntries`, and documented in `.env.example`. A kit function `nativeMockPath(mock)` that resolves `RunnerMock.script` against the running copy's `scripts/` and throws an error naming the script when the file is absent; `core/skill-probe.ts` uses it. A `postbuild` step that copies non-test `.mjs` files from `src/runners/<id>/` to `dist/runners/<id>/`, and a `check:pack` check for each copied file. `package-cli.test.ts` drops its three `scripts/*` product-script entries; `check:pack` covers them from now on. Records the rule-5 count for `src/plugin/index.ts` before and after | `src/plugin/runner-kit.ts`, `src/plugin/runtime.ts`, `src/ci-wait/controller.ts`, `src/core/skill-probe.ts`, `src/core/runner-definition.ts`, `package.json`, `scripts/copy-runner-assets.mjs`, `src/pack-check.ts`, `test/e2e/package-cli.test.ts`, `.env.example` | — |
| A3 Static guard | Lint rule `cez/runner-folder-escape` as the spec's decision 6 describes, with one baseline file per runner (`src/lint/runner-folder-escape/<id>.baseline.json`) that holds that runner's sites on the slice's base commit. Rule tests cover each reported form: `new URL('../…')`, `join`/`resolve` with `'..'` segments, a relative import out of the folder, a package import, and the allowed forms | `src/lint/runner-folder-escape.ts`, its test, `src/lint/plugin.ts`, the six baseline files, `docs/sdlc/lint.md` | — |
| A1 Harness and copy-out test | `bootRuntime({ bundledRunnersDir })` and `loadBundledRunners(dir)`, test-only. The wrapper `test/e2e/support/hsq-without-bundled.mjs`. `test/e2e/runner-copy-out.test.ts` installs the tarball, copies the six `dist/runners/<id>/` folders unchanged into `<config>/plugins/`, and runs one `HSQ_DRY_RUN=1` task on each through the wrapper. The sandbox home sits under `/tmp`, and the test asserts that no `node_modules` folder is above the plugin folder. A runner whose A3 baseline file holds an entry is expected to fail; a pass then fails the test | `src/boot.ts`, `src/plugin/loader.ts`, their tests, the new test and wrapper | A3 |
| B1 claude | `z` from the kit. `claude-executable.ts` calls `nativeMockPath`. Empties `claude.baseline.json`. Live run | `src/runners/claude/**`, its baseline | A1, A2 |
| B2 codex | `z` from the kit. `codex-app-server-transport.ts` calls `nativeMockPath`. Empties its baseline. Live run | `src/runners/codex/**`, its baseline | A1, A2 |
| B3 antigravity | `z` from the kit in 16 files. `antigravity-runner.ts` and `antigravity-skill-catalog.ts` call `nativeMockPath`. Empties its baseline. Live run | `src/runners/antigravity/**`, its baseline | A1, A2 |
| B4 pi + omp | The five Pi scripts move to `src/runners/pi/extensions/`, and `omp-ci-wait.mjs` to `src/runners/omp/`, with their `.d.mts` siblings. Both ci-wait scripts import the client from `HSQ_TOOL_CLIENT`; `omp-ci-wait.mjs` keeps its fallback to the checkout's built client, found from that URL (spec decision 2). `pi-project-skills.mjs` gets a `home-readers` baseline entry, because it now sits under `src/`. The tests that load the scripts follow them, and the tests that match `/scripts\/<name>$/` match the new paths. `z` and the mock sites move to the kit. `package-cli.test.ts` and `test/fixtures/installed-ci-probe.ts` import the extensions from `dist/runners/` with `HSQ_TOOL_CLIENT` set. Two live runs | `src/runners/pi/**`, `src/runners/omp/**`, their baselines, `scripts/pi-*.mjs`, `scripts/omp-ci-wait.mjs`, `test/e2e/package-cli.test.ts`, `test/fixtures/installed-ci-probe.ts`, `src/lint/home-readers.baseline.json`, `docs/sdlc/lint.md` (the `pi-project-skills.mjs` line) | A1, A2 |
| B5 opencode | `opencode-task-scope.mjs` and its `.d.mts` move to `src/runners/opencode/`. `z` and the mock site move to the kit. Empties its baseline. Live run | `src/runners/opencode/**`, its baseline, `scripts/opencode-task-scope.*` | A1, A2 |
| E Close-out | E starts only when all six live runs have passed, or the owner has decided on each missing one (spec decision 7). The copy-out test loses its expected-failure branch. The rule keeps its six empty baselines. Docs: `docs/plugins.md`, `docs/areas/runners.md`, `AGENT_PROTOCOL.md` § 10 and the `RunnerMock.script` comment. ADR 0070 amended, or a new ADR if the decisions outgrow an amendment. The spec goes to `Status: done` with an implementation record of the slices, the rule-5 counts and the six live runs. This plan is deleted. The roadmap marks the epic done | docs, ADR, `.ai/specs/` | B1–B5 |

B4 holds both Pi-family runners because their extensions share one form and one client import,
and `package-cli.test.ts` imports both.

## Verification for every slice

- Squeal on the changed files, then `npm run prepr`.
- `HSQ_DRY_RUN=1` still runs each runner on its mock: the existing dry-run and parity suites.
- From A1 on: the copy-out test in CI's package e2e job, with the expected failures shrinking
  as each runner slice lands.
- Each runner slice: a live run of its runner, copied unchanged from the built `dist/` into
  `<config>/plugins/` and started through the wrapper, on its real CLI, to a finished task. The
  PR records the result with no host path, host name or login.

## Acceptance checks in E

| Epic criterion | Check |
|---|---|
| Every child closed, spec done, ADR | The issue list, the spec status, the ADR file |
| A test copies the six built folders and runs a task on each | `runner-copy-out.test.ts` passes in CI with no expected failure |
| No relative path out of `runners/<id>/`, and a guard holds it | The six baselines are empty, and the rule runs in `npm run lint` |
| No `npm install` for a copied folder | The copy-out test's no-`node_modules` assertion, and the rule's package check |
| Pi, OMP and OpenCode scripts find the client with no product-relative path | B4 and B5 diffs; the ci-wait scripts read `HSQ_TOOL_CLIENT` |
| `HSQ_DRY_RUN=1` runs every bundled runner on its mock | The dry-run and parity suites in CI |
| Each runner completes a task on its real CLI from `<config>/plugins/` | The six live-run records |
