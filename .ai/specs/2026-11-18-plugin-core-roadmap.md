# Plugin core roadmap
Status: active

The plan that makes Squawk a small core with every other feature built as a plugin.
[ADR 0065](../../docs/adr/0065-define-the-core-by-a-layer-map.md) and the
[core layer map spec](2026-11-16-core-layer-map.md) call it "the plugin plan". This file holds
the whole plan: the steps, their order, what is decided and what is still open. Each step has
its own issue and its own spec; this file links them and changes no code.

## Goal

Squawk keeps its job: it runs agent CLIs in worktrees and does not get a model loop of its own.
It takes the shape of pi, one of the agents it runs:

- **A small core.** The run engine and what every task needs, as the
  [layer map](../../packages/cezar/src/lint/layers.json) defines it.
- **One way to add code.** A feature registers what it brings: a runner, an agent tool, a wait
  kind, a CLI command, a listener on the run lifecycle.
- **A named lifecycle.** Typed events that a feature listens to, in place of imports from the
  run engine.
- **Packages.** One unit that holds extensions and workflows, found by folder with no setup.

The method is to open the seams that exist, one at a time. Most of them are already a table or
an interface in the source, and the set is closed there. No step is a rewrite.

## Rules for every step

1. **No plugin API without a first-party feature that moves onto it.** A register call arrives
   in the same change as the built-in feature that uses it.
2. **The three rules of ADR 0065 bind.** Built-in features use the same API as outside plugins.
   Zero config stays. The API promise starts when outside code can load, which is step 4.
3. **Each step shrinks a list.** A step's acceptance names the entries it removes from
   `packages/cezar/src/lint/layer-import.baseline.json` or from another shrink-only baseline.
4. **`main` stays usable after each slice**, at shipped defaults.
5. **Each step reports what Squeal selects.** A step that adds a port or moves a feature behind
   registration counts, before and after, the test files that Squeal selects for the files it
   moves (`squeal status <path> --json`, `.selection.testFiles`; an answer with
   `selection.reason` `unsynced` is incomplete). A split that keeps every module behind one
   facade does not lower the count, and neither does a port that test fixtures still build in
   full. A port lowers it only when its consumers import its type and the fixtures build only
   the ports a test uses.

## Steps

| Step | What | State on 2026-11-23 |
| --- | --- | --- |
| 0 | Draw the line: define the core, add the layer map and `cez/layer-import` | Done: hearsay-tools/squawk#3706, ADR 0065 |
| 1 | Runners become definitions that register themselves | Done: epic hearsay-tools/squawk#3824, [spec](2026-11-18-runner-definitions.md), [ADR 0067](../../docs/adr/0067-register-each-runner-as-one-definition.md) |
| 2 | A typed run lifecycle, and a narrower run store | Done: epic hearsay-tools/squawk#4007, [spec](2026-11-21-run-lifecycle-and-store-ports.md), [ADR 0068](../../docs/adr/0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md) |
| 3 | Open the small tables: agent tools, wait kinds, step kinds, CLI commands | Done: epic hearsay-tools/squawk#4152, [spec](2026-11-23-open-registries-and-tables.md), [ADR 0069](../../docs/adr/0069-adopt-register-then-seal-registries-for-extension-tables.md) |
| 4 | Loader and package format | Not filed |
| 5 | Move features out of the core, smallest first | Not filed; hearsay-tools/squawk#3874 moved accounts to a feature layer |
| 6 | Cockpit slots | Not filed |

Steps 0 to 3 pay off with no outside plugin: the code is modular and every change is internal.
Step 4 is the first step that only an outside plugin needs.

One change ran beside the steps. Squawk dropped its own skill layer and uses each runner's
skills (epic hearsay-tools/squawk#3746,
[ADR 0066](../../docs/adr/0066-use-runner-native-skills.md)). A skill therefore belongs to the
runner, and the package format of step 4 does not hold skills.

### Step 1: runner definitions

One definition for each runner holds what the per-runner tables hold now. A registry replaces
the `switch` in `core/runner-factory.ts`, and the built-in runners register through the same
call. The contract and the cockpit read the registry. A fixture runner proves that a new runner
needs no edit outside its own files. The [spec](2026-11-18-runner-definitions.md) records the
owner's decisions and the slices that did the work;
[ADR 0067](../../docs/adr/0067-register-each-runner-as-one-definition.md) records the result.

Done on 2026-11-20. A built-in runner is its folder `runners/<id>/`, its scripts in
`packages/cezar/scripts/`, one line in `runners/built-in.ts` and its id in `runners/ids.ts`. `layer-import.baseline.json` holds no
`runner` entry and `runner-roster-literal.baseline.json` holds no entry.

### Step 2: typed lifecycle and store ports

- Name the events that a first-party listener uses: run created, run updated, status changed,
  run deleted, the per-run event stream and store closed. Step, turn and wait events wait for a
  listener (spec decision 1). Listeners only observe; they cannot change a run.
- Move the current listeners on `RunStore` onto the typed events. Webhooks go first.
- Add a hook that can change an outcome only when a first-party feature needs one. Run removal
  is the one such need: three removal slots.
- Give the run store a few named ports (read runs, write runs, event log, worker results,
  retention) and move one topic at a time out of the `RunStore` class behind its port. The
  split of `workflows/run.ts` under
  [ADR 0053](../../docs/adr/0053-keep-runmanager-a-facade-over-run-modules.md) is the model.

Both halves belong to one step, because the typed events replace the emitter on `RunStore` and
so touch the same code as the ports. The store stays one store in one SQLite file. It is not a
plugin.

The epic names the first-party need for a hook that is more than an observer: `runs/` imports
feature code to decide whether a run may be deleted and to clean up after it. The
[spec](2026-11-21-run-lifecycle-and-store-ports.md) records the owner's decisions of 2026-11-21:
six lifecycle events, each with a first-party listener; three removal slots (a deletion gate, a
reclaim preparation and a removal cleanup) in place of those imports; and topic objects behind
named ports, until `runs/store.ts` is 1,000 lines or fewer.

Done on 2026-11-22.
[ADR 0068](../../docs/adr/0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md)
records the result. `RunStore` extends no `EventEmitter`, and every former listener subscribes to
`store.lifecycle`. Each removal asks the slots it needs: a history deletion the gates and the
cleanups, a reclaim the gates and the preparation, a scratch removal the gates. Callers take ports from `runs/ports.ts`, and
13 topic modules are store fields. `runs/store.ts` is 990 lines with no
`file-length.baseline.json` entry, and `layer-import.baseline.json` holds no `runs/` entry. As rule 5 predicts,
Squeal still selects about 889 test files for `runs/store.ts`, because most tests build the
store through testkits.

### Step 3: open the small tables

Epic hearsay-tools/squawk#4152 ([spec](2026-11-23-open-registries-and-tables.md), [ADR 0069](../../docs/adr/0069-adopt-register-then-seal-registries-for-extension-tables.md)).

Slice 0 adopts one two-phase lifecycle rule (**register, then seal, then read**) in `core/registry.ts` and migrates the three existing process-wide registries (`core/runner-registry.ts`, `runs/removal-slots.ts`, and `runs/worker-executions-registry.ts`) onto it before step 3 opens the four new tables (owner decision, 2026-11-23).

Agent tools (`TOOLS_BY_NAME`), wait kinds (`WAIT_KINDS`,
[ADR 0061](../../docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md)), workflow step
kinds and CLI commands each get a register call, one at a time, each with a first-party user.
Each closed union in the contract gets one open member for plugins, with a payload that the
plugin validates. Lint rules that hold a list of names read the table.

The owner's layer calls in the core layer map spec say which rows ship with the core: the wait
kinds `human`, `timer` and `process`, and the tools `cezar_ask`, `cezar_done` and `cezar_wait`.

Done on 2026-11-23.
[ADR 0069](../../docs/adr/0069-adopt-register-then-seal-registries-for-extension-tables.md)
records the result. All seven process-wide registries (`core/runner-registry.ts`,
`runs/removal-slots.ts`, `runs/worker-executions-registry.ts`, `ci-wait/tool-registry.ts`,
`workflows/run/wait-kind-registry.ts`, `workflows/step-kind-registry.ts`, and
`core/cli-registry.ts`) use `core/registry.ts` and fail closed when read unsealed. Four fixture
tests (`ci-wait/fixture-tool.test.ts`, `workflows/run/fixture-wait.test.ts`,
`workflows/plugin-step.test.ts`, and `core/cli-registry.test.ts`) prove each open table accepts a
custom extension with zero edits to core files. `layer-import.baseline.json` shrank from 102
entries to 93 (all seven required target entries plus two adjacent entries removed), and
`owner-reader-rules.ts` and `test-enum-literal.ts` read plain data modules
(`workflows/wait-kind-ids.ts`, `workflows/step-kind-ids.ts`).

### Step 4: loader and package format

A file exports one function that receives the API object. Squawk finds it by folder, in the
project and in the user's home. A package holds extensions and workflows. A project's plugins
load only after a person trusts the project. From this step the API is a promise, so the API
stays small.

Preconditions from step 1 ([runner definitions](2026-11-18-runner-definitions.md)):

- **Register before config.** The stored-config decoders drop a runner id that no runner
  registered, on the next write: the workspace `agentDefaults.runner`, `disabledProviders` and
  the agent-account rows. The loader must register every runner before any config read or write,
  or the decoders must keep unknown ids. Otherwise a runner that failed to load loses its stored
  settings: a one-way door.
- **One runner list.** Folder discovery is expected to replace both `runners/built-in.ts` and
  `runners/ids.ts`.
- **Measure with the static closure.** Test-selection counts (rule 5) use Squeal's static
  closure until Squeal prunes stale observed paths.

### Step 5: move features out

Each feature becomes a built-in plugin and takes its routes out of `server/server.ts`. The
order is by size and by how deep the feature reaches into the run store: listeners such as
webhooks and the activity view first, then preview and automations, then the forge.
`feature:workers` is the deepest; the layer map spec plans no removal for it.

### Step 6: cockpit slots

First the server describes slots as data: a navigation item, a settings section, a task tab.
Then a plugin panel is HTML in the sandboxed frame that the report reader uses
([ADR 0057](../../docs/adr/0057-run-report-scripts-in-a-nested-opaque-frame.md)). No outside
React component loads into the cockpit bundle.

## Evidence

A review of the code at `6eedefca9` on 2026-11-16 rated each seam. Counts are from that commit;
the counts of importers and callers come from text search and are approximate. The count of test
files is what Squeal reported in a worktree at that commit; the commit alone cannot repeat it.

| Seam | State then | Step |
| --- | --- | --- |
| Workflow YAML files | Found in folders with no setup; two step kinds, chosen by one `if` | 3 |
| WebSocket topics | `registerTopic` in `server/ws.ts` is a real registry, for core code only | 5 |
| Boundary checks | Decision records, structural lint and shrink-only baselines hold a line once drawn | 0 |
| Runners | One `AgentRunner` contract and an injected factory; the runner list closed in about 20 places | 1 |
| Agent tools | A lookup table; a new tool touched about 6 places | 3 |
| Wait kinds | One engine over a typed table of seven kinds; the kinds a closed union in the contract | 3 |
| CLI commands | 20 commands behind two `switch` statements, one handler shape | 3 |
| Forge | A `ForgeDriver` interface; 9 files called `gh` without it | 5 |
| Run lifecycle | `RunStore` emitted 4 untyped events (`run`, `deleted`, `event`, `closed`) to about 12 listeners | 2 |
| Run store | One class of 3,393 lines and 198 methods. Squeal reported that at least 838 of the 1,893 test files it covered load `runs/store.ts` | 2 |
| HTTP API | `server/server.ts` built every route in 4,990 lines; the typed client is computed from it | 5 |
| Cockpit | 84,000 lines with no place for outside UI | 6 |
| Trust | No rule for when outside code may run | 4 |

The service had 118,000 lines of non-test source at that commit.

On 2026-11-18 at `1e22453b1`, `layer-import.baseline.json` holds 139 entries for 140 imports:
127 from core into features and 13 from core into runners.

An audit at `2d06ed70c` on 2026-11-19 (Squawk task `0a6c5807`) weighted Squeal's current
selection for each file by the commits that touched the file on `main` in 90 days. The files
that `workflows/run.ts` imports, directly or through other files, hold 59% of that weighted
total, because 564 test files build a full `RunManager`. Across the 1,702 test files with a
record of the modules they loaded, the tests loaded 97% of the code files Squeal selects for
them. After the
[ADR 0053](../../docs/adr/0053-keep-runmanager-a-facade-over-run-modules.md) split, the median
`workflows/run/` module still selects 591 test files. Removing every core import of a feature
that `layer-import.baseline.json` lists would cut the total by about 4%. Rule 5 exists for this
reason.

## Open decisions

The owner decides each of these in the spec of the step that needs it.

| Decision | Needed by | Effect |
| --- | --- | --- |
| Who writes plugins: only this team, or other people | Step 4 | Only this team: the plan ends after step 3 plus step 5 inside the repository, with no loader, trust gate or API promise |
| Do plugins run inside the Squawk process or in a child process | Step 4 | pi runs an extension with all of pi's permissions. Squawk runs unattended and holds logins, so that answer does not transfer |
| Is the cockpit part of the core | Step 6 | If not, the core is `hsq run` and the API, and the cockpit is the largest built-in plugin |

## Not planned

- A rewrite. The runners hold learned behavior about each CLI, and the tests and decision
  records protect it.
- A plugin API designed before a feature uses it.
- UI plugins before steps 1 to 5.
- Storage as a plugin.
- A model loop inside Squawk.

## Plan

This file is a design record. It changes when a step is filed, finishes or is dropped, and when
the owner settles an open decision.

To prepare a step:

1. Measure again on current `main`. The code moves between steps: part of step 1 was done by
   epic hearsay-tools/squawk#3642 before the step 1 issue was written.
2. File the step. A step that fits one pull request is a task. A step that needs several is an
   epic whose first deliverable is a spec and a plan, with one child issue for each slice.
3. Link the issue in the steps table above.
4. Before a step moves a file, read
   [packages.md § Moving a source file](../../docs/areas/packages.md#moving-a-source-file).

## Case tables

No case table applies: this roadmap changes no behavior. Each step's spec carries the tables
that its own changes need.
