# Packages and repository layout

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`package.json` (workspaces), then each package's `package.json`

## Rules

Four pnpm workspaces (npm script metadata retained) under a `private` root that publishes nothing itself:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cezar` | `@wjarka/cezarion` | The service + CLI, and everything behind them (runs, workflows, agent runners, workspace state). Publishes as `@hearsay-tools/squawk`: `bin`, plus the built cockpit in `web/dist`. |
| `packages/contract` | `@open-mercato/cezar-contract` | The HTTP contract itself: every request and response as a zod schema with its TypeScript type inferred from it, so no shape is written twice. **Node-free on the same terms as the api-client** (`lib: ["ES2022"]`, `types: []` in its tsconfig make a `node:*` import a compile error). `private`, and that has a cost: the service imports a contract VALUE (`workspaceUiStateSchema`, in `workspace/migrations.ts`), so a published tarball naming a package npm has never seen would fail on install. `packages/cezar/scripts/inline-contract.mjs` runs as `postbuild` to fold the contract into `dist/contract/` — bundle AND declarations — and repoint the emitted references, module subpaths included. Each module is also a subpath, `@open-mercato/cezar-contract/<module>`, which is how code imports a contract value (see [the HTTP API](http-api.md)). Delete that script the day the contract is published, or the day nothing in the service imports a contract value. |
| `packages/api-client` | `@open-mercato/cezar-api-client` | The contract between the two: the typed client over `AppType`, the SSE/protocol types, and the scope helpers. Re-exports `packages/contract` so a consumer needs one import, for types. Values come through its subpaths: `/contract/<module>` (a one-line re-export of each contract module) and `/<path>` for its own modules. **Node-free by construction** — no `node:*`, no `@types/node` — because it is bundled into a browser AND imported by the Node service. `private` for now: versioned with the release but not on npm. The service may therefore only import it in TESTS — a runtime import would make the published CLI depend on something npm cannot resolve. |
| `packages/web` | `@open-mercato/cezar-web` | The cockpit SPA. Private; its output is an artifact of the service (`vite build` writes into `packages/cezar/web/dist`, which the CLI ships and serves). |

Rules that follow from that:

- npm release identities come from `home/identity.ts`. Publication projects the new scoped name into a disposable pack copy;
  source workspace names remain unchanged so builds and version-only bump PRs
  still work. See [publishing](../publishing.md#package-identity).

- **The CLI is not a separate package and should not become one.** It is the same program as the service — `packages/cezar/src/index.ts` boots `startServer`, but also `RunManager`, the workspace registry and the worktree machinery, and `hsq run` executes a workflow with no server at all.
- A dependency belongs to the workspace that imports it. The root carries only what spans all four (`typescript`, `vitest`, `tsx`). A build script counts as an importer: `scripts/inline-contract.mjs` reaches for `esbuild`, so `esbuild` is a devDependency of `packages/cezar` rather than something inherited from whatever vite happens to hoist.
- Cross-package imports go through the package name, never a relative path — the exceptions are test-only reaches for golden fixtures, and they are ugly on purpose.
- The repo root keeps only what spans workspaces: `scripts/dev.mjs` (boots both halves) and `scripts/release*.mjs` (a release spans every package). Everything else lives in the package that owns it.

## Moving a source file

A move that keeps every name passes the quality gates with no label:

- `changed-functions.mjs` and the complexity gate list a function moved without edits under
  `moved`, also when a same-named delegator at or under complexity 20 stays in the old place.
- `check-clones.cjs` carries a clone that moved with its code.
- `Reject baseline growth` accepts a `*.baseline.json` entry or key that only follows its file to
  the new path. The old path must be gone, and the change must add the new one. Any other change to
  a baseline still needs the owner's `baseline-growth` label.

These files name a source file by its path. Rewrite each one that names the old path in the same
commit. `node scripts/readers.mjs --moved <old-path> <new-path>` lists every JSON pin that names
it, and the readers of the old path:

| File | What it pins |
| --- | --- |
| `.github/mutants/targets.json` | Mutation targets, keyed by file, with the functions they guard |
| `.github/mutants/equivalent.json` | Equivalent mutants, by file and function |
| `packages/cezar/src/file-length.baseline.json` | The length of each file over 1,000 lines |
| `packages/cezar/src/lint/layer-import.baseline.json` | Core-to-feature imports, by `file` and `target` |
| `packages/cezar/src/lint/layers.json` | The layer of each path |
| `packages/cezar/src/lint/*.baseline.json` and the other `*.baseline.json` files | Lint and wait-discipline allowances, by file |
| `packages/web/src/test/search-params-discipline.baseline.json`, `card-2-contrast.baseline.json` | Cockpit allowances, by the path below `packages/web/src/` |
| `packages/cezar/src/lint/resume-time-readers.json`, `run-history-readers.json` and `reader-matrix/*.json` | Allowed readers of a run fact, by file |

Some guards key on a directory, not a file, so `--moved` does not find them:

- `cez/runner-id-branch` allows a branch on a runner id only in `packages/cezar/src/core/`.
- `runner-class-outside-factory` (`lint/owner-policies.ts`) ignores `packages/cezar/src/runners/*/`
  and named `core/` runner files.
- `packages/cezar/src/core/runner-closure.test.ts` follows the static and dynamic imports of the
  runner modules.

A move into or out of those directories changes what these rules allow.
