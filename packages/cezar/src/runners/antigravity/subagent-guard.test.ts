import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ANTIGRAVITY_SUBAGENT_DENIAL, ANTIGRAVITY_SUBAGENT_TOOLS, antigravityGuardHooks, writeAntigravitySubagentGuard } from './subagent-guard.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('denies exactly the native subagent tools, by whole name', () => {
  const hooks = JSON.parse(antigravityGuardHooks('/opt/node dir/bin/node', 'linux'));
  const [group] = hooks['squawk-no-native-subagents'].PreToolUse;
  const matcher = new RegExp(group.matcher);
  for (const tool of ANTIGRAVITY_SUBAGENT_TOOLS) expect(matcher.test(tool)).toBe(true);
  // An MCP tool or a native tool whose name only contains one of them runs.
  for (const tool of ['mcp_squawk_send_message', 'read_file', 'run_command', 'invoke_subagent_v2']) expect(matcher.test(tool)).toBe(false);
  expect(group.hooks).toEqual([{ type: 'command', command: '\'/opt/node dir/bin/node\' deny-native-subagents.mjs', timeout: 10 }]);
});

it('quotes the node path for cmd on Windows', () => {
  const hooks = JSON.parse(antigravityGuardHooks('C:\\Program Files\\nodejs\\node.exe', 'win32'));
  expect(hooks['squawk-no-native-subagents'].PreToolUse[0].hooks[0].command).toBe('"C:\\Program Files\\nodejs\\node.exe" deny-native-subagents.mjs');
});

it('writes the guard under the session temp folder, and its script answers the hook with the denial', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'antigravity-guard-')); dirs.push(temp);
  const root = writeAntigravitySubagentGuard(temp);
  expect(root).toBe(join(temp, 'squawk-antigravity-guard'));
  const agents = join(root, '.agents');
  expect(JSON.parse(await readFile(join(agents, 'hooks.json'), 'utf8'))).toEqual(JSON.parse(antigravityGuardHooks(process.execPath, process.platform)));
  const hook = spawnSync(process.execPath, ['deny-native-subagents.mjs'], { cwd: agents, input: JSON.stringify({ toolCall: { name: 'invoke_subagent' } }), encoding: 'utf8' });
  expect(hook.status).toBe(0);
  expect(JSON.parse(hook.stdout)).toEqual({ decision: 'deny', reason: ANTIGRAVITY_SUBAGENT_DENIAL });
});
