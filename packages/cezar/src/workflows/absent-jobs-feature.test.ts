import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import type { WorkflowDef } from './types.ts';

const git = promisify(execFile);
const WORKFLOW: WorkflowDef = { name: 'absent-jobs', source: 'built-in', steps: [{ id: 's1', prompt: '{{task}}' }] };

describe('boot and task execution with bundled jobs feature absent (hearsay-tools/squawk#4315)', () => {
  let root: string;
  let emptyFeatures: string;
  let emptyHost: string;
  let repoRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('HSQ_REVIEW_GATE', '0');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
    vi.stubEnv('HSQ_AUTONAME', '0');
    vi.stubEnv('CEZ_AUTONAME', '0');
    root = mkdtempSync(join(tmpdir(), 'hsq-absent-feature-'));
    emptyFeatures = mkdtempSync(join(root, 'features-'));
    emptyHost = mkdtempSync(join(root, 'host-'));
    repoRoot = join(root, 'repo');
    await git('git', ['init', '-q', '-b', 'main', repoRoot]);
    await git('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await git('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'ok\n');
    await git('git', ['add', '-A'], { cwd: repoRoot });
    await git('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('omits jobs from hsq plugins, rejects hsq job, omits job text from wait metadata, and completes a task without job prompt', async () => {
    const { bootRuntime } = await import('../boot.ts');
    await bootRuntime({ bundledFeaturesDir: emptyFeatures, pluginsDir: emptyHost });

    const { testHome } = await import('../home/test-home.testkit.ts');
    const { fakeRunnerFactory } = await import('../core/fake-runner-factory.testkit.ts');
    const { RunStore } = await import('../runs/store.ts');
    const { pluginLoadReport } = await import('../plugin/loader.ts');
    const { formatPluginReport } = await import('../plugin/cli.ts');
    const report = pluginLoadReport();
    expect(report.failed).toEqual([]);
    expect(report.loaded.map(p => p.name)).not.toContain('jobs');
    const formatted = formatPluginReport(report);
    expect(formatted).not.toMatch(/^\s+jobs\s+/m);
    expect(formatted).not.toContain('launch parts: jobs');

    const { defaultCliDeps, main } = await import('../cli-dispatch.ts');
    const log = vi.fn();
    const error = vi.fn();
    const processStub = { argv: ['/bin/node', '/bin/hsq', 'job', 'status', 'x'], env: {}, cwd: () => repoRoot, exitCode: undefined as number | undefined };
    await main({
      ...defaultCliDeps,
      process: processStub as unknown as NodeJS.Process,
      console: { log, error, warn: vi.fn() } as unknown as Console,
      resolveCliHome: () => testHome(),
      prepareOperatorHome: () => testHome(),
      getRepoInfo: vi.fn().mockResolvedValue(null),
      readOwnVersion: () => '0.0.0-test',
      serveCommand: vi.fn(), serverCommand: vi.fn(), runCommand: vi.fn(), initCommand: vi.fn(),
    });
    expect(processStub.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown command: job'));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('hsq job'));

    const { waitToolDefinition } = await import('../ci-wait/tools.ts');
    const properties = (waitToolDefinition.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(waitToolDefinition.description).not.toMatch(/\bhsq job\b|job start/i);
    expect(waitToolDefinition.description).toContain('kind "process"');
    expect(properties.pid?.description).not.toMatch(/\bhsq job\b|job start/i);
    expect(properties.exit_file?.description).not.toMatch(/\bhsq job\b|job start/i);

    const specs: AgentRunSpec[] = [];
    const { RunManager } = await import('./run.ts');
    const { acquireCiResources } = await import('../ci-wait/resources.ts');
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const manager = new RunManager(store, repoRoot, {
      home: testHome(),
      acquireCiResources,
      createRunner: fakeRunnerFactory((backend: string) => ({
        backend,
        systemPromptOnResume: 'resent' as const,
        run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
        startSession: (spec: AgentRunSpec) => {
          specs.push(spec);
          return {
            result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
            sendMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
            end: () => {}, interrupt: () => {}, open: false,
          };
        },
        interrupt: async () => {},
      })),
    });
    try {
      const record = manager.startRun(WORKFLOW, { task: 'run without jobs', runner: 'claude', worktree: false });
      // bound: fake runner resolves immediately; wait for run settlement.
      await vi.waitFor(() => {
        const current = store.getRun(record.id);
        expect(specs.length, `run=${JSON.stringify({ status: current?.status, error: current?.error })}`).toBe(1);
        expect(manager.isActive(record.id)).toBe(false);
        expect(current?.status).toBe('done');
      }, { timeout: 15_000 });
      const prompt = specs[0]?.systemPrompt ?? '';
      expect(prompt).toContain('## Handoff (Squawk)');
      expect(prompt).toContain('## Task artifacts');
      expect(prompt).not.toContain('## Long commands');
      expect(prompt).not.toMatch(/\bhsq job\b|job start/i);
    } finally {
      manager.dispose();
      store.persistence.flush();
    }
  });
});
