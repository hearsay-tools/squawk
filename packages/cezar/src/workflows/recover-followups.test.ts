import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { recoveryOver } from './run-recovery-fakes.testkit.ts';

/** Legacy true/false/absent fields never prevent queue recovery, even without a live session. */
describe('recover() reads legacy generated-inbox records — hearsay-tools/cezarion#1543', () => {
  let root: string;
  let dataDir: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    dataDir = join(root, '.ai/cezar');
    store = RunStore.open(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A run left `queued` by a crash. `workflowDef` is persisted by a follow-up updateRun, the
   *  way startRun does it — recover() revives the workflow from it. */
  const queuedRun = (generateFollowups: boolean | undefined): string => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, generateFollowups });
    store.flush();
    return id;
  };

  it.each([true, false, undefined])('recovers the legacy %s preference', async (preference) => {
    const id = queuedRun(preference);
    // The restart reads the saved row; recovery hands the queued run to the line unchanged.
    store.close();
    store = RunStore.open(dataDir, { keepLive: true });
    const { recovery, host } = recoveryOver(store);

    await recovery.recover();

    expect(host.reviveQueuedRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), 'cezar restarted');
    expect(vi.mocked(host.reviveQueuedRun).mock.calls[0]![0].generateFollowups).toBe(preference);
    expect(store.getRun(id)?.generateFollowups).toBe(preference);
    expect(store.getRun(id)?.status).toBe('queued');
  });
});
