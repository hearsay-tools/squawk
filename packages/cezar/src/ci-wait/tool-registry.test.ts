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

it('discovers and invokes a custom capability over authenticated IPC and MCP', async () => {
  const registry = await import('./tool-registry.ts');
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  sealBuiltInWaitKinds();
  const { registerBuiltInTools } = await import('../built-in-tools.ts');
  registerBuiltInTools();
  expect(registry.agentToolsSealed()).toBe(false);
  registry.registerAgentTool(fixture());
  registry.sealAgentTools();
  const { CiToolController } = await import('./controller.ts');
  const { fetchToolCatalog, invokeRemoteTool } = await import('./client.ts');
  const { createCiMcpServer } = await import('./mcp.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const owner = await CiToolController.start();
  const unused = async (): Promise<never> => { throw new Error('Unused core handler'); };
  const echo = vi.fn(async (input: unknown) => input);
  const session = owner.provision({ registerWait: unused, ask: unused, cancelWait: unused, finishTurn: unused, tools: { fixture_echo: echo } });
  const client = new Client({ name: 'registry-fixture', version: '1' });
  let server: Awaited<ReturnType<typeof createCiMcpServer>> | undefined;
  try {
    const catalog = await fetchToolCatalog(session.env);
    expect(catalog.tools.at(-1)).toMatchObject({ name: 'fixture_echo', label: 'Fixture echo', description: 'Echo fixture input' });
    expect(catalog.instructions).toContain('- fixture_echo: load to echo fixture input.');
    await expect(fetchToolCatalog({ ...session.env, HSQ_TOOL_TOKEN: 'wrong', CEZ_TOOL_TOKEN: 'wrong' })).rejects.toThrow(/catalog unavailable/);
    expect((await invokeRemoteTool('fixture_echo', { text: 'hello' }, session.env)).details).toEqual({ text: 'hello' });
    expect((await invokeRemoteTool('fixture_echo', { wrong: true }, session.env)).details).toEqual({ error: 'invalid fixture input' });
    expect((await invokeRemoteTool('fixture_echo', { text: 'x'.repeat(101) }, session.env)).details).toEqual({ error: 'fixture body too large' });
    expect(echo).toHaveBeenCalledTimes(1);
    server = await createCiMcpServer({ ...session.env, HSQ_PREVIEW: '0', HSQ_AUTOMATIONS: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(catalog.tools.map(tool => tool.name));
    expect(await client.callTool({ name: 'fixture_echo', arguments: { text: 'from MCP' } })).toMatchObject({ content: [{ text: '{"text":"from MCP"}' }] });
    session.revoke();
    await expect(fetchToolCatalog(session.env)).rejects.toThrow(/catalog unavailable/);
  } finally { await client.close(); await server?.close(); await owner.close(); }
});
