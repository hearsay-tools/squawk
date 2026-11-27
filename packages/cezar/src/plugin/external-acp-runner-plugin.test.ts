import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runtimeImports } from '../core/module-imports.testkit.ts';
import { Home } from '../home/home.ts';
import { projectPaths } from '../project-paths.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';

/**
 * External plain-JS ACP runner plugin (hearsay-tools/squawk#4397).
 * Lives outside the repository in `<config>/plugins/ext-acp-runner/`, imports Squawk only through
 * `@hearsay-tools/squawk/plugin`, `/runtime` and `/acp`, drives `scripts/mock-acp.mjs`, and runs a
 * task to the review gate.
 */

const pkg = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../index.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./__fixtures__/external-acp-runner', import.meta.url));
const RUNNER = 'ext-acp-runner';

// bound: hang guard for one `hsq` process (cold tsx start + one short mock ACP task).
const CLI_TIMEOUT_MS = 60_000;

let root: string;
let homeDir: string;
let home: Home;
let repo: string;
let plugin: string;

async function hsq(extraEnv: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HSQ_HOME: homeDir, CEZ_HOME: homeDir, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:CEZ|HSQ)_(?:TOOL_|TASK_|DELEGATION|HANDOFF_|ARTIFACTS_|PROJECT_|COCKPIT_|DRY_RUN|AGENT_MODELS_LOCKED|REVIEW_GATE|REMOTE)/.test(key) || key.startsWith('EXT_ACP_')) delete env[key];
  }
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: pkg, env, timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// bound: hang guard for two `hsq` invocations (`plugins --json` and `run`).
describe('an external plain-JS ACP runner plugin in <config>/plugins/', { timeout: 120_000 }, () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hsq-external-acp-runner-')));
    homeDir = join(root, 'home');
    home = Home.sandbox(homeDir);
    plugin = join(home.plugins, RUNNER);
    mkdirSync(home.plugins, { recursive: true });
    cpSync(fixture, plugin, { recursive: true });
    expect(relative(fileURLToPath(new URL('../../../..', import.meta.url)), plugin).startsWith('..')).toBe(true);

    const specifiers = ['index.mjs', 'adapter.mjs'].flatMap(file =>
      runtimeImports(readFileSync(join(plugin, file), 'utf8'), file));
    expect(specifiers).toEqual(expect.arrayContaining([
      '@hearsay-tools/squawk/plugin',
      '@hearsay-tools/squawk/plugin/runtime',
      '@hearsay-tools/squawk/plugin/acp',
      './adapter.mjs',
    ]));
    expect(
      specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('./') && !/^@hearsay-tools\/squawk\/plugin(?:\/(?:runtime|acp))?$/.test(specifier)),
    ).toEqual([]);

    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(repo, '.ai/squawk'), { recursive: true });
    writeFileSync(join(repo, '.ai/squawk/config.json'), `${JSON.stringify({ reviewGate: true, defaultRunner: RUNNER })}\n`);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('loads from <config>/plugins/ and runs a task to review over scripts/mock-acp.mjs', async () => {
    const pluginsRes = await hsq({}, 'plugins', '--json');
    expect(pluginsRes.code, pluginsRes.stderr).toBe(0);
    const report = JSON.parse(pluginsRes.stdout) as {
      loaded: { name: string; source: string; path: string; contributions: { runners: string[] } }[];
      failed: unknown[];
    };
    expect(report.failed).toEqual([]);
    expect(report.loaded.filter(entry => entry.source === 'host')).toEqual([
      expect.objectContaining({ name: RUNNER, path: plugin, contributions: expect.objectContaining({ runners: [RUNNER] }) }),
    ]);

    const result = await hsq({ CEZ_MOCK_NUDGE_REPLY: 'done' }, 'run', 'mock:acp-runtime-workspace', '--repo', repo);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`runner: ${RUNNER}`);
    expect(result.stdout).toContain('run review');

    const run = readPersistedRuns(projectPaths(repo).write).at(-1)!;
    expect(run).toMatchObject({ status: RUN_STATUS.review, runner: RUNNER });
    expect(run.steps.at(-1)).toMatchObject({ backend: RUNNER });
    expect(existsSync(join(run.worktreePath!, 'workspace-proof'))).toBe(true);
  });
});
