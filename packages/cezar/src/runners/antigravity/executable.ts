import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { productEnv } from '../../core/product-env.ts';
import { leaseManagedCli, managedCliExecutable } from '../../managed-install/cli-storage.ts';
import { managedCliHome } from '../../managed-install/runtime-home.ts';
import { ANTIGRAVITY_CLI } from './cli.ts';

/** The names Google's CLI is installed under: `agy` (Windows, symlinks) and `antigravity` (archives). */
const PATH_NAMES = ['agy', 'antigravity'] as const;
const source = ANTIGRAVITY_CLI.installSource.managed;
const identities = new Map<string, boolean>();

/** `--help` names the CLI and its `acp` command; `--version` prints a bare version. The Antigravity
 *  IDE launcher and the retired registry server print neither. */
export function antigravityCliOutput(help: string, version: string): boolean {
  return help.startsWith('Usage of antigravity:') && /^\s+acp\s/m.test(help) && /^\d+\.\d+\.\d+$/.test(version.trim());
}

/** Each executable is checked once per file identity; a replaced file is checked again. */
export function isAntigravityCli(path: string): boolean {
  let identity: string;
  try {
    const target = realpathSync(path);
    const file = statSync(target, { bigint: true });
    identity = [target, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.mode].join(':');
  } catch { return false; }
  const known = identities.get(identity);
  if (known !== undefined) return known;
  const run = (args: string[]) => spawnSync(path, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144, windowsHide: true });
  const help = run(['--help']);
  const version = help.error ? undefined : run(['--version']);
  // `--help` exits 0 or 2 by Go's flag package; the text decides.
  const cli = !!version && !version.error && version.status === 0 && antigravityCliOutput(`${help.stdout}${help.stderr}`, version.stdout);
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

/** The first PATH entry that holds the CLI under one of its names. */
export function antigravityOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of PATH_NAMES) {
      for (const suffix of suffixes) {
        const path = join(dir, `${name}${suffix}`);
        if (executableFile(path) && isAntigravityCli(path)) return path;
      }
    }
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
export function antigravityExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return productEnv('ANTIGRAVITY_BIN', env) ?? managedAntigravity() ?? antigravityOnPath(env);
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
  const found = antigravityOnPath();
  return found ? unleased(found) : undefined;
}

export const ANTIGRAVITY_MISSING = 'The Antigravity CLI is not installed. Install it from Settings > Accounts > Install CLI, put agy on PATH, or set HSQ_ANTIGRAVITY_BIN.';
