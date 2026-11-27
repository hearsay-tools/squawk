# Load host-folder plugins and export the runner kit

Approved design: [plugin loader and runner kit](../../.ai/specs/2026-11-24-plugin-loader-and-runner-kit.md),
including the owner's seven decisions of 2026-11-24 (task `e0b9b34a`). Epic
hearsay-tools/squawk#4188, step 4 (first version) of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md). It applies
[ADR 0065](0065-define-the-core-by-a-layer-map.md) and builds on the register-then-seal
registries of [ADR 0069](0069-adopt-register-then-seal-registries-for-extension-tables.md).

## Decision

Squawk loads plugins from one host folder, `<config>/plugins/`, inside its own process. One boot
module registers every built-in, loads the bundled runners and the host plugins through the same
loader, and seals every registry. One public entry, `@hearsay-tools/squawk/plugin`, exports the
plugin API types and the runner kit. Paths are under `packages/cezar/src/` unless noted.

### 1. Trust: host-folder plugins run in-process

- A plugin is a folder in `<config>/plugins/` that the host owner puts there. Squawk runs it
  inside the Squawk process, **with all of Squawk's permissions and logins**: it can read every
  file Squawk reads, start any process, and use every agent account and token Squawk holds.
  Installing a plugin is the same trust decision as installing Squawk.
- Squawk loads plugins from no other place. It loads no project-scoped plugin and has no trust
  gate for one.
- No cockpit UI and no HTTP route installs, removes, enables or disables a plugin, on a local
  cockpit and on a hosted one (`HSQ_REMOTE=1`). Only a person with write access to the host's
  config folder adds or removes a plugin.

### 2. Plugin format and API object

- A plugin folder holds `index.mjs` or `index.js` (the loader tries them in that order). The
  entry is plain JavaScript and default-exports one setup function:
  `export default function setup(api) { ... }`. The function may return a promise.
- The `api` object (`SquawkPluginApi`, `plugin/api.ts`) is the only way to write a process-wide
  registry: `registerRunner`, `registerAgentTool`, `registerWaitKind`, `registerStepKind`,
  `registerCliCommand`, `registerRemovalSlots` and `onRunLifecycle`. The single-slot worker
  executions registry stays built-in only.
- `runPluginSetup` stages each plugin's registrations. Nothing reaches a live registry while
  `setup(api)` runs. Each staged entry passes the same shape checks as a real registration
  (runner-id bounds, step-kind rules) and is checked against live keys, reserved legacy keys and
  the plugin's own other entries. Only when setup returns cleanly and every check passes does the
  whole batch commit. A throw, a rejected promise, a bad shape or a key conflict commits nothing.

### 3. Kit resolution: one running copy

- Before it loads the first plugin, the loader installs an in-process `node:module`
  `registerHooks` resolve hook (`plugin/resolve-hook.ts`). The hook maps
  `@hearsay-tools/squawk/plugin` and its documented runner-kit subpaths
  (`@hearsay-tools/squawk/plugin/runtime`, `/model-settings`, `/managed-cli`, `/pi-rpc`, `/acp`) to the
  modules of the Squawk copy that is running (`.ts` under source and tests, `.js` under `dist/`).
- The hook refuses every other specifier in `@hearsay-tools/squawk`: the package root and any
  other subpath. No running copy backs them, and an installed second copy would split process
  state (`core/session-process.ts` leader map, the sealed agent-tool registry,
  `managed-install/runtime-home.ts`).
- `@hearsay-tools/squawk/plugin` (`plugin/index.ts`, `plugin/runner-kit.ts`) holds the plugin
  API types, runner definition types and pure data and environment helpers. The heavy runtime
  helpers live on the subpaths: `runtime` (child processes, session leaders, adapter helpers),
  `model-settings` (TOML and YAML parsers), `managed-cli` (managed CLI storage), `pi-rpc` (the
  Pi-family RPC wire) and `acp` (the ACP v1 session, transport, hooks, protocol schemas and event
  sink). Every subpath is unstable until Squawk installs plugins from npm or git. `bootRuntime()` imports every runner's `definition.ts` and therefore the
  main entry; the subpaths keep that boot light, because a runner loads them only when its adapter
  or catalog loads.
- `packages/cezar/package.json` exports the same six paths, and the hook refuses any specifier
  outside them.

### 4. One boot boundary and one load order

- `boot.ts` is the only production module that seals a registry (`boot.test.ts` scans the
  source). `bootColdCli()` registers the built-in CLI commands and seals the CLI registry only.
  `bootRuntime({ pluginsDir })` registers the built-ins, loads plugins and seals all eight
  process-wide registries, the run-lifecycle listener registry (`runs/lifecycle-registry.ts`)
  included.
- The bundled runners load first, through the same loader and `SquawkPluginApi`. Each runner
  folder `runners/<id>/` has a plugin entry `index.ts` (`index.js` in `dist/`) that declares
  `export const displayOrder = <integer>;`; they load and list in that order (`claude`, `codex`,
  `opencode`, `pi`, `omp`, `antigravity`). `runners/built-in.ts` and `runners/ids.ts` are gone.
  A bundled runner that fails stops boot: it is a defect of Squawk itself.
- The host plugins load next, one folder at a time, in locale-independent ASCII code-point order
  of folder name. A missing `<config>/plugins/` loads nothing and logs nothing.
- Every runner folder imports core code only through `@hearsay-tools/squawk/plugin` and its
  subpaths. `cez/runner-core-import` enforces this; its shrink-only baseline holds 0 entries.

### 5. A broken plugin is skipped, and reported

- A host plugin that has no entry, has no default-exported function, fails to import, throws in
  setup or is refused at commit is skipped. Boot continues, so the cockpit still starts
  ([AGENTS.md § Zero config](../../AGENTS.md#zero-config)).
- `hsq` writes one stderr line per skipped plugin: `[hsq] plugin "<name>" skipped: <error>`.
- `hsq plugins` (a runtime command) lists the loaded plugins with what each registered, and the
  skipped plugins with the full error.
- `GET /api/v1/health` always sends `plugins: { loaded, failed }`. Each entry names the plugin
  and its source (`bundled` or `host`). A failed entry's `error` is a fixed text for its reason
  (`PLUGIN_FAILURE_TEXT`), never the plugin's own message, which can name host paths or carry a
  secret. A hosted cockpit (`HSQ_REMOTE=1` or a non-loopback bind) also omits each entry's
  `path`.
- Stored settings that name a runner survive a start where that runner's plugin did not load:
  `agentDefaults.runner`, `disabledProviders`, the agent-account rows and selections, and the repo
  `defaultRunner` and `defaultModels`. HTTP write routes still refuse an unregistered runner id.

### 6. Help loads commands; version and cold commands stay cold

- `--version`, `-v` and every built-in command whose `runtimeMode` is `'none'` (or a
  predicate that returns `false` for the arguments) call
  `bootColdCli()` and load no plugin, runner or store.
- A built-in runtime command and an unknown command name call `bootRuntime()`. A plugin's CLI
  command therefore registers before the CLI registry seals and dispatches like a built-in. A
  name that no built-in and no plugin registers still fails with `unknown command`.
- `hsq --help` and `-h` call `bootRuntime()` and list core, bundled feature and host plugin
  commands. An unresolvable home skips host discovery quietly, without preparing home.
  The footer points to `hsq plugins`. Help for cold built-in commands stays cold.
  This amends the original cold-help decision (hearsay-tools/squawk#4313).

### 7. The plugin API and runner kit are unstable

The plugin API and the runner kit can change in any release while plugins load only from the host
folder. The stability promise of ADR 0065 rule 3 starts when Squawk installs plugin packages from
npm or git (owner decision 1); ADR 0065 records the amendment.

## Consequences

- **Outside runners work today.** `plugin/external-runner-plugin.test.ts` loads a plain-JS
  runner from a `<config>/plugins/` folder outside the repository, runs a task on it to the review
  gate, breaks the plugin, and checks that the settings naming its runner survive the restart. A
  live acceptance run loaded the built `pi` runner from `<config>/plugins/pi-external/` and
  completed a task on the real `pi` CLI.
- **A plugin is as trusted as Squawk.** Squawk does not sandbox it and does not ask before it
  loads it. Hosted operators own the folder; the cockpit cannot change it.
- **The kit carries every runner's needs.** Moving all six built-in runners onto the kit made the
  kit complete for the cases those runners cover. The remaining follow-up (hearsay-tools/squawk#4232:
  self-contained runner assets, `z` re-export, `HSQ_TOOL_CLIENT` and `nativeMockPath`) is now
  complete and recorded in [ADR 0071](0071-keep-runner-folders-self-contained.md).
- **Deferred work.** Project-scoped plugins and a trust gate, installing from npm or git,
  install and remove commands, cockpit plugin management and workflows inside a plugin wait for a
  later epic. New extension slots are roadmap step 5; cockpit UI slots are step 6.

## Considered Options

- **Run plugins in a child process.** Rejected for this version. Runners share session-leader
  state, the agent-tool registry and the managed-CLI home with the core, and a process boundary
  would need a new protocol for each. Squawk runs unattended and holds logins, so the trust
  boundary is the host folder instead.
- **Let a plugin import an installed copy of `@hearsay-tools/squawk`.** Rejected. A second copy
  splits module state, so a runner's session leaders and tools would be invisible to the core.
- **Pass the kit only through the `api` object.** Rejected. Runner adapters and catalogs import
  helpers at module level, long after setup returns; an import resolved to the running copy keeps
  the built-in runner code unchanged.
- **Keep top-level help cold.** Superseded by hearsay-tools/squawk#4313: bundled features
  register commands through the plugin API, so help must boot runtime to list them.
- **Stop boot on a broken host plugin.** Rejected. One bad folder would take the cockpit down,
  against zero config.
- **Make the API stable now.** Rejected by the owner. Only this team writes plugins while the
  folder is host-only, and the first outside runners still find gaps in the kit.

Implementation and reader rules: [plugins](../plugins.md), [runners area](../areas/runners.md),
[CLI area](../areas/cli.md), [HTTP API area](../areas/http-api.md),
[AGENT_PROTOCOL.md § 10](../../AGENT_PROTOCOL.md#10-adding-a-new-runner-the-387-pi-checklist), and
the spec's [implementation record](../../.ai/specs/2026-11-24-plugin-loader-and-runner-kit.md#implementation-record).

Coverage under `packages/cezar/src/`: `boot.test.ts`, `plugin/api.test.ts`,
`plugin/loader.test.ts`, `plugin/resolve-hook.test.ts`, `plugin/bundled-runners.test.ts`,
`plugin/cli.test.ts`, `plugin/runner-kit.test.ts`, `plugin/external-runner-plugin.test.ts`,
`index-runners.test.ts`, `index-run-slots.test.ts` and `core/runner-closure.test.ts`.
