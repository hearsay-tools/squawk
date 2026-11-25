# Plugins

A plugin adds a runner, an agent tool, a wait kind, a workflow step kind, a CLI command, a run
removal slot or a run-lifecycle listener to Squawk. Squawk loads plugins from one folder on the
host: `<config>/plugins/` (see the [platform roots](migration.md#home-directories); with
`HSQ_HOME` set, `$HSQ_HOME/config/plugins/`). Nothing needs to be configured: a folder that is
not there loads nothing.

[ADR 0070](adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md) records the design.

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

## Load order and failures

- The runners that ship with Squawk load first, then the plugins in `<config>/plugins/`, in
  ASCII order of folder name.
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
- `hsq --help` lists the built-in commands only, and loads no plugin. A plugin's command runs as
  `hsq <name>` like a built-in.
