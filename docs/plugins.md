# Plugins

A plugin adds a runner, an agent tool, a wait kind, a workflow step kind, a CLI command, a run
removal slot or a run-lifecycle listener to Squawk. Squawk loads plugins from one folder on the
host: `<config>/plugins/` (see the [platform roots](migration.md#home-directories); with
`HSQ_HOME` set, `$HSQ_HOME/config/plugins/`). Nothing needs to be configured: a folder that is
not there loads nothing.

[ADR 0070](adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md) records the loader and
runner kit design; [ADR 0071](adr/0071-keep-runner-folders-self-contained.md) records the
self-contained runner folder rules.

## Trust: a plugin runs as Squawk

> **Warning.** A plugin runs inside the Squawk process, with all of Squawk's permissions and
> logins. It can read every file Squawk can read, start any process, and use every agent account
> and token Squawk holds. Put only code you trust in `<config>/plugins/`, as you would when you
> install Squawk itself.

- Squawk loads no plugin from a project or a repository, only from the host folder.
- The cockpit has no page and the API has no route to install, remove, enable or disable a
  plugin. This holds on a local cockpit and on a hosted one (`HSQ_REMOTE=1`). To add or remove
  a plugin, change the folder on the host and restart `hsq`.

## The plugin API is unstable

The plugin API and the runner kit (`@hearsay-tools/squawk/plugin` and its subpaths) can change in
any release. They become a stable promise when Squawk installs plugin packages from npm or git
([ADR 0065](adr/0065-define-the-core-by-a-layer-map.md), rule 3). Check your plugins after each
upgrade.

## Write a plugin

A plugin is one folder in `<config>/plugins/`. The folder name is the plugin name. Its entry is
plain JavaScript: `index.mjs`, or `index.js` (Squawk tries them in that order). The entry
default-exports a setup function that receives the API object:

```js
// <config>/plugins/hello/index.mjs
export default function setup(api) {
  api.registerCliCommand({
    name: 'hello',
    usage: ['hsq hello'],
    parseMode: 'subcommand',
    homeMode: 'none',
    runtimeMode: 'none',
    // Returns the command: it receives the arguments after the name and returns the exit code.
    load: async () => async (argv) => {
      console.log('hello', ...argv);
      return 0;
    },
  });
}
```

The fields of each registration are in the types that `@hearsay-tools/squawk/plugin` exports
(`packages/cezar/src/plugin/index.ts`). The API object has `registerRunner`,
`registerAgentTool`, `registerWaitKind`, `registerStepKind`, `registerCliCommand`,
`registerRemovalSlots` and `onRunLifecycle`. The setup function may be `async`.

A plugin imports Squawk code only from `@hearsay-tools/squawk/plugin` and these subpaths:
`/runtime`, `/model-settings`, `/managed-cli` and `/pi-rpc`. Squawk maps them to its own running
copy, so a plugin needs no installed copy of Squawk. Any other `@hearsay-tools/squawk` import
fails. `packages/cezar/src/plugin/__fixtures__/external-runner/` is a complete runner plugin in
plain JavaScript.

### Outside runners

A runner plugin folder is self-contained and needs no `npm install` or `node_modules` folder:

- **Allowed imports.** Runner code may import only `node:*` built-ins, files inside its own
  plugin folder, and `@hearsay-tools/squawk/plugin` (plus its subpaths). `@hearsay-tools/squawk/plugin`
  re-exports `z` from `zod` so runners validate schemas without installing `zod`.
- **Runner-owned scripts.** Any script that the agent CLI itself loads (such as an extension or
  plugin) lives inside the runner's own folder and resolves through
  `new URL('./…', import.meta.url)`. For bundled runners, `packages/cezar/scripts/copy-runner-assets.mjs`
  copies every non-test `.mjs` asset from `src/runners/<id>/` to `dist/runners/<id>/` during
  `postbuild`, and `check:pack` verifies they ship in the tarball.
- **Tool client in agent processes (`HSQ_TOOL_CLIENT`).** Squawk's in-process import hook does
  not run inside a spawned agent CLI process. When a session asks for Squawk tools,
  `CiToolController.provision()` sets `HSQ_TOOL_CLIENT` (with `CEZ_TOOL_CLIENT` fallback) in the
  session environment to the `file:` URL of the running Squawk copy's tool client
  (`dist/ci-wait/client.js`, or `src/ci-wait/client.ts` under source). Out-of-process extensions
  import the client from that URL instead of a relative path into Squawk.
- **Dry-run mocks (`nativeMockPath`).** `@hearsay-tools/squawk/plugin/runtime` exports
  `nativeMockPath(mock)`. It resolves `RunnerMock.script` against the running Squawk
  installation's `scripts/` folder and throws an error naming the script when the installation does
  not ship it.
- **Bundled parity.** All six bundled runners (`claude`, `codex`, `opencode`, `pi`, `omp` and
  `antigravity`) follow these rules and load unchanged when their built `dist/runners/<id>/`
  folders are copied into `<config>/plugins/` with no `node_modules` ancestor
  (`packages/cezar/test/e2e/runner-copy-out.test.ts`).

## Load order and failures

- The bundled runners load first, then bundled features in ASCII folder-name order, then
  host plugins in `<config>/plugins/` in ASCII folder-name order. Missing bundled features are
  valid; a present bundled feature that fails to import or register stops boot.
- Squawk applies a plugin's registrations only when its setup finishes with no error and no
  registration conflicts with an earlier one. Otherwise it applies none of them and skips the
  plugin. The cockpit still starts.
- For each skipped plugin, `hsq` writes one line to stderr:
  `[hsq] plugin "<name>" skipped: <error>`.
- A runner's stored settings (default runner, models, accounts, disabled providers) stay on disk
  while its plugin does not load, and act again once it loads.

## See what loaded

- `hsq plugins` lists each loaded plugin with what it registered, and each skipped plugin with
  its full error. `hsq plugins --json` prints the same report as JSON.
- `GET /api/v1/health` sends `plugins: { loaded, failed }`. A skipped plugin's `error` there is a
  short fixed text for the kind of failure; run `hsq plugins` on the host for the full error. A
  hosted cockpit sends no plugin paths.
- `hsq --help` loads runtime and lists core, bundled feature and host plugin commands.
  It skips host discovery quietly if home cannot be resolved, without preparing home.
  A plugin's command runs as `hsq <name>` like a built-in.
