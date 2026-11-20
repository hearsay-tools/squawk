import { productIdentity } from '../home/identity.ts';
import type { RunnerDetection } from './runner-definition.ts';
import { registeredRunners } from './runner-registry.ts';
import { productEnv } from './product-env.ts';
import { execFile } from 'node:child_process';
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
    const version = stdout.trim();
    if (detection.banner && !detection.banner.pattern.test(version)) {
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
