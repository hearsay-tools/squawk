import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { ContinueRunOptions } from './continuation-admission.ts';
import { acceptanceOver } from './continuation-acceptance-fakes.testkit.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';

// Session affinity and model presets read the runner definitions, as the engine fixture registered them.

sealTestRunners(claudeRunner, codexRunner);

/** The record patch and refusals a Continue's admission and acceptance compute
 *  (`continuation-admission.ts`, `run/continuation-acceptance.ts`). The launch that follows,
 *  and the session it resumes, are in run-continue-recovery-engine.test.ts. */
describe('ContinuationAcceptance: Continue override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: ReturnType<typeof acceptanceOver>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = acceptanceOver(store, repoRoot);
  });

  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it.each([true, false, undefined])('human Continue preserves saved autonomous=%s (#458)', (autonomous) => {
    const id = resumableRun();
    store.updateRun(id, { autonomous });
    expect(manager.continueRun(id, { text: 'Continue setup' })).toEqual({ ok: true });
    expect(store.getRun(id)?.status).toBe('running');
    expect(store.getRun(id)?.autonomous).toBe(autonomous);
    store.persistence.flush();
    expect(RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(id)?.autonomous)
      .toBe(autonomous);
  });

  it.each([
    { name: 'runner and model override', options: { runner: 'codex', model: 'gpt-5.1-codex' }, expected: { runner: 'codex', model: 'gpt-5.1-codex' } },
    { name: 'omitted backend and model', options: { text: 'keep going' }, expected: { runner: 'claude', model: 'sonnet' } },
    { name: 'empty effort clears the pin', seed: { effort: 'high' }, options: { effort: '' }, expected: { effort: undefined } },
    { name: 'runner switch keeps effort', seed: { effort: 'max' }, options: { runner: 'codex' }, expected: { effort: 'max' } },
    { name: 'empty model clears the pin', options: { model: '' }, expected: { model: undefined, runner: 'claude' } },
    { name: 'foreign preset is refused', options: { model: 'gpt-5.1-codex' }, error: "model 'gpt-5.1-codex' is not a claude model", expected: { model: 'sonnet', runner: 'claude' } },
    { name: 'runner switch clears foreign model', options: { runner: 'codex' }, expected: { runner: 'codex', model: undefined } },
    { name: 'runner switch keeps free-form model', seed: { model: 'my-org/custom-tune' }, options: { runner: 'codex' }, expected: { model: 'my-org/custom-tune' } },
    { name: 'same runner keeps model', options: { runner: 'claude' }, expected: { model: 'sonnet' } },
    { name: 'legacy runner refuses foreign preset', seed: { runner: undefined, model: undefined }, options: { model: 'gpt-5.1-codex' }, error: "model 'gpt-5.1-codex' is not a claude model", expected: { model: undefined } },
    { name: 'free-form model is accepted', options: { model: 'my-custom-alias' }, expected: { model: 'my-custom-alias' } },
    { name: 'omitted account keeps the pin', seed: { agentProfile: 'klaudiusz' }, options: { text: 'keep going' }, expected: { agentProfile: 'klaudiusz' } },
    { name: 'runner switch clears foreign account', seed: { agentProfile: 'klaudiusz' }, options: { runner: 'codex' }, expected: { agentProfile: undefined } },
    { name: 'same runner keeps account', seed: { agentProfile: 'klaudiusz' }, options: { runner: 'claude' }, expected: { agentProfile: 'klaudiusz' } },
  ] satisfies Array<{ name: string; seed?: Partial<RunRecord>; options: ContinueRunOptions; error?: string; expected: Partial<RunRecord> }>)('persists the Continue override patch: $name', ({ seed, options, error, expected }) => {
    const id = resumableRun();
    if (seed) store.updateRun(id, seed);
    expect(manager.continueRun(id, options)).toEqual(error ? { ok: false, error } : { ok: true });
    const after = store.getRun(id);
    for (const [key, value] of Object.entries(expected)) expect(after?.[key as keyof RunRecord]).toEqual(value);
  });

  it('persists an effort override and keeps it when Continue omits it (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'medium' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('medium');
    setRunStatus(store, id, RUN_STATUS.done);

    expect(manager.continueRun(id, { effort: 'xhigh' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('xhigh');
  });

  it('rejects an effort override while modelsLocked (#45)', () => {
    const id = resumableRun();
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );
    const result = manager.continueRun(id, { effort: 'max' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/locked/);
    expect(store.getRun(id)?.effort).toBeUndefined();
  });

  it('refuses to continue a run with no resumable session (no override persisted)', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [] });
    setRunStatus(store, record.id, RUN_STATUS.done);
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });
});
