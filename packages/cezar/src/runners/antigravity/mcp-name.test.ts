import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { squawkToolDefinitions } from '../../ci-wait/tool-catalog.ts';
import type { AgentEvent } from '../../core/agent-runner.ts';
import { antigravityRunner } from './definition.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { ANTIGRAVITY_MCP_NAME } from './mcp-name.ts';
import { antigravityTool } from './tool-normalization.ts';

sealTestRunners(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const tools = squawkToolDefinitions({ HSQ_PREVIEW: '1', HSQ_AUTOMATIONS: '1' });

it('keeps every fully qualified Squawk tool name within the native 64-character limit', () => {
  const qualified = tools.map(tool => `mcp_${ANTIGRAVITY_MCP_NAME}_${tool.name}`);
  expect(Math.max(...qualified.map(name => name.length))).toBeLessThanOrEqual(64);
  for (const name of qualified) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(antigravityTool({ title: `mcp_${ANTIGRAVITY_MCP_NAME}_cezar_ask`, _meta: { mcp: { server: ANTIGRAVITY_MCP_NAME, tool: 'cezar_ask' } } }))
    .toMatchObject({ name: 'cezar_ask', title: 'cezar_ask' });
});

it('runs two turns with the real cockpit descriptor name and the full Squawk tool list', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agy-mcp-name-')); dirs.push(cwd);
  const server = join(cwd, 'mcp.mjs');
  await writeFile(server, `import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(tools)};
createInterface({ input: process.stdin }).on('line', line => {
 const frame = JSON.parse(line); if (frame.id === undefined) return;
 console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { tools } }));
});`);
  let turns = 0; let first!: (value: boolean) => void; let second!: (value: boolean) => void;
  const firstReady = new Promise<boolean>(resolve => { first = resolve; });
  const secondReady = new Promise<boolean>(resolve => { second = resolve; });
  const events: AgentEvent[] = [];
  const descriptor = { name: `cezar_ci_${'a'.repeat(32)}`, command: process.execPath, args: [server] };
  const session = new AntigravityRunner({ bin: join(import.meta.dirname, '../../../scripts/mock-acp.mjs') }).startSession({
    cwd, userPrompt: 'mock:acp-mcp-name-limit', toolGrant: { kind: 'explicit', tools: [] },
    squawkTools: descriptor, env: { HSQ_PREVIEW: '1', HSQ_AUTOMATIONS: '1' },
  }, event => { events.push(event); if (event.type === 'turn-end') turns++; }, {
    onAgentInputReady: () => { if (turns === 1) first(true); if (turns === 2) second(true); },
  });
  const ended = session.result.then(() => false, () => false);
  try {
    await expect(Promise.race([firstReady, ended])).resolves.toBe(true);
    expect(session.sendMessage([{ type: 'text', text: 'mock:acp-mcp-name-limit' }])).toBe(true);
    await expect(Promise.race([secondReady, ended])).resolves.toBe(true);
    expect(events.filter(event => event.type === 'text').map(event => event.text)).toEqual(['FIRST_OK', 'SECOND_OK']);
    expect(events.filter(event => event.type === 'tool-call').every(event => event.tool === 'cezar_ask')).toBe(true);
    expect(descriptor.name).toBe(`cezar_ci_${'a'.repeat(32)}`);
  } finally { session.end(); await session.result.catch(() => {}); }
});
