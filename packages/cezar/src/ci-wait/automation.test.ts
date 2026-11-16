import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAutomation } from './client.ts';
import { CiToolController } from './controller.ts';
import type { AutomationToolAnswer, AutomationToolRequest } from '@open-mercato/cezar-contract/automation-tool';
import { GITHUB_COMMAND_TIMEOUT_MS } from '../automations/github-poller.ts';
import { automationToolDefinition, squawkToolNames } from './tool-catalog.ts';

const controllers: CiToolController[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const controller of controllers.splice(0)) await controller.close(); });
async function fixture() {
  const controller = await CiToolController.start(); controllers.push(controller);
  const automation = vi.fn(async (_request: AutomationToolRequest, _signal: AbortSignal): Promise<AutomationToolAnswer> => ({ ok: false, code: 'not_found', message: 'not found' }));
  const session = controller.provision({ automation,
    registerWait: async () => { throw new Error('not a wait test'); },
    ask: async () => ({ ok: false, code: 'unavailable', message: 'none' }),
    cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }),
    finishTurn: async () => ({ ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [] }),
  });
  return { session, automation };
}
describe('automation session capability', () => {
  it('advertises one flat object and excludes enable flags from creation', () => {
    const schema = automationToolDefinition.inputSchema;
    expect(schema).toMatchObject({ type: 'object', required: ['action'], additionalProperties: false,
      properties: { action: { enum: ['create', 'show', 'preview', 'enable'] }, explicit: { type: 'boolean' } },
    });
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(schema).not.toHaveProperty(key);
    const properties = (schema.properties as Record<string, unknown>).definition as { properties: Record<string, unknown> };
    expect(properties.properties).not.toHaveProperty('enable');
    expect(properties.properties).not.toHaveProperty('enabled');
  });
  it('passes validated arguments and the same lifetime signal on each call', async () => {
    const { session, automation } = await fixture();
    for (const action of ['show', 'preview'] as const) expect(await callAutomation({ action, id: 'poll' }, session.env)).toMatchObject({ code: 'not_found' });
    expect(automation.mock.calls).toHaveLength(2);
    expect(automation.mock.calls[0]).toEqual([{ action: 'show', id: 'poll' }, expect.any(AbortSignal)]);
    expect(automation.mock.calls[0]?.[1]).toBe(automation.mock.calls[1]?.[1]);
  });
  it('refuses malformed calls and calls after revocation', async () => {
    const { session, automation } = await fixture();
    expect(await callAutomation({ action: 'enable', id: 'poll', unexpected: true }, session.env)).toMatchObject({ code: 'invalid_request' });
    session.revoke();
    expect(await callAutomation({ action: 'show', id: 'poll' }, session.env)).toMatchObject({ code: 'unavailable' });
    expect(automation).not.toHaveBeenCalled();
  });
  it('returns a preview that spends a full GitHub command budget, beyond the old 15 second timeout', async () => {
    const { session, automation } = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = Promise.withResolvers<void>();
    automation.mockImplementationOnce(async () => {
      started.resolve();
      await new Promise(resolve => setTimeout(resolve, GITHUB_COMMAND_TIMEOUT_MS));
      return { ok: true, automation: { id: 'poll', revision: 1, name: 'Issues', enabled: false, kind: 'github', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' }, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z' }, preview: { matches: 2, truncated: false } };
    });
    const answer = callAutomation({ action: 'preview', id: 'poll' }, session.env);
    await started.promise;
    await vi.advanceTimersByTimeAsync(GITHUB_COMMAND_TIMEOUT_MS);
    expect(await answer).toMatchObject({ ok: true, preview: { matches: 2, truncated: false } });
  });
  it('omits the tool and refuses calls before validation with HSQ_AUTOMATIONS=0', async () => {
    vi.stubEnv('HSQ_AUTOMATIONS', '0');
    expect(squawkToolNames()).not.toContain('cezar_automation');
    const { session, automation } = await fixture();
    expect(await callAutomation(null, session.env)).toMatchObject({ code: 'automations_off' });
    expect(automation).not.toHaveBeenCalled();
  });
});
