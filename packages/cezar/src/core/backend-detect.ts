import { productIdentity } from '../home/identity.ts';
import type { RunnerDetection } from './runner-definition.ts';
import { registeredRunners } from './runner-registry.ts';
import { productEnv } from './product-env.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { runGit } from '../git-command.ts';

const exec = promisify(execFile);

export interface BackendCheck {
  /** A runner id, `gh` or `git`. */
  name: string;
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probe the host for everything cez leans on: the agent CLIs (`claude`, and
 * the optional `codex` / `opencode` / `pi` / `omp` alternatives), `gh` (GitHub auth for
 * PR creation) and `git`. Nothing is required except at least one agent CLI —
 * the GUI degrades gracefully, only offers the runners that are present, and
 * shows the hints for the rest.
 */
export async function detectEnvironment(): Promise<BackendCheck[]> {
  return Promise.all([...registeredRunners().map((runner) => probeRunner(runner.id, runner.detection)), probeGh(), probeGit()]);
}

/** The executables `detectEnvironment` starts, as each probe names them. */
function probedBinaries(): string[] {
  return [...registeredRunners().map(({ detection }) => detection.binOverride() ?? detection.binary), 'gh', 'git'];
}

/** The file a PATH lookup of `bin` finds, followed through symlinks, with its identity; `-` when none. */
async function binarySignature(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const names = process.platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')].map((ext) => bin + ext.toLowerCase())
    : [bin];
  const dirs = bin.includes('/') || isAbsolute(bin) ? [''] : (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const path = dir ? join(dir, name) : name;
      try {
        const s = await stat(path, { bigint: true });
        if (!s.isFile()) continue;
        // The process lookup skips a file it may not execute and goes on along PATH.
        if (process.platform !== 'win32') await access(path, constants.X_OK);
        const target = await realpath(path);
        const t = await stat(target, { bigint: true });
        return `${path}>${target}:${t.dev}:${t.ino}:${t.size}:${t.mtimeNs}:${t.ctimeNs}:${t.mode}`;
      } catch {
        // not here: the lookup goes on to the next PATH entry
      }
    }
  }
  return '-';
}

/** The variables `gh` reads before its hosts file: tokens and the host they belong to. */
function ghEnv(env: NodeJS.ProcessEnv): Array<string | null> {
  return [env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_ENTERPRISE_TOKEN, env.GITHUB_ENTERPRISE_TOKEN, env.GH_HOST, env.GH_CONFIG_DIR]
    .map((value) => value ?? null);
}

/** The file `gh auth login` and `gh auth logout` rewrite. */
function ghHostsFile(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, 'hosts.yml');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh', 'hosts.yml');
  if (process.platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI', 'hosts.yml');
  return env.HOME ? join(env.HOME, '.config', 'gh', 'hosts.yml') : undefined;
}

/**
 * A signature of what `detectEnvironment` would see, read from file metadata only: where each
 * probed executable resolves on PATH and the file behind it, the `gh` login file and the dry-run
 * switch. Installing, removing or upgrading a CLI, `gh auth login`/`logout` and a `gh` token in the
 * environment change it. It starts no process, so a caller can check it often and probe only on a
 * change (hearsay-tools/squawk#3658).
 */
export async function environmentStamp(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const binaries = await Promise.all(probedBinaries().map(async (bin) => `${bin}=${await binarySignature(bin, env)}`));
  const hostsFile = ghHostsFile(env);
  const hosts = hostsFile ? await stat(hostsFile, { bigint: true }).then(
    (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
    () => '-', // not logged in through a hosts file
  ) : '-';
  // `gh` prefers these over its hosts file; only a digest enters the stamp, never a token.
  const tokens = createHash('sha256').update(JSON.stringify(ghEnv(env))).digest('hex');
  return [...binaries, `gh-hosts=${hosts}`, `gh-env=${tokens}`, `dry-run=${productEnv('DRY_RUN') ?? ''}`].join('\n');
}

/** Banner spelling follows the release identity; switch-off output stays stable. */
function dryRunVersion(): string {
  return `mock (${productIdentity().envPrefix}DRY_RUN=1)`;
}

/**
 * Probe one runner's CLI, as its definition describes it (`RunnerDetection`): an override key or
 * the PATH name, a `--version` call, and the definition's hints.
 */
export async function probeRunner(name: string, detection: RunnerDetection): Promise<BackendCheck> {
  const override = detection.binOverride();
  if (productEnv('DRY_RUN') === '1' && (detection.dryRun === 'always' || override === undefined)) {
    return { name, available: true, version: dryRunVersion() };
  }
  const bin = override ?? detection.binary;
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 10_000 });
    const banner = stdout.trim();
    const version = detection.versionPattern?.exec(banner)?.[1]?.trim() ?? banner;
    if (detection.banner && !detection.banner.pattern.test(banner)) {
      return {
        name,
        available: false,
        hint: `\`${bin}\` resolves but doesn't look like ${detection.banner.label} (got: ${version.slice(0, 80)})`,
      };
    }
    return { name, available: true, version, hint: detection.availableHint };
  } catch {
    return { name, available: false, hint: detection.missingHint };
  }
}

async function probeGh(): Promise<BackendCheck> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    return { name: 'gh', available: stdout.trim().length > 0, version: 'authenticated' };
  } catch {
    return {
      name: 'gh',
      available: false,
      hint: 'install the GitHub CLI and run `gh auth login` (only needed for PR creation)',
    };
  }
}

async function probeGit(): Promise<BackendCheck> {
  try {
    const { stdout } = await runGit(['--version'], { timeout: 10_000 });
    return { name: 'git', available: true, version: stdout.trim() };
  } catch {
    return { name: 'git', available: false, hint: 'install git' };
  }
}

/** The host's GitHub token: logged-in `gh` first, `GITHUB_TOKEN` fallback. */
export async function readHostGithubToken(): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 10_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the env var
  }
  return process.env.GITHUB_TOKEN?.trim() || null;
}
