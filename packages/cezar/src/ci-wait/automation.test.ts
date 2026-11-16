import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAutomation } from './client.ts';
import { CiToolController } from './controller.ts';
import type { AutomationToolRequest } from '@open-mercato/cezar-contract/automation-tool';
import { automationToolDefinition, squawkToolNames } from './tool-catalog.ts';

const controllers: CiToolController[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const controller of controllers.splice(0)) await controller.close(); });
async function fixture() {
  const controller = await CiToolController.start(); controllers.push(controller);
  const automation = vi.fn(async (_request: AutomationToolRequest, _signal: AbortSignal) => ({ ok: false as const, code: 'not_found' as const, message: 'not found' }));
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
  it('omits the tool and refuses calls before validation with HSQ_AUTOMATIONS=0', async () => {
    vi.stubEnv('HSQ_AUTOMATIONS', '0');
    expect(squawkToolNames()).not.toContain('cezar_automation');
    const { session, automation } = await fixture();
    expect(await callAutomation(null, session.env)).toMatchObject({ code: 'automations_off' });
    expect(automation).not.toHaveBeenCalled();
  });
});
