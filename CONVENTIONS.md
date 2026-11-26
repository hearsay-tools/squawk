# Code conventions

## Workspace packages and shared locations

Four pnpm workspaces live under a `private` root ([pnpm-workspace.yaml](pnpm-workspace.yaml), [package.json](package.json), rules in [docs/areas/packages.md](docs/areas/packages.md)):

| Workspace | Role | Shared code lives in |
|---|---|---|
| `packages/cezar` | Node 24.21.0+ ESM service and CLI (published as `@hearsay-tools/squawk`) | Core helpers in `packages/cezar/src/core/` (e.g., `shellQuote` in [shell-env.ts](packages/cezar/src/core/shell-env.ts), registries in [registry.ts](packages/cezar/src/core/registry.ts)); plugin kit in [packages/cezar/src/plugin/index.ts](packages/cezar/src/plugin/index.ts) |
| `packages/contract` | Node-free Zod request/response schemas and inferred types (`lib: ["ES2022"]`, `types: []` in [tsconfig.json](packages/contract/tsconfig.json)) | Schemas and shared domain rules in `packages/contract/src/` (e.g., [waits.ts](packages/contract/src/waits.ts), [attention.ts](packages/contract/src/attention.ts)) |
| `packages/api-client` | Node-free typed Hono client, SSE types, and project-scope helpers ([tsconfig.json](packages/api-client/tsconfig.json)) | Client builder in [packages/api-client/src/client.ts](packages/api-client/src/client.ts); contract subpath re-exports under `packages/api-client/src/contract/` |
| `packages/web` | React 19 + Vite + Tailwind v4 + shadcn/ui cockpit SPA (builds into `packages/cezar/web/dist`) | UI primitives in `packages/web/src/components/ui/` (e.g., [button.tsx](packages/web/src/components/ui/button.tsx)); shared components in `packages/web/src/components/`; API/query hooks in `packages/web/src/api/`; pure helpers in `packages/web/src/lib/` |

- **Cross-package imports:** Import by workspace package name, never relative paths across packages.
- **Contract value imports:** Import contract *values* from their module subpath (`@open-mercato/cezar-contract/<module>` in service; `@open-mercato/cezar-api-client/contract/<module>` in web), never the package root. Import *types* from package roots with `import type` ([docs/areas/http-api.md](docs/areas/http-api.md)).
- **Dependencies:** Declare each dependency in the workspace that imports it; the root `package.json` holds only cross-workspace dev tooling.

## Naming and imports

- **Files and directories:** `kebab-case` across all packages (e.g., [add-project-dialog.tsx](packages/web/src/components/add-project-dialog.tsx), [run-database-migrations.ts](packages/cezar/src/runs/run-database-migrations.ts)).
- **Tests and test helpers:** Colocate unit tests as `*.test.ts` / `*.test.tsx` beside the module under test. Name shared test builders `*.testkit.ts` / `*.testkit.tsx` (excluded from production builds in [packages/cezar/tsconfig.json](packages/cezar/tsconfig.json) and [packages/contract/tsconfig.json](packages/contract/tsconfig.json)). Place browser specs in `packages/web/e2e/*.e2e.ts`. Root/CI scripts use `*.mjs` or `*.cjs` with `*.test.mjs` / `*.test.cjs`.
- **Symbols:** `PascalCase` for types, interfaces, classes, and React components; `camelCase` for functions, React hooks (`useRunners`), variables, and Zod schemas (`runnersResponseSchema`); `UPPER_SNAKE_CASE` for module constants (`RUNS_DB_FILE`, `MIGRATIONS`).
- **Import specifiers:** Node packages use explicit `.ts` relative extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` in [packages/cezar/tsconfig.json](packages/cezar/tsconfig.json)). The cockpit uses the `@/*` path alias (`./src/*` in [packages/web/tsconfig.json](packages/web/tsconfig.json)).

## Service and CLI (`packages/cezar`)

- **Layer boundaries:** Every non-test source file in `packages/cezar/src/` belongs to one layer in [layers.json](packages/cezar/src/lint/layers.json) (`core`, `runner`, `feature:<name>`, `shell`, `tooling`). `core` never imports `feature:*` or `runner` ([ADR 0065](docs/adr/0065-define-the-core-by-a-layer-map.md)).
- **Registries and boot:** Process-wide extension tables follow **register → seal → read** via [registry.ts](packages/cezar/src/core/registry.ts). [boot.ts](packages/cezar/src/boot.ts) is the sole production module that seals registries (`bootColdCli()` for cold commands, `bootRuntime()` for runtime commands).
- **Runners and plugins:** Each runner is a self-contained folder under `packages/cezar/src/runners/<id>/` loaded via [loader.ts](packages/cezar/src/plugin/loader.ts), importing core only through `@hearsay-tools/squawk/plugin` and its subpaths (example: [packages/cezar/src/runners/pi/index.ts](packages/cezar/src/runners/pi/index.ts)).
- **HTTP API and validation:** Define request and response Zod schemas in `packages/contract/src/` first. Chain Hono routes into family builders so [app-type.ts](packages/cezar/src/server/app-type.ts) infers every route (example: [runners-routes.ts](packages/cezar/src/server/runners-routes.ts), mounted in [server.ts](packages/cezar/src/server/server.ts)). Validate JSON, params, and query strings with middleware from [validators.ts](packages/cezar/src/server/validators.ts) (`jsonZodValidator`, `paramZodValidator`, `queryZodValidator`) and return `{ error }` JSON on 4xx ([docs/areas/http-api.md](docs/areas/http-api.md)).
- **Run store and migrations:** Depend on narrow topic ports from [ports.ts](packages/cezar/src/runs/ports.ts), never `Pick<RunStore>`. SQLite (`runs.db`, `node:sqlite` `DatabaseSync` in [run-database.ts](packages/cezar/src/runs/run-database.ts)) uses forward-only `user_version` migrations in [run-database-migrations.ts](packages/cezar/src/runs/run-database-migrations.ts) — never edit a shipped entry; append and bump `RUN_DATABASE_SCHEMA_VERSION` in [run-database-version.ts](packages/cezar/src/runs/run-database-version.ts). Workspace config migrations are idempotent and additive in [workspace/migrations.ts](packages/cezar/src/workspace/migrations.ts); user home files serialize through [home/store.ts](packages/cezar/src/home/store.ts).
- **Environment and shell safety:** Document every `HSQ_*`/`CEZ_*` variable read in [.env.example](.env.example). Build POSIX shell words with `shellQuote` from [shell-env.ts](packages/cezar/src/core/shell-env.ts), never `JSON.stringify`.

## Cockpit UI (`packages/web` and `packages/api-client`)

- **Data fetching and errors:** Call the API through the typed Hono client (`createSquawkClient<AppType>` in [client.ts](packages/api-client/src/client.ts)), wrapped in `packages/web/src/api/` with `unwrapValidated` and `ApiError` ([client-core.ts](packages/web/src/api/client-core.ts)) and TanStack Query hooks (example: [runners.ts](packages/web/src/api/runners.ts)). Read runner metadata from `useRunners()`; keep no runner-keyed tables in the cockpit.
- **Live updates:** Use the single workspace SSE connection in [global-events.tsx](packages/web/src/api/global-events.tsx) and [live-coordinator.ts](packages/web/src/api/live-coordinator.ts) to patch TanStack Query caches in place and reconcile on reconnect or tab visibility.
- **Routing, query strings, and drafts:** Declare routes in [routes.tsx](packages/web/src/routes.tsx). Update URL query parameters through `useSearchParamsWriter` instead of raw `useSearchParams` setters ([docs/areas/web-ui.md](docs/areas/web-ui.md)). Report unsent form or composer drafts through `useUnsentDraft` ([version-reload.ts](packages/web/src/lib/version-reload.ts)).
- **Accessibility and touch:** Follow [docs/areas/web-ui.md](docs/areas/web-ui.md) and [card-2-contrast.md](packages/web/docs/card-2-contrast.md): `>= 44×44` CSS px touch targets, `>= 16px` editable text, `>= 4.5:1` text contrast, visible focus rings, and `motion-safe:` / `motion-reduce:` gating.

## Scripts and CI helpers (`scripts/`, `.github/scripts/`)

- Keep root `scripts/*.mjs` limited to cross-workspace tasks (e.g., [dev.mjs](scripts/dev.mjs), [prepr.mjs](scripts/prepr.mjs), [readers.mjs](scripts/readers.mjs), [import-reach.mjs](scripts/import-reach.mjs)).
- Put CI and repository guards in `.github/scripts/*.cjs` (e.g., [check-citations.cjs](.github/scripts/check-citations.cjs), [check-clones.cjs](.github/scripts/check-clones.cjs), [agents-md-budget.test.cjs](.github/scripts/agents-md-budget.test.cjs)).

## Testing

- **Runners:** Root [vitest.config.ts](vitest.config.ts) orchestrates four unit projects (`server`, `contract`, `api-client`, `web`, each with its own `packages/*/vitest.config.ts`) plus browser E2E ([packages/web/e2e/vitest.config.ts](packages/web/e2e/vitest.config.ts)). Script and tarball suites use `node:test` (`npm run test:unit`, `npm run test:package`).
- **Fixtures and isolation:** Unit suites pin an isolated sandbox home via [packages/cezar/vitest.setup.ts](packages/cezar/vitest.setup.ts) and [scripts/test-home-env.mjs](scripts/test-home-env.mjs). Reuse domain fixtures from `*.testkit.ts` files (e.g., [test-home.testkit.ts](packages/cezar/src/home/test-home.testkit.ts), [runners.testkit.ts](packages/web/src/test/runners.testkit.ts)).
- **Waiting and execution:** Wait on product signals, never arbitrary sleeps; any hang-guard timeout carries a `// bound: <reason>` comment ([AGENTS.md § Validation](AGENTS.md#validation)). Browser specs drive Chrome through [agent-browser.ts](packages/web/e2e/agent-browser.ts) ([packages/web/e2e/README.md](packages/web/e2e/README.md)). Locally, Squeal runs checks per [squeal.config.json](squeal.config.json); CI owns the full sharded gate.

## Linting, typechecking, and quality configs

Enforced tool rules live in their config files and are not repeated here:

- **Linter and custom AST rules:** [.oxlintrc.json](.oxlintrc.json), custom plugin [packages/cezar/src/lint/plugin.ts](packages/cezar/src/lint/plugin.ts), runner [packages/cezar/src/lint/run.ts](packages/cezar/src/lint/run.ts) (`npm run lint`; details in [docs/sdlc/lint.md](docs/sdlc/lint.md)). Existing exceptions sit in shrink-only `*.baseline.json` files.
- **Formatting:** No standalone formatter config is used; match surrounding file style and satisfy [.oxlintrc.json](.oxlintrc.json).
- **Typechecking:** Strict TypeScript 7 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`) across `packages/*/tsconfig.json`, verified with [scripts/check-typecheck-coverage.mjs](scripts/check-typecheck-coverage.mjs) (`npm run typecheck`).
- **Clones, mutation, and pre-PR gates:** [check-clones.cjs](.github/scripts/check-clones.cjs) (`npm run check:clones`), [stryker.config.json](stryker.config.json) / [vitest.stryker.config.ts](vitest.stryker.config.ts), [scripts/prepr.mjs](scripts/prepr.mjs) (`npm run prepr`), and the `AGENTS.md` byte budget in [.github/agents-md.baseline.json](.github/agents-md.baseline.json).

## Reuse rule

> Build only what the ticket asks. Before adding a component, helper, Zod schema, registry, or dependency, look for one the repository already has and reuse it.
