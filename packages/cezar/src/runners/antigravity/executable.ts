import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { productEnv, leaseManagedCli, managedCliExecutable, managedCliHome } from '@hearsay-tools/squawk/plugin';
import { ANTIGRAVITY_CLI } from './cli.ts';

/** The names Google's CLI is installed under: `agy` (Windows, symlinks) and `antigravity` (archives). */
const PATH_NAMES = ['agy', 'antigravity'] as const;
const source = ANTIGRAVITY_CLI.installSource.managed;
/** The name a missing CLI is spawned under: ENOENT reports it not installed. */
const NOT_INSTALLED = 'antigravity-cli-not-installed';
const identities = new Map<string, boolean | Promise<boolean>>();
const execFileAsync = promisify(execFile);

/** `--help` names the CLI and its `acp` command; `--version` prints a bare version. The Antigravity
 *  IDE launcher and the retired registry server print neither. */
export function antigravityCliOutput(help: string, version: string): boolean {
  return help.startsWith('Usage of antigravity:') && /^\s+acp\s/m.test(help) && /^\d+\.\d+\.\d+$/.test(version.trim());
}

/** A bare command name (an override such as `agy`) resolves through PATH, as the spawn does. */
export function resolveAntigravityCommand(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.includes('/') || path.includes('\\')) return path;
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) if (executableFile(join(dir, `${path}${suffix}`))) return join(dir, `${path}${suffix}`);
  }
  return path;
}

function identityOf(path: string): string | undefined {
  try {
    const target = realpathSync(resolveAntigravityCommand(path));
    const file = statSync(target, { bigint: true });
    return [target, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.mode].join(':');
  } catch { return undefined; }
}
const RUN = { encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144, windowsHide: true } as const;
// `--help` exits 0 or 2 by Go's flag package; the text decides.
const verdict = (help: { stdout: string; stderr: string } | undefined, version: { stdout: string } | undefined) =>
  !!help && !!version && antigravityCliOutput(`${help.stdout}${help.stderr}`, version.stdout);

/** The cached answer for this file, from metadata only: undefined until a check has finished. */
export function knownAntigravityCli(path: string): boolean | undefined {
  const identity = identityOf(path);
  const known = identity ? identities.get(identity) : false;
  return known instanceof Promise ? undefined : known;
}

/** Checks an executable once per file identity, off the event loop; a replaced file is checked again. */
export function checkAntigravityCli(path: string): Promise<boolean> {
  const identity = identityOf(path);
  if (!identity) return Promise.resolve(false);
  const known = identities.get(identity);
  if (known !== undefined) return Promise.resolve(known);
  // Go's flag package may exit 2 after --help; the text decides. --version must succeed.
  const command = resolveAntigravityCommand(path);
  const run = (args: string[]) => execFileAsync(command, args, RUN).then(output => ({ ...output, status: 0 }),
    (error: { stdout?: string; stderr?: string; code?: unknown }) =>
      typeof error.code === 'number' ? { stdout: error.stdout ?? '', stderr: error.stderr ?? '', status: error.code } : undefined);
  const check = (async () => {
    const help = await run(['--help']);
    const version = help ? await run(['--version']) : undefined;
    const cli = version?.status === 0 && verdict(help, version);
    identities.set(identity, cli);
    return cli;
  })();
  identities.set(identity, check);
  return check;
}

/** The same check, blocking: only a session start whose PATH candidate is still unchecked uses it. */
function checkAntigravityCliSync(path: string): boolean {
  const identity = identityOf(path);
  if (!identity) return false;
  const known = identities.get(identity);
  if (typeof known === 'boolean') return known;
  const help = spawnSync(path, ['--help'], RUN);
  const version = help.error ? undefined : spawnSync(path, ['--version'], RUN);
  const cli = !version?.error && version?.status === 0 && verdict(help, version);
  identities.set(identity, cli);
  return cli;
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  return (env.PATH ?? '').split(delimiter).filter(Boolean)
    .flatMap(dir => PATH_NAMES.flatMap(name => suffixes.map(suffix => join(dir, `${name}${suffix}`))))
    .filter(executableFile);
}

/** The first PATH entry that holds the CLI under one of its names. */
export async function antigravityOnPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const path of pathCandidates(env)) if (await checkAntigravityCli(path)) return path;
  return undefined;
}

/**
 * The same answer from metadata only, for detection stamps and status reads: the first candidate
 * already known to be the CLI. Unchecked candidates are checked in the background, so a later call
 * (and the detection stamp) sees them.
 */
export function cachedAntigravityOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const path of pathCandidates(env)) {
    const known = knownAntigravityCli(path);
    if (known) return path;
    if (known === undefined) { void checkAntigravityCli(path); return undefined; }
  }
  return undefined;
}

/** The managed install's active release. An unreadable install reads as absent, never as a boot failure. */
export function managedAntigravity(): string | undefined {
  const home = managedCliHome();
  if (!home) return undefined;
  try { return managedCliExecutable(home, 'antigravity', source) ?? undefined; }
  catch { return undefined; }
}

/** HSQ_ANTIGRAVITY_BIN, else the managed install, else the CLI on PATH. Undefined: not installed. */
/**
 * The status command's executable, from metadata only. While a PATH candidate is still being
 * checked it is that candidate, so a cold status read runs its --version instead of reporting the
 * CLI missing; `antigravityInstalled` then decides whether that output counts.
 */
export function antigravityStatusExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return antigravityExecutable(env) ?? pathCandidates(env).find(path => knownAntigravityCli(path) === undefined) ?? NOT_INSTALLED;
}

/** Whether a CLI is installed, waiting for an unfinished PATH check. */
export async function antigravityInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return !!(productEnv('ANTIGRAVITY_BIN', env) || managedAntigravity() || await antigravityOnPath(env));
}

/** The status command ran a PATH entry: no override, no managed release, and a candidate exists.
 *  Whichever entry it ran, the cached CLI check (`antigravityInstalled`) decides, so concurrent
 *  cold reads agree. The answer depends on files, not on which checks have finished. */
export function antigravityStatusFromPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return !productEnv('ANTIGRAVITY_BIN', env) && !managedAntigravity() && pathCandidates(env).length > 0;
}

export function antigravityExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return productEnv('ANTIGRAVITY_BIN', env) || managedAntigravity() || cachedAntigravityOnPath(env);
}

export interface AntigravityLaunch {
  readonly executable: string;
  /** Bind the managed release to the started process, so an update cannot prune it. */
  bindProcess(pid: number): void;
  release(): void;
}

const unleased = (executable: string): AntigravityLaunch => ({ executable, bindProcess() {}, release() {} });

/** Resolve for one process. A managed release is pinned before spawn: bind it at once, release after exit. */
export function launchAntigravity(override: string | undefined): AntigravityLaunch | undefined {
  if (override) return unleased(override);
  const home = managedCliHome();
  try {
    const lease = home ? leaseManagedCli(home, 'antigravity', source) : null;
    if (lease) return lease;
  } catch { /* An unreadable managed install falls through to PATH. */ }
  const found = pathCandidates(process.env).find(checkAntigravityCliSync);
  return found ? unleased(found) : undefined;
}

/** A launch that cannot start: spawning it fails with ENOENT, which reports ANTIGRAVITY_MISSING.
 *  A rejected PATH binary (the IDE launcher, the registry server) is never run. */
export function missingAntigravity(dir: string): AntigravityLaunch {
  return unleased(join(dir, NOT_INSTALLED));
}

export const ANTIGRAVITY_MISSING = 'The Antigravity CLI is not installed. Install it from Settings > Agents > Install CLI, put agy on PATH, or set HSQ_ANTIGRAVITY_BIN.';
