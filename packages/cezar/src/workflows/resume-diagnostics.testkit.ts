import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it as registerTest, vi } from 'vitest';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { nativeRecording, sessionWire } from './runner-session-wires.testkit.ts';
import { manager, restart, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import {
  RESUME_DIAGNOSTICS_GROUPS, registerResumeDiagnosticsFamily,
  type ResumeDiagnosticsCells, type ResumeDiagnosticsFamily,
} from './resume-diagnostics-rows.testkit.ts';
export { RESUME_DIAGNOSTICS_GROUPS } from './resume-diagnostics-rows.testkit.ts';

// hearsay-tools/cezarion#1380: losing the saved cause before Continue, or preferring a
// saved message over the restart explanation, must fail on every native input wire.
function native(runner: string) {
  const adapter = HARNESS_ADAPTERS[runner]!;
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(root, 'args'));
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(root, 'stdin'));
  return () => ciNativeMessages(runner, root).map(text => {
    // In-thread runners prepend their system instructions to the native input.
    const separator = '\n\n---\n\n';
    const at = text.lastIndexOf(separator);
    return at < 0 ? text : text.slice(at + separator.length);
  });
}

/** The native skill input, including its context; plain prompts cannot satisfy this read. */
function skillOpening(runner: string): string | undefined {
  return sessionWire(runner).skillTriggers(nativeRecording(join(root, 'args'), join(root, 'stdin')), 'probe-project')[0];
}

async function start(runner: string, scenario: 'provider-error' | 'cezar-done') {
  const run = manager.startRun(QUICK_TASK_WORKFLOW, {
    task: HARNESS_ADAPTERS[runner]!.scenarios[scenario]!, runner, worktree: false,
  });
  await until(() => [RUN_STATUS.failed, RUN_STATUS.done, RUN_STATUS.review].some(status => status === store.getRun(run.id)?.status) && !manager.isActive(run.id));
  return run.id;
}
const RESUME_DIAGNOSTICS_CELLS: ResumeDiagnosticsCells = {
  R85: (runner) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'provider-error');
      for (const text of [`${HARNESS_ADAPTERS[runner]!.scenarios['provider-error']!}\nKeep this second line.`, '']) {
        const failed = structuredClone(store.getRun(id)!.steps.at(-1)!);
        expect(failed.status).toBe(STEP_STATUS.failed);
        expect(failed.error).toBeTruthy();
        const before = messages().length;
        expect(manager.continueRun(id, { text })).toEqual({ ok: true });
        // Read the committed row before async startup: error clearing must not lose the cause.
        const disk = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
        expect(disk.error).toBeUndefined();
        expect(disk.continuationMessage).toMatchObject({
          text: text || 'Continue.',
          resumeContext: { failure: { stepId: failed.id, error: failed.error } },
        });
        await until(() => messages().length > before);
        const prompt = messages()[before]!;
        const [line, ...body] = prompt.split('\n');
        expect(line).toContain('failed');
        expect(line).toContain(failed.id);
        expect(line).toContain(failed.error);
        expect(line).toContain('Subagents it started stopped with it. Shell commands it started may have stopped.');
        expect(body.join('\n')).toBe(text || 'Continue.');
        // The cockpit shows the notice the agent received beside the Continue's own message.
        const notices = store.eventLog.readEvents(id).filter(event => event.type === 'note' && event.stepId === disk.continuationMessage.id
          && String(event.message).startsWith('Sent to the agent with this Continue: '));
        expect(notices).toHaveLength(1);
        expect(notices[0]!.message).toContain(`failed: ${failed.error}`);
        expect(notices[0]!.message).toContain('Subagents it started stopped with it. Shell commands it started may have stopped.');
        if (text) await until(() => store.getRun(id)?.status === RUN_STATUS.failed && !manager.isActive(id));
      }
  },
  R89: (runner) => async () => {
      native(runner);
      manager.setSkillCatalog(fixedSkillCatalog([{ id: 'probe-project', name: 'Probe', scope: 'repo', path: join(root, 'SKILL.md') }]));
      const id = await start(runner, 'provider-error');
      const error = 'Provider unavailable\nTry later\r\nNo retry was made.';
      store.updateStep(id, 'task', { error });
      expect(manager.continueRun(id, { text: '/probe-project' })).toEqual({ ok: true });
      await until(() => skillOpening(runner) !== undefined);
      const prompt = skillOpening(runner)!;
      expect(prompt).toContain('Provider unavailable Try later No retry was made.');
      expect(prompt).not.toContain(error);
      expect(prompt).toContain('Subagents it started stopped with it. Shell commands it started may have stopped.');
      expect(prompt).not.toContain('Selected skill:');
      await until(() => store.eventLog.readEvents(id).some(event => event.type === 'text' && String(event.text).includes('TRIGGER-FIXTURE')));
      expect(store.eventLog.readEvents(id).filter(event => event.type === 'user-message').at(-1)?.text).toBe('/probe-project');
  },
  R87: (runner) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'cezar-done');
      const before = messages().length;
      const text = 'Keep working.\nKeep this second line.';
      expect(manager.continueRun(id, { text })).toEqual({ ok: true });
      await until(() => messages().length > before);
      expect(messages()[before]).toBe(text);
  },
  R91: (runner) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'cezar-done');
      const text = `The Squawk process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.`;
      const before = messages().length;
      expect(manager.continueRun(id, { text })).toEqual({ ok: true });
      await until(() => messages().length > before);
      expect(messages()[before]).toBe(text);
  },
  R88: (runner) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'provider-error');
      const failed = structuredClone(store.getRun(id)!.steps.at(-1)!);
      const text = 'Review the attached brief.';
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      expect(manager.continueRun(id, {
        text, images: [{ type: 'file', mediaType: 'application/pdf', data: Buffer.from('brief-1380').toString('base64') }],
      }, true)).toEqual({ ok: true });
      const accepted = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(accepted.continuationMessage.images).toHaveLength(1);
      const url = accepted.continuationMessage.images[0] as string;
      const path = join(root, '.ai/cezar/runs', `${id}-images`, url.split('/').at(-1)!);
      const before = messages().length;
      await restart();
      const recovered = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(recovered.continuationMessage).toMatchObject({ text, images: [url], resumeContext: {
        failure: { stepId: failed.id, error: failed.error }, restarted: true,
      } });
      held.mockRestore();
      await semaphore.release();
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.split('\n')[0]).toContain(failed.error);
      expect(prompt.split('\n')[0]).toContain('process restarted while you were working');
      expect(prompt).toContain(`\n${text}`);
      expect(prompt).toContain(path);
      expect(readFileSync(path, 'utf8')).toBe('brief-1380');
  },
  R90: (runner) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'cezar-done');
      store.updateStep(id, 'task', { status: STEP_STATUS.running, finishedAt: undefined });
      setRunStatus(store, id, RUN_STATUS.running, { currentStepId: 'task', finishedAt: undefined, continuationMessage: undefined });
      const before = messages().length;
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      await restart();
      const checkpoint = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(checkpoint.continuationMessage).toMatchObject({ text: 'Continue.', origin: 'lifecycle', resumeContext: { restarted: true } });
      await restart();
      held.mockRestore();
      await semaphore.release();
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.match(/process restarted while you were working/g)).toHaveLength(1);
      expect(prompt.split('\n')[0]).toContain('Subagents it started stopped with it. Shell commands it started may have stopped.');
  },
  R86: (runner, status) => async () => {
      const messages = native(runner);
      const id = await start(runner, 'cezar-done');
      const original = structuredClone(store.getRun(id)!.steps[0]!);
      const text = 'Saved human text.\nDo not change it.';
      store.addStep(id, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
      store.updateStep(id, 'continue-1', { status: status === RUN_STATUS.queued ? STEP_STATUS.pending : STEP_STATUS.running });
      setRunStatus(store, id, status, { currentStepId: status === RUN_STATUS.running ? 'continue-1' : undefined, finishedAt: undefined, error: undefined, continuationMessage: { id: 'continue-1', text, createdAt: new Date().toISOString(), origin: 'human' } });
      expect(original.sessionId).toBeTruthy();
      const before = messages().length;
      // Two cold recoveries before admission must keep the original body and one context.
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      await restart();
      await restart();
      const disk = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(disk.continuationMessage).toMatchObject({ text, resumeContext: { restarted: true } });
      held.mockRestore();
      await semaphore.release();
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.split('\n')[0]).toContain('process restarted while you were working');
      expect(prompt.match(/process restarted while you were working/g)).toHaveLength(1);
      expect(prompt).toContain(`\n${text}`);
  },
};

export function registerResumeDiagnosticsGroup(group: ResumeDiagnosticsFamily): void {
  describe('resume diagnostics through every native wire (hearsay-tools/cezarion#1380)', () => {
    useWorkerWaitFixture();
    afterEach(() => vi.unstubAllEnvs());
    for (const row of RESUME_DIAGNOSTICS_GROUPS[group]!) registerResumeDiagnosticsFamily(row.family, row.runner, RESUME_DIAGNOSTICS_CELLS, registerTest);
  });
}
