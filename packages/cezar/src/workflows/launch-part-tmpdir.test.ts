import { registerLaunchPart, sealLaunchParts } from '../core/launch-registry.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { fakeRunnerFactory } from '../core/fake-runner-factory.testkit.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

const PLUGIN_TMP = '/plugin-custom-scratch';
registerLaunchPart({ id: 'custom-tmp', contribute: () => ({ env: { TMPDIR: PLUGIN_TMP } }) });
sealLaunchParts();

const { createFixtureManager, drainFixtureManagers } = await import('./fixture-manager.testkit.ts');

const specs: AgentRunSpec[] = [];
useRunners(fakeRunnerFactory((backend: string) => ({
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
})));
sealTestRunners();

const git = promisify(execFile);
const WORKFLOW: WorkflowDef = { name: 'tmp-override', source: 'built-in', steps: [{ id: 's1', prompt: '{{task}}' }] };

let repoRoot: string;
let store: RunStore;

beforeEach(async () => {
  specs.length = 0;
  repoRoot = mkdtempSync(join(tmpdir(), 'hsq-launch-part-tmp-'));
  await git('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
  await git('git', ['add', '-A'], { cwd: repoRoot });
  await git('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'init'], { cwd: repoRoot });
  store = RunStore.open(join(repoRoot, '.ai/cezar'));
});

afterEach(async () => {
  await drainFixtureManagers(repoRoot);
  store.persistence.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

it('grants additionalDirectories for a TMPDIR overridden by a launch part at step open and continuation', async () => {
  const manager = createFixtureManager(store, repoRoot);
  try {
    const run = manager.startRun(WORKFLOW, { task: 'check tmpdir', runner: 'claude', worktree: false });
    // bound: fake runner resolves immediately; wait for step settlement before Continue.
    await vi.waitFor(() => {
      expect(specs.length).toBe(1);
      expect(manager.isActive(run.id)).toBe(false);
    }, { timeout: 15_000 });
    expect(specs[0]?.env?.TMPDIR).toBe(PLUGIN_TMP);
    expect(specs[0]?.additionalDirectories).toContain(PLUGIN_TMP);

    store.updateStep(run.id, 's1', { sessionId: 'sess-tmp', backend: 'claude' });
    expect(manager.continueRun(run.id, { text: 'follow up' })).toEqual({ ok: true });
    // bound: fake runner resolves immediately; wait for continuation settlement.
    await vi.waitFor(() => {
      expect(specs.length).toBe(2);
      expect(manager.isActive(run.id)).toBe(false);
    }, { timeout: 15_000 });
    expect(specs[1]?.env?.TMPDIR).toBe(PLUGIN_TMP);
    expect(specs[1]?.additionalDirectories).toContain(PLUGIN_TMP);
  } finally {
    manager.dispose();
  }
});
