import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { RunnerId } from '../core/agent-runner.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createAutomationService, type AutomationServiceProject } from '../automations/service.ts';
import { createAutomationToolService } from '../automations/tool-adapter.ts';
import { AutomationStore } from '../automations/store.ts';
import type { GithubPoller } from '../automations/github-poller.ts';
import { describeWaitCells, nativeWire, waitOfKind, fireTimer } from './waits-parity-fixture.testkit.ts';
import { manager, root, store, until, restart } from './worker-wait-core.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

/** These cells use HARNESS_ADAPTERS through the wait fixture. Every tool call crosses the
 * runner's native mock wire and the real bundled MCP adapter or extension and controller. */
export function describeAutomationToolsParity(runner: RunnerId): void {
  describeWaitCells(() => {
    it(`${runner} A1 creates paused and previews on fresh, Continue and recovered sessions`, async () => {
      nativeWire(runner);
      const automationStore = AutomationStore.open(join(root, 'automations'));
      const project = (): AutomationServiceProject => ({ id: 'test', root, automationStore, store, manager });
      const service = createAutomationService({ home: testHome(), timeZone: () => 'UTC',
        scheduleHandle: () => ({ projectId: 'test', store: automationStore, timeZone: 'UTC' }),
        emitChange: () => {}, changed: () => {}, githubAvailability: async () => ({ available: true }), hasGithubRemote: async () => true,
      });
      const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const attach = () => manager.setAutomationTools(createAutomationToolService(service, project(), { timeZone: () => 'UTC',
        github: async () => ({ owner: 'owner', repo: 'repo', poller: { poll } as unknown as GithubPoller }),
      }));
      attach();
      const actions = toolCall('cezar_automation', { action: 'create', definition: { name: 'Poll', events: ['issue.opened'], intervalSeconds: 300, filters: {}, task: { prompt: 'Check' } } })
        + ' ' + toolCall('cezar_automation', { action: 'preview', id: 'last' });
      const complete = actions + ' ' + toolCall('cezar_done', {});
      // The recovered wake carries these commands in its timer note (the product's signal).
      expect(complete.length).toBeLessThanOrEqual(512);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: complete, runner });
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(poll).toHaveBeenCalledTimes(1);
      expect(automationStore.list()).toMatchObject([{ enabled: false }]);
      expect(manager.continueRun(run.id, { text: complete }).ok).toBe(true);
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(poll).toHaveBeenCalledTimes(2);
      expect(manager.continueRun(run.id, { text: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: complete }) }).ok).toBe(true);
      await until(() => store.getRun(run.id)?.status === 'waiting' && !!waitOfKind(run.id, 'timer'));
      const wait = waitOfKind(run.id, 'timer')!;
      await restart();
      attach();
      fireTimer(wait.id);
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(poll).toHaveBeenCalledTimes(3);
      expect(automationStore.list()).toHaveLength(3);
      expect(automationStore.list().every(definition => !definition.enabled)).toBe(true);
      expect(automationStore.receipts()).toEqual([]);
      const previews = automationStore.logs({ result: 'preview' });
      expect(previews).toHaveLength(3);
      expect(new Set(previews.map(log => log.automationId)).size).toBe(3);
    });
  });
}

