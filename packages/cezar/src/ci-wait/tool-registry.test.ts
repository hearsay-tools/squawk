import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentToolDefinition } from './tool-registry.ts';

function fixture(): AgentToolDefinition {
  return { name: 'fixture_echo', description: () => 'Echo fixture input', inputSchema: () => ({ type: 'object', properties: { text: { type: 'string' } } }),
    trigger: 'load to echo fixture input.', label: 'Fixture echo', schema: z.object({ text: z.string() }).strict(),
    invalid: () => ({ error: 'invalid fixture input' }), oversized: () => ({ error: 'fixture body too large' }),
    unavailable: () => ({ error: 'fixture unavailable' }), handle: async () => { throw new Error('Missing fixture capability'); },
    invoke: async input => ({ content: [{ type: 'text', text: JSON.stringify(input) }], details: input }), maxBodyBytes: 100,
  };
}
beforeEach(() => vi.resetModules());

describe('agent tool registry lifecycle', () => {
  it('fails closed before seal and names the boot call', async () => {
    const registry = await import('./tool-registry.ts');
    expect(registry.agentToolsSealed()).toBe(false);
    for (const read of [registry.registeredAgentTools, () => registry.agentTool('fixture_echo'), registry.agentToolNames]) {
      expect(read).toThrow(/Agent tool registry is unsealed.*registerBuiltInTools/);
    }
  });
  it('allows same-reference retries, refuses conflicts and new writes after seal', async () => {
    const registry = await import('./tool-registry.ts');
    const tool = fixture();
    registry.registerAgentTool(tool);
    registry.registerAgentTool(tool);
    expect(() => registry.registerAgentTool({ ...tool })).toThrow(/conflicting registration.*fixture_echo/);
    registry.sealAgentTools();
    registry.sealAgentTools();
    registry.registerAgentTool(tool);
    expect(registry.registeredAgentTools()).toEqual([tool]);
    expect(() => registry.registerAgentTool({ ...tool, name: 'late_tool' })).toThrow(/sealed/);
    expect(() => registry.registerAgentTool({ ...tool })).toThrow(/conflicting registration/);
  });
});
