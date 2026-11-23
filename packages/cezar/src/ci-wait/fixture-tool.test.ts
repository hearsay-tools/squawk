import { unused } from '../workflows/unused.testkit.ts';
import type { ToolHost } from '../workflows/run/squawk-tools.ts';
import { expect, it, vi, beforeEach } from 'vitest';
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

it('discovers and invokes a custom capability over authenticated IPC and MCP', async () => {
  const registry = await import('./tool-registry.ts');
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  sealBuiltInWaitKinds();
  const { registerBuiltInTools } = await import('../built-in-tools.ts');
  registerBuiltInTools();
  expect(registry.agentToolsSealed()).toBe(false);
  const echo = vi.fn(async (input: unknown) => input);
  const second = vi.fn(async (input: unknown) => ({ second: input }));
  registry.registerAgentTool({ ...fixture(), sessionHandlers: () => ({ tools: { fixture_echo: echo } }) });
  registry.registerAgentTool({ ...fixture(), name: 'fixture_second', sessionHandlers: () => ({ tools: { fixture_second: second } }) });
  registry.sealAgentTools();
  const { CiToolController } = await import('./controller.ts');
  const { fetchToolCatalog, invokeRemoteTool } = await import('./client.ts');
  const { createCiMcpServer } = await import('./mcp.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const owner = await CiToolController.start();
  const { squawkToolHandlers } = await import('../workflows/run/squawk-tools.ts');
  const session = owner.provision(squawkToolHandlers('fixture-run', 'fixture-generation', unused<ToolHost>('core tool host')));
  const client = new Client({ name: 'registry-fixture', version: '1' });
  let server: Awaited<ReturnType<typeof createCiMcpServer>> | undefined;
  try {
    const catalog = await fetchToolCatalog(session.env);
    expect(catalog.tools.at(-2)).toMatchObject({ name: 'fixture_echo', label: 'Fixture echo', description: 'Echo fixture input' });
    expect(catalog.instructions).toContain('- fixture_echo: load to echo fixture input.');
    await expect(fetchToolCatalog({ ...session.env, HSQ_TOOL_TOKEN: 'wrong', CEZ_TOOL_TOKEN: 'wrong' })).rejects.toThrow(/catalog unavailable/);
    expect((await invokeRemoteTool('fixture_echo', { text: 'hello' }, session.env)).details).toEqual({ text: 'hello' });
    expect((await invokeRemoteTool('fixture_echo', { wrong: true }, session.env)).details).toEqual({ error: 'invalid fixture input' });
    expect((await invokeRemoteTool('fixture_echo', { text: 'x'.repeat(101) }, session.env)).details).toEqual({ error: 'fixture body too large' });
    expect(echo).toHaveBeenCalledTimes(1);
    expect((await invokeRemoteTool('fixture_second', { text: 'second' }, session.env)).details).toEqual({ second: { text: 'second' } });
    expect(second).toHaveBeenCalledTimes(1);
    server = await createCiMcpServer({ ...session.env, HSQ_PREVIEW: '0', HSQ_AUTOMATIONS: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(catalog.tools.map(tool => tool.name));
    expect(await client.callTool({ name: 'fixture_echo', arguments: { text: 'from MCP' } })).toMatchObject({ content: [{ text: '{"text":"from MCP"}' }] });
    expect(await client.callTool({ name: 'fixture_second', arguments: { text: 'second MCP' } })).toMatchObject({ content: [{ text: '{"second":{"text":"second MCP"}}' }] });
    session.revoke();
    await expect(fetchToolCatalog(session.env)).rejects.toThrow(/catalog unavailable/);
  } finally { await client.close(); await server?.close(); await owner.close(); }
});
