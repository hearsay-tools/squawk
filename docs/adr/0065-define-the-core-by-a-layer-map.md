# Define the core by a layer map

Squawk is to have a small core, with every other feature built as a plugin. This record defines
the core and the rules that keep it small (hearsay-tools/squawk#3706). It moves no code.

## Decision

`packages/cezar/src/lint/layers.json`, the **layer map**, is the source of truth for what the
core is. It puts every non-test source file under `packages/cezar/src` in one layer:

| Layer | What it holds |
| --- | --- |
| `core` | The run engine and what every task needs: runs, workflows, the wait engine, the agent tools `cezar_ask`, `cezar_done` and `cezar_wait`, home and workspace state, git and worktrees, paths, config and the handoff journal |
| `runner` | Each runner's folder `runners/<id>/`: its definition, adapter and data ([ADR 0067](0067-register-each-runner-as-one-definition.md)) |
| `feature:<name>` | One feature that the core could run without: workers, forge, preview, automations, skills, autosave and the others the map names |
| `shell` | The process and transport around the core: the HTTP server, CLI entry and dispatch, and `serve` |
| `tooling` | The repository's own lint rules |

The layers stay inside one package, as [packages.md](../areas/packages.md) says. The
[spec](../../.ai/specs/2026-11-16-core-layer-map.md) lists each layer's paths and the owner's
layer calls.

`cez/layer-import` holds two import rules:

- A `core` file imports no `feature:<name>` file. Type-only imports count: a type still ties the
  two layers.
- A `core` file imports no `runner` file. The core builds runners through the registry
  (`core/runner-registry.ts`), which each process entry fills from `runners/built-in.ts`
  (spec 2026-11-18-runner-definitions).

A source file with no layer fails `npm run lint`, so each new file gets a deliberate place. The
imports that exist today are in `layer-import.baseline.json`, each with a reason. The list only
shrinks: each later step of the [plugin plan](../../.ai/specs/2026-11-18-plugin-core-roadmap.md)
removes entries.

Three rules bind the later steps:

1. **Built-in features use the same API as outside plugins.** A feature that ships with Squawk
   gets no private hook into the core. When a feature needs something from the core, the API
   gains it for every plugin.
2. **Zero config stays.** A plugin is discovered or ships enabled, as
   [AGENTS.md § Zero config](../../AGENTS.md#zero-config) says. No plugin needs a setting before
   it works.
3. **The API promise starts when outside code can load.** Until a loader runs code from outside
   this repository, the plugin API changes freely, under the repository's no-compatibility rule.

## Consequences

- A change that adds a core-to-feature import fails lint. It moves the shared code into core, or
  inverts the dependency: the core declares a slot, and the feature fills it.
- `workflows/run/compose.ts` wires features into the run engine. Its entries carry the reason
  "wiring; becomes registration": they go when features register through the API.
- Rules between two features, rules for `shell` files and layers for the other three packages
  are not part of this record. Follow-up issues add them.
- The map is data. Moving a file to another layer is a reviewed one-line change, not a rename.
