import { cliCommand, cliCommandsSealed, commandNeedsRuntime, registeredCliCommands } from './core/cli-registry.ts';
import { bootColdCli, bootRuntime } from './boot.ts';
import { builtInCliCommand } from './built-in-cli-commands.ts';
import { commandText, oldCommandNotice } from './home/command.ts';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { operatorHomeEntry, prepareOperatorHome } from './home/entry.ts';
import { bindManagedCliHome } from './managed-install/runtime-home.ts';
import type { Home } from './home/home.ts';
import { runSubcommand, prepareCommandRuntime } from './subcommands.ts';
import { getRepoInfo } from './server/git.ts';
import { projectPaths } from './project-paths.ts';
import { assertProjectAdmitted, projectAdmissionRefusal } from './server/cockpit-ownership.ts';
import type { serverCommand } from './server-command.ts';
import type { TaskAccess } from './headless-run.ts';

export const defaultCliDeps = {
  parseArgs, operatorHomeEntry, prepareOperatorHome,
  runSubcommand, getRepoInfo,
  runProjectsCommand: async (...args: Parameters<typeof import('./workspace/projects-cli.ts').runProjectsCommand>) =>
    (await import('./workspace/projects-cli.ts')).runProjectsCommand(...args),
  process, console,
};

export type CliDeps = typeof defaultCliDeps & {
  resolveCliHome: () => Home;
  readOwnVersion: () => string;
  serveCommand: (home: Home, root: string, port: number, open: boolean, bindHost: string | undefined) => Promise<void>;
  serverCommand: typeof serverCommand;
  runCommand: (home: Home, root: string, task: string, workflow: string | undefined, model: string | undefined, access: TaskAccess) => Promise<void>;
  initCommand: (root: string) => void | Promise<void>;
};

function cliHelp(): string {
  return `Squawk — local cockpit for AI agent tasks in your repo

Usage:
${registeredCliCommands().flatMap(command => command.usage).join('\n')}

Options:
  -p, --port <n>              cockpit port (default 4321; server-install: this
                              instance's loopback port — auto-picked per domain)
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: quick-task)
      --model <model>         model override for \`run\`
      --no-workers            \`run\`: the task cannot start or resume Squawk workers
      --no-messaging          \`run\`: no new peer-task messages; worker messages and replies stay
      --no-open               don't open the browser
      --platform <id>         server-install target (ubuntu-vps | macosx-ngrok)
      --domain <host>         server-install (ubuntu-vps): host a SECOND, independent
                              cockpit for this domain (own nginx site + service + port).
                              A new domain never resumes/clobbers the first install.
      --external-proxy        server-install (ubuntu-vps): the box ALREADY has a
                              reverse proxy owning :80/:443 (Dokploy/Traefik, Coolify,
                              Caddy, your own nginx). Installs the service only — no
                              nginx, no certbot. That proxy must provide TLS + auth.
      --bind-host <host>      host the cockpit binds (default 127.0.0.1). Use with
                              --external-proxy when the proxy runs in a container and
                              cannot reach loopback (e.g. docker bridge 172.17.0.1).
                              Squawk has NO built-in auth — never expose this publicly.
      --yes                   server-install: accept safe defaults (never auto-sudo)
      --reconfigure <ids>     server-install: force re-run of step id(s), comma-separated
      --reinstall             server-install: force re-run of every step (full reinstall)
  -v, --version               show the package version
  -h, --help                  show this help

Zero config: uses your logged-in \`claude\` CLI (and \`gh\` for GitHub bits).
Skills live in .ai/skills/, .ai/squawk/skills/ and your team skills repos
workflows in .ai/squawk/workflows/. A project also reads .ai/cezar/, the old folder name.
Plugins in <config>/plugins/ can add commands: run \`cez plugins\` to list them.`;
}

const ROOT_OPTIONS = {
  port: { type: 'string', short: 'p', default: '4321' },
  repo: { type: 'string' },
  workflow: { type: 'string' },
  model: { type: 'string' },
  'no-workers': { type: 'boolean', default: false },
  'no-messaging': { type: 'boolean', default: false },
  'no-open': { type: 'boolean', default: false },
  platform: { type: 'string' },
  domain: { type: 'string' },
  'bind-host': { type: 'string' },
  'external-proxy': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  reconfigure: { type: 'string' },
  reinstall: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

/**
 * Whether this command line needs the full boot (spec 2026-11-24-plugin-loader-and-runner-kit § 1).
 * Help, version and a built-in whose `runtimeMode` is false stay cold. A built-in runtime command
 * and an unknown command name boot fully, so plugins register their commands before the seal.
 */
export function cliNeedsRuntime(argv: readonly string[]): boolean {
  const head = argv[0];
  const builtIn = head === undefined ? undefined : builtInCliCommand(head);
  if (builtIn?.parseMode === 'subcommand') return commandNeedsRuntime(builtIn, argv.slice(1));
  if (head !== undefined && !head.startsWith('-') && !builtIn) return true;
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: ROOT_OPTIONS, allowPositionals: true });
  } catch {
    // Dispatch reports the parse error; that needs no runtime.
    return false;
  }
  if (parsed.values.help || parsed.values.version) return false;
  const command = parsed.positionals[0] ?? 'serve';
  const definition = builtInCliCommand(command);
  return definition ? commandNeedsRuntime(definition, parsed.positionals.slice(1)) : true;
}

/** The operator's `<config>/plugins/`. An unresolvable home loads no host plugin. */
function hostPluginsDir(deps: CliDeps): string | undefined {
  try {
    return deps.resolveCliHome().plugins;
  } catch (error) {
    deps.console.error(`[hsq] plugin folder unavailable (${error instanceof Error ? error.message : String(error)}) — continuing without plugins`);
    return undefined;
  }
}

/** Seal the command table the way this command line needs, before dispatch reads it. */
async function bootCli(deps: CliDeps, argv: readonly string[]): Promise<void> {
  // An embedding caller (or a test) may seal its own table first.
  if (cliCommandsSealed()) return;
  if (cliNeedsRuntime(argv)) await bootRuntime({ pluginsDir: hostPluginsDir(deps) });
  else bootColdCli();
}

/** Project commands finish an unfinished migration journal, then refuse a project under a
 *  migration fence before they touch it; each re-checks right before its first project write.
 *  `serve` recovers and checks in its ownership claim. The recovery module loads only when a
 *  journal exists. */
async function admitProjectCommand(command: string, repoRoot: string): Promise<void> {
  if (command !== 'run' && command !== 'init') return;
  const dataDir = projectPaths(repoRoot).write;
  if (projectAdmissionRefusal(dataDir)?.reason === 'journal') await (await import('./project-migration/recovery.ts')).recoverProjectMigration(repoRoot);
  assertProjectAdmitted(dataDir);
}

export async function main(deps: CliDeps): Promise<void> {
  const notice = oldCommandNotice(deps.process.argv[1]);
  if (notice) deps.console.error(notice);
  return dispatch(deps);
}

/** Metadata exits before project admission or home preparation. */
function printCliMetadata(deps: CliDeps, values: { version?: boolean; help?: boolean }, help: () => string): boolean {
  if (values.version) {
    deps.console.log(deps.readOwnVersion());
    deps.process.exitCode = 0;
    return true;
  }
  if (values.help) {
    deps.console.log(help());
    return true;
  }
  return false;
}

async function dispatch(deps: CliDeps): Promise<void> {
  await bootCli(deps, deps.process.argv.slice(2));
  // Help reads resolved paths only. Task commands and version output never need a Home.
  const help = () => commandText(cliHelp(), deps.process.argv[1]);
  let resolvedHome: Home | undefined;
  let homeEntry = deps.operatorHomeEntry(deps.process.argv.slice(2));
  // Dispatch task commands without invoking this factory or giving them a Home.
  const home = () => resolvedHome ??= bindManagedCliHome(deps.prepareOperatorHome(deps.resolveCliHome(), homeEntry));
  // Subcommands with flags of their own run before the global parseArgs (#504, #774, #1576).
  const subcommandExit = await deps.runSubcommand(deps.process.argv.slice(2), deps.process.env, home);
  if (subcommandExit !== undefined) {
    deps.process.exitCode = subcommandExit;
    return;
  }
  const { values, positionals } = deps.parseArgs({
    args: deps.process.argv.slice(2),
    options: ROOT_OPTIONS,
    allowPositionals: true,
  });

  // `port` carries a default, so its presence can't tell an explicit `--port`
  // from the fallback. server-install needs that distinction (explicit port
  // wins; otherwise a new named instance auto-picks a free one), so detect the
  // flag straight from argv.
  const portExplicit = deps.process.argv
    .slice(2)
    .some((a) => a === '-p' || a === '--port' || a.startsWith('--port=') || a.startsWith('-p='));

  if (printCliMetadata(deps, values, help)) return;

  const command = positionals[0] ?? 'serve';
  const definition = cliCommand(command);
  if (definition?.parseMode === 'root') await prepareCommandRuntime(command, positionals.slice(1));
  const task = positionals.slice(1).join(' ').trim();
  homeEntry = cliCommand(command)?.homeEntry?.(positionals) ?? command;
  const cwd = resolve(values.repo ?? deps.process.cwd());
  const repoInfo = await deps.getRepoInfo(cwd);
  const repoRoot = repoInfo?.root ?? cwd;
  await admitProjectCommand(command, repoRoot);

  if (definition?.parseMode === 'root') {
    const run = await definition.load();
    await run({ deps, home, repoRoot, task, positionals, values, portExplicit });
    return;
  }
  deps.console.error(`unknown command: ${command}\n`);
  deps.console.log(help());
  deps.process.exitCode = 1;
}
