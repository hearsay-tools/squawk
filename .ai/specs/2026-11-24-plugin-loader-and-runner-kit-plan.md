# Plugin loader and runner kit: plan
Status: active

The plan for [the spec](2026-11-24-plugin-loader-and-runner-kit.md), epic
hearsay-tools/squawk#4188. Baseline: `main` at `a7b4165bf`. Each slice is one pull request into
`main` and one child issue. Check each slice against current `main` before it starts.

## Rules for every slice

- `main` stays usable after each slice at shipped defaults.
- Follow ADR 0065 (with rule 3 amended per owner decision 1) and ADR 0069 (no production
  `unseal()`).
- Slices running in parallel must not edit overlapping hunks or violate semantic prerequisites;
  every ready branch passes the coordinator's actual-overlap release check before opening a PR.
- Follow `docs/areas/packages.md` ("Moving a source file") before moving any module.
- Slices that add the kit entry or move runner loading behind registration record Squeal selection
  counts before and after in their PR body (roadmap rule 5).
- Preserve cold-CLI lazy loading (`packages/cezar/src/index-runners.test.ts` and
  `index-run-slots.test.ts`) and per-runner closure isolation (`core/runner-closure.test.ts`).
- Keep `AGENTS.md` citation discipline: always use repository-qualified references
  (`hearsay-tools/squawk#N`), never bare `#N`.

## Order and waves

| Wave | Slices | Starts after | Phase exit on integrated `main` |
| --- | --- | --- | --- |
| 0 | Spec & plan PR | — | Spec, plan, roadmap link, and all 15 child issues live on `main` |
| 1 | A1, A2, A3, D1 (parallel, 4 workers) | Wave 0 merged | Single seal module (`boot.ts`); plugin API + staging + lifecycle registry + `./plugin` export; unknown runner ids preserved in stored configs; `feature:runner-install` layer + manifest parser (`#4100`) green |
| 2 | B1 (isolated) | A2, D1 merged | Complete runner kit exported via `@hearsay-tools/squawk/plugin`; shared runner helpers extracted; shrink-only `cez/runner-core-import` lint rule + initial baseline green |
| 3 | B2–B7 + C1 (up to 4 parallel; B2–B7 coordinate baseline merges) | B2–B7 after B1; C1 after A1 + A2 | `runner-core-import.baseline.json` at 0 entries; host-folder plugin loader, `registerHooks`, rollback/skip, health payload, and plugin CLI commands green |
| 4 | C2 (isolated) | B2–B7, C1 merged | Built-in runners load via plugin loader; `runners/built-in.ts` and `runners/ids.ts` deleted; build, `check:pack`, `test:package`, `runner-closure.test.ts`, and `simulate-sixth-runner.test.mjs` green |
| 5 | D2 | A3, C2 merged | External plain-JS fixture runner package test passes; live `pi` acceptance run from `<config>/plugins/` verified on real `pi` CLI |
| 6 | E1 | D2 merged | ADR 0070 merged, ADR 0065 rule 3 amended, docs updated, final Squeal counts recorded, spec `Status: done`, `-plan.md` deleted, roadmap updated |

## A1. Unify boot registration and sealing into one function

Issue: hearsay-tools/squawk#4198.

- Add `packages/cezar/src/boot.ts` (layer: `shell`) exporting `bootColdCli()` and
  `bootRuntime(options?)`.
  - `bootColdCli()` registers built-in CLI commands and seals `cli-registry` only.
  - `bootRuntime()` registers all built-ins (CLI commands, runners, removal slots, worker
    executions, workflow step kinds, agent tools, wait kinds), runs an optional extension hook
    before seal, and seals all seven registries in one place (idempotent).
- Update `packages/cezar/src/index.ts`, `packages/cezar/src/subcommands.ts`,
  `packages/cezar/src/cli-dispatch.ts`, and `packages/cezar/src/home/entry.ts` so no production
  file outside `boot.ts` (and the registry definition modules) calls any `seal*()` function.
- Add `packages/cezar/src/boot.test.ts` verifying unified boot, idempotency, cold-CLI isolation,
  and a static source scan proving no other production file seals a registry.
- Verify `index-runners.test.ts`, `index-run-slots.test.ts`, `home/entry.test.ts`, and `npm run prepr`.

## A2. Plugin API object, transactional staging, run-lifecycle registry, and ./plugin export

Issue: hearsay-tools/squawk#4199.

- Add `packages/cezar/src/runs/lifecycle-registry.ts` using `createListRegistry<RunLifecycleHandlers>`
  from `core/registry.ts` (`registerRunLifecycleListener`, `sealRunLifecycleListeners`,
  `runLifecycleListenersSealed`, `registeredRunLifecycleListeners`). Wire `RunStore` to subscribe
  registered listeners on open (when sealed) and unsubscribe on `store.closed`.
- Add `packages/cezar/src/plugin/api.ts` defining `SquawkPlugin`, `SquawkPluginApi`
  (`registerRunner`, `registerAgentTool`, `registerWaitKind`, `registerStepKind`,
  `registerCliCommand`, `registerRemovalSlots`, `onRunLifecycle`), and `runPluginSetup` with
  all-or-nothing transactional staging (validating key conflicts and reserved legacy keys before
  committing any entry).
- Add `packages/cezar/src/plugin/index.ts` re-exporting the plugin API types.
- Expose `"./plugin"` in `packages/cezar/package.json` (`exports`), update `packages/cezar/src/lint/layers.json`
  for `plugin/`, and configure monorepo resolution (`tsconfig.json`, `vitest.config.ts`) so
  `@hearsay-tools/squawk/plugin` resolves in source, tests, and built `dist/`.
- Add unit tests for `runs/lifecycle-registry.ts` and `plugin/api.ts` (commit, throw rollback,
  conflict rollback, legacy reserved-key rollback, multi-store lifecycle delivery + close cleanup).

## A3. Preserve unknown runner ids in stored config and account decoders

Issue: hearsay-tools/squawk#4200.

- Add `storedRunnerIdSchema` (non-empty trimmed string, bounded length, no control chars) in
  `packages/cezar/src/core/runner-id-schema.ts` alongside `registeredRunnerIdSchema()`.
- Update `packages/cezar/src/workspace/config.ts`:
  - `agentDefaults.runner` keeps unregistered valid runner ids.
  - `disabledProviders` preserves unregistered valid runner ids alongside registered ones.
- Update `packages/cezar/src/workspace/agent-accounts.ts`:
  - `agentAccountSchema.provider` keeps rows for unregistered valid runner ids; continues rejecting
    `supportsProfiles === false` for registered runners.
- Update `packages/cezar/src/config.ts`:
  - `defaultRunner` and `defaultModels` preserve unregistered runner ids on decode while runtime
    resolution still falls back via `resolveRunnerId()`.
- Keep HTTP write routes strict (`server/unknown-runner-refusals.test.ts` must stay green).
- Add unit tests covering every row of the spec's stored-config preservation case table.

## D1. Managed CLI installer layer and per-runner manifest parser

Issue: hearsay-tools/squawk#4100.

- Move `managed-install/` and runner-install routes to `feature:runner-install` in
  `packages/cezar/src/lint/layers.json` (no new baseline entries in `layer-import.baseline.json`).
- Extend `ManagedCliSource` (`core/managed-cli-source.ts`) with a per-runner manifest parser hook
  returning `{ version, url, digest: { algorithm, value } }`, keeping download-prefix check, size
  bound, digest verification, storage layout, and leases intact.
- Migrate Antigravity onto the hook with unchanged behavior.
- Add a fixture runner test proving a second manifest shape installs through the same routes.

## B1. Runner kit surface and shrink-only runner-core-import lint rule

Issue: hearsay-tools/squawk#4201.

Starts after: A2, D1 merged.

- Move shared runner helpers (`runners/login-output.ts`, `runners/mock-prompts.ts`,
  `runners/project-agents-file.ts`, `runners/agent-config-notes.ts`, and shared Pi-RPC helpers
  from `runners/pi/pi-rpc-wire.ts` and `runners/pi/pi-rpc-turn.ts`) into leaf core/kit modules.
- Create `packages/cezar/src/plugin/runner-kit.ts` exporting every core helper, type, shared
  runner utility, `agent-config/model-settings/shared.ts` helper, and `feature:runner-install`
  hook needed by all six built-in runners; re-export it from `packages/cezar/src/plugin/index.ts`.
  Keep the kit module free of mutable state.
- Add AST lint rule `cez/runner-core-import` (`packages/cezar/src/lint/runner-core-import.ts`)
  and shrink-only baseline `packages/cezar/src/lint/runner-core-import.baseline.json` (wired into
  `.github/scripts/baseline-growth.cjs`), flagging every static or dynamic relative import from
  `packages/cezar/src/runners/<id>/` (non-test, excluding `fixture/`) that resolves outside
  `runners/<id>/`.
- Add unit tests in `packages/cezar/src/lint/` for `cez/runner-core-import`.
- Record Squeal selection counts before and after for `core/registry.ts`,
  `core/runner-registry.ts`, and `plugin/index.ts`.

## B2. Migrate claude runner onto the runner kit

Issue: hearsay-tools/squawk#4202. Starts after: B1 merged.

- Move `packages/cezar/src/agent-config/model-settings/claude.ts` into
  `packages/cezar/src/runners/claude/` (updating `layers.json` and tests).
- Replace all outside relative imports in non-test `runners/claude/**` files with
  `@hearsay-tools/squawk/plugin`.
- Remove all `runners/claude/` entries from `runner-core-import.baseline.json`.
- Verify claude unit/parity tests and `core/runner-closure.test.ts`.

## B3. Migrate codex runner onto the runner kit

Issue: hearsay-tools/squawk#4203. Starts after: B1 merged.

- Move `packages/cezar/src/agent-config/model-settings/codex.ts` into
  `packages/cezar/src/runners/codex/` (updating `layers.json` and tests).
- Replace all outside relative imports in non-test `runners/codex/**` files (including
  `../pi/pi-rpc-wire.ts`) with `@hearsay-tools/squawk/plugin`.
- Remove all `runners/codex/` entries from `runner-core-import.baseline.json`.
- Verify codex unit/parity tests and `core/runner-closure.test.ts`.

## B4. Migrate opencode runner onto the runner kit

Issue: hearsay-tools/squawk#4204. Starts after: B1 merged.

- Move `packages/cezar/src/agent-config/model-settings/opencode.ts` into
  `packages/cezar/src/runners/opencode/` (updating `layers.json` and tests).
- Replace all outside relative imports in non-test `runners/opencode/**` files with
  `@hearsay-tools/squawk/plugin`.
- Remove all `runners/opencode/` entries from `runner-core-import.baseline.json`.
- Verify opencode unit/parity tests and `core/runner-closure.test.ts`.

## B5. Migrate pi runner onto the runner kit

Issue: hearsay-tools/squawk#4205. Starts after: B1 merged.

- Move `packages/cezar/src/agent-config/model-settings/pi.ts` into
  `packages/cezar/src/runners/pi/` (updating `layers.json` and tests).
- Replace all outside relative imports in non-test `runners/pi/**` files with
  `@hearsay-tools/squawk/plugin`.
- Remove all `runners/pi/` entries from `runner-core-import.baseline.json`.
- Verify pi unit/parity tests and `core/runner-closure.test.ts`.

## B6. Migrate omp runner onto the runner kit

Issue: hearsay-tools/squawk#4206. Starts after: B1 merged.

- Replace all outside relative imports in non-test `runners/omp/**` files (including
  `../pi/pi-rpc-wire.ts` and `../pi/pi-rpc-turn.ts`) with `@hearsay-tools/squawk/plugin`.
- Remove all `runners/omp/` entries from `runner-core-import.baseline.json`.
- Verify omp unit/parity tests and `core/runner-closure.test.ts`.

## B7. Migrate antigravity runner and acp onto the runner kit

Issue: hearsay-tools/squawk#4207. Starts after: B1 merged.

- Move `packages/cezar/src/runners/acp/` into `packages/cezar/src/runners/antigravity/acp/`
  (updating `layers.json` and ACP tests).
- Replace all outside relative imports in non-test `runners/antigravity/**` files with
  `@hearsay-tools/squawk/plugin`.
- Remove all `runners/antigravity/` entries from `runner-core-import.baseline.json` (reaching 0
  entries once B2–B7 are all merged).
- Verify antigravity + ACP unit/parity tests and `core/runner-closure.test.ts`.

## C1. Host-folder plugin loader, resolve hook, failure reporting, and plugin CLI commands

Issue: hearsay-tools/squawk#4208. Starts after: A1 and A2 merged.

- Add `readonly plugins: string` (`join(config, 'plugins')`) to `Home` in `home/home.ts`.
- Add `packages/cezar/src/plugin/resolve-hook.ts` installing `node:module` `registerHooks` to map
  `@hearsay-tools/squawk/plugin` to the running Squawk copy (source `.ts` or built `dist/*.js`).
- Add `packages/cezar/src/plugin/loader.ts` discovering `<config>/plugins/*` in sorted folder-name
  order, importing `index.mjs` or `index.js`, executing `runPluginSetup`, recording `loaded` and
  `failed` entries, and logging stderr warnings for skipped plugins.
- Wire loader + `runs/lifecycle-registry.ts` seal into `packages/cezar/src/boot.ts`.
- Support plugin CLI commands in `cli-dispatch.ts` / `subcommands.ts`: keep cold commands and
  `hsq --help` cold (with footer note pointing to `hsq plugins`); trigger `bootRuntime()` on
  unknown command names before `unknown command` refusal; add `hsq plugins` subcommand.
- Add `plugins` summary to `GET /api/v1/health` (`packages/contract/src/health.ts`,
  `packages/cezar/src/server/server.ts`), redacting host paths when `HSQ_REMOTE=1`.
- Add unit tests covering every row of the spec's boot and plugin loading case table.

## C2. Load built-in runners through the plugin loader and remove runners/built-in.ts and runners/ids.ts

Issue: hearsay-tools/squawk#4209. Starts after: B2–B7 and C1 merged.

- Add `index.ts` plugin entry to each built-in runner folder `packages/cezar/src/runners/<id>/`
  and preserve display order (`claude, codex, opencode, pi, omp, antigravity`).
- Update `boot.ts` / `plugin/loader.ts` to load bundled runners from the bundled runners directory
  through the same loader and `SquawkPluginApi` before `<config>/plugins/`.
- Delete `packages/cezar/src/runners/built-in.ts`, `packages/cezar/src/runners/ids.ts`, and
  `packages/cezar/src/lint/runner-ids-import.ts`.
- Add a zero-runner-import bundled-runner-folder discovery helper for tests, `vitest.setup.ts`,
  lint rules, and scripts; verify `core/runner-closure.test.ts` stays green.
- Update `packages/cezar/src/pack-check.ts`, `.ai/scripts/simulate-sixth-runner.mjs`, and
  `scripts/simulate-sixth-runner.test.mjs`; verify `npm run build`, `npm run check:pack`, and
  `npm run test:package`.

## D2. External fixture runner package test and live pi acceptance run

Issue: hearsay-tools/squawk#4210. Starts after: A3 and C2 merged.

- Add an integration test that creates a plain-JS (`index.mjs`) fixture runner package in a
  temporary directory outside the repository, imports ONLY `@hearsay-tools/squawk/plugin`, loads
  it from `<config>/plugins/`, runs a task to the review gate, and proves stored settings
  (`agentDefaults.runner`, `disabledProviders`, `agent-accounts.json`) survive a restart where
  that plugin fails to load.
- Run a live acceptance check loading the real `pi` runner from a sandbox `<config>/plugins/`
  folder (isolated from bundled `pi`) and completing a real task on the real `pi` CLI; record
  the exact command, output, and transcript evidence.

## E1. ADR 0070, ADR 0065 amendment, docs, and spec close-out

Issue: hearsay-tools/squawk#4211. Starts after: D2 merged.

- Write `docs/adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md`.
- Amend `docs/adr/0065-define-the-core-by-a-layer-map.md` rule 3 per owner decision 1.
- Document `<config>/plugins/` (in-process execution with all of Squawk's permissions and logins,
  unstable API notice, hosted mode policy) and update `docs/areas/runners.md`,
  `docs/areas/cli.md`, `docs/areas/http-api.md`, and `AGENT_PROTOCOL.md` §10.
- Record final Squeal selection counts for `core/registry.ts`, `core/runner-registry.ts`, and
  `plugin/index.ts`.
- Mark `.ai/specs/2026-11-24-plugin-loader-and-runner-kit.md` `Status: done` with complete
  implementation record, delete `.ai/specs/2026-11-24-plugin-loader-and-runner-kit-plan.md`, and
  update `.ai/specs/2026-11-18-plugin-core-roadmap.md` Step 4 row to Done.
