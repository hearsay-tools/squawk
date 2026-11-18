# Runner definitions: implementation plan
Status: active

Plan for [the runner definitions spec](2026-11-18-runner-definitions.md), epic
hearsay-tools/squawk#3824. The spec holds the design and the owner's four decisions; this file
says how the work is cut. Baseline: `main` at `535ce2bdd`. Ten slices, one pull request and
one child issue each. Delete this file when slice D2 merges.

## Order

| Slice | Starts after | Why |
| --- | --- | --- |
| A1. `AgentSession` type imports | now | Six one-line imports; nothing else depends on it |
| A2. Move each runner into its folder | A1 | A mechanical move; every later slice edits files at their new paths |
| A3. Definition type, registry, built-in list | A2 | Every B, C and D slice fills or reads the definition |
| B1. Facts, spec support, detection, CLI, install source | A3 | Parallel with B2 and B3: each moves different tables |
| B2. Login, accounts, home paths, identity, environment | A3 | Parallel with B1 and B3 |
| B3. Models, skills, config files, extra tools, tool injection | A3 | Parallel with B1 and B2 |
| C1. Runners route and open runner id | B1, B2, B3 | The route sends the parts that B1 to B3 put in the definition |
| C2. The cockpit reads the route | C1 | It reads the route that C1 adds |
| D1. Parity kit on a definition; fixture runner | B1, B2, B3 | Runs beside C1 and C2: it touches tests, the kit and the mock list |
| D2. Docs, ADR, spec close-out | C2, D1 | It describes what the other slices leave |

Hot files: `lint/layers.json` and the two lint baselines (A2, A3, B3, C1);
`core/runner-registry.ts` and the definition type (every B slice adds parts). B slices add
their parts to the type in separate, adjacent blocks, so their merges conflict at most in the
type's field list. Each slice lands on `main` before the next slice that shares a hot file
starts, and its issue is checked against the new `main` before dispatch.

## Rules for every slice

- No behavior change. A moved table keeps its values; a reader reads the same value from the
  definition. Tests that pin a value keep pinning it.
- No alias, fallback or re-export from an old path. Saved runs, transcripts and config still
  open.
- Each slice removes the tables it moves. A table keyed by runner id never exists in two places
  at the end of a slice.
- Each slice follows the reader sweep in
  [CODE_REVIEW.md](../../CODE_REVIEW.md#changing-working-behavior) for each name it moves.
- A slice that moves a file updates `lint/layers.json` and `file-length.baseline.json` in the
  same change.
- `main` stays usable at shipped defaults after each slice.

## A1. `AgentSession` type imports

`workflows/run/input-delivery.ts`, `steps.ts`, `turn-markers.ts`, `turn-nudges.ts`,
`turn-settler.ts` and `worker-executions.ts` import `type AgentSession` from
`core/agent-runner.ts` in place of `core/claude-cli-runner.ts`.

**Done when:** the six `runner` entries for these files are gone from
`layer-import.baseline.json` (13 → 7).

## A2. Move each runner into its folder

`git mv` each runner's files to `packages/cezar/src/runners/<id>/`: `core/<id>-*` source and
tests, the `harness-<id>-*` and `waits-<id>-*` parity files, and `core/__fixtures__/<id>/`.
File names keep their runner prefix. `lint/layers.json` maps `runners/` to `runner` and drops
the `core/<id>-*` patterns. `core/host-skill-catalog.ts` stays where it is until B3. The mock
scripts stay in `packages/cezar/scripts/`.

Update every import, the Vitest and Squeal path selections that name `core/<id>-*`, the
golden fixture paths, `.ai/scripts/` catalogs that list parity files, and the doc links
(`docs/areas/runners.md`, `AGENT_PROTOCOL.md`).

**Done when:** no file under `core/` starts with a runner id, the moved tests pass, and the
`runner` baseline entries name the new paths.

## A3. Definition type, registry, built-in list

- `core/runner-definition.ts`: `RunnerDefinition` with `id`, `facts`, `loadAdapter`, and
  `defineRunner`. Later slices add parts.
- `runners/<id>/definition.ts` for each built-in runner, with its `facts` (moved from
  `RUNNER_FACTS`) and `loadAdapter`.
- `runners/built-in.ts`: the five definitions in display order, each passed to
  `registerRunner`.
- `core/runner-registry.ts`: `registerRunner`, `runnerDefinition`, `registeredRunners`,
  `isRegisteredRunner`, the default runner, the legacy id map (`claude-cli`), and async
  `createRunner`. It replaces `core/runner-factory.ts`. `RunnerFactory` returns
  `Promise<AgentRunner>`; `step-session.ts`, `planner.ts` and `runs/auto-name.ts` await it.
- `RUNNER_FACTS` and `runnersWhere` read the registry; `RUNNER_IDS` derives from
  `runners/built-in.ts`.
- `cez/layer-import` allows `core/runner-registry.ts`, not `core/runner-factory.ts`.
  `cez/runner-id-branch` and `cez/runner-roster-literal` read the ids from
  `runners/built-in.ts`.
- `runnerIdOf` and the about 14 sites that write `'claude'` as the fallback read the
  registry's default.

**Tests:** the registry refuses a duplicate id; an unknown id gets the Claude runner; loading
the registry loads no adapter module (hearsay-tools/cezarion#2939); `runner-facts.test.ts`
reads the definitions.

## B1. Facts, spec support, detection, CLI, install source

Move into the definition: `specSupport` from each runner class (the class reads it from its
definition), `RUNNER_PROBES` (`core/backend-detect.ts`), `RUNNER_CLI` (`core/runner-cli.ts`,
with OMP's executable resolution, so `runner-cli.ts` stops importing `omp-model-catalog.ts`),
and `AGENT_CLI_SOURCE` (`server-install/steps.ts`).

**Done when:** those four tables are gone and the `runner-cli.ts` baseline entry is removed.

## B2. Login, accounts, home paths, identity, environment

Move into the definition: the `DESCRIPTORS` entry (`core/provider-auth.ts`), `ACCOUNT_LAYOUT`
and `PROFILE_DIR_MARKERS` (`core/agent-profiles.ts`), `AGENT_HOME_SLOT` (`paths.ts`),
`IDENTITY_SOURCE` (`agent-config/account-identity.ts`), `BACKEND_ALLOW_PREFIXES`
(`core/agent-env.ts`), and the per-runner keys in `config.ts`, `workspace/config.ts` and
`workspace/agent-accounts.ts`. Config keys that are an object with one key per runner become a
record keyed by a registered id, checked against the registry when config loads. A saved key
for an unregistered runner is kept and ignored, so the file still loads.

**Done when:** those tables are gone and every config file written before the slice still
loads with the same values.

## B3. Models, skills, config files, extra tools, tool injection

Move into the definition: `KNOWN_PRESETS_BY_RUNNER` (`core/model-presets.ts`),
`BACKEND_MODEL_MAP` (`core/model-identity.ts`), `MODEL_SETTINGS_STRATEGIES`
(`agent-config/models.ts`), the native config file rows (`agent-config/catalog.ts`),
`HARNESS_EXTRA_TOOLS` (`workflows/types.ts`), and the OpenCode tool injection
(`ci-wait/injection.ts`, as `toolInjection`). `core/host-model-catalog.ts` and
`core/host-skill-catalog.ts` call `loadModelCatalog` and `loadSkillCatalog`;
`host-skill-catalog.ts` moves to the `core` layer. The cockpit's own preset lists stay until C2 removes
them.

**Done when:** `layer-import.baseline.json` holds no `runner` entry.

## C1. Runners route and open runner id

Breaking change: the PR title carries `!`.

- Contract: `runnerSchema` becomes `z.string().min(1)`; `runnersResponseSchema`;
  `RUNNER_COCKPIT_FACTS` and `runner-facts.ts` leave the contract, with their display data in
  the definitions' `display` part. `per-runner-optional-strings.ts` and `workspace.ts` use a
  record keyed by string.
- `UiBackend` in `core/ui-events.ts` and in `packages/api-client/src/protocol/ui-events.ts`
  becomes `string`.
- Server: `GET /api/v1/runners`; run requests, automation definitions, provider requests and
  config writes check the id with `isRegisteredRunner` and give the refusal that the enum gives
  today. `health`'s `checks` name a runner by a string.
- The cockpit reads `runnerDisplayName` and `runnerModelListName` from the route.

**Done when:** `runner-roster-literal.baseline.json` holds no entry and an unknown runner id on
each request route gets the same status and message as before the slice.

## C2. The cockpit reads the route

Remove `MODELS_BY_RUNNER`, `RETIRED_MODEL_IDS`, `PROVIDER_INSTALL`, `FOLDER_EXAMPLE`,
`FOLDER_HINT`, the map in `provider-settings.tsx`, the icon map in `open-in-menu.tsx`,
`RUNNER_NAMES` and the runner rows of `AGENT_DESCRIPTORS`. Each reader takes the runner's entry
from the route's query. The pickers stay disabled until the query answers. The
[state restore cases](2026-11-18-runner-definitions.md#state-restore-cases) hold.

**Done when:** no non-test file under `packages/web/src` or `packages/contract/src` holds a
table keyed by runner id, and the browser specs for the new-task form, settings and the tools
menu pass.

## D1. Parity kit on a definition; fixture runner

- The parity kit and the waits fixture take a `RunnerDefinition`; `HARNESS_ADAPTERS` reads the
  `mock` part. `MOCKS` (`core/skill-probe.ts`) and `lint/mock-scenario-boundary.ts` read the
  registry.
- `runners/fixture/` (test files only): a definition over a small mock script in
  `packages/cezar/scripts/`. One test registers it, runs a task to review and runs the kit on
  it.

**Done when:** the fixture runner and the five built-in runners pass the kit, and adding the
fixture changed no file outside `runners/fixture/` and its mock script.

## D2. Docs, ADR, spec close-out

- New ADR: each runner is one registered definition.
- `AGENT_PROTOCOL.md` §10 names only files in `runners/<id>/` plus the mock script;
  `docs/areas/runners.md` describes the definition and the registry.
- The spec gets an implementation record and `Status: done`; this plan file is deleted; the
  roadmap's step table says step 1 is done.

**Done when:** every acceptance criterion of hearsay-tools/squawk#3824 holds.
