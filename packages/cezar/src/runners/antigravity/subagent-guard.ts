import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../core/shell-env.ts';

/**
 * The native tools that start or drive native subagents. On the CLI 1.5.14 ACP wire a subagent's
 * permission requests never reach the client, so each command it runs times out after 60 s
 * (hearsay-tools/squawk#4098). Squawk workers replace them.
 */
export const ANTIGRAVITY_SUBAGENT_TOOLS = ['invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message', 'run_workflow', 'swarm'] as const;
export const ANTIGRAVITY_SUBAGENT_DENIAL = 'Squawk turned off native subagents for Antigravity: their permission requests never reach Squawk. Do the work in this session, or start a Squawk worker if your instructions offer one.';
const SCRIPT = 'deny-native-subagents.mjs';
const GUARD_DIR = 'squawk-antigravity-guard';

/** The hooks.json content: a PreToolUse hook that denies the subagent tools by exact name. */
export function antigravityGuardHooks(nodePath: string, platform: NodeJS.Platform): string {
  // The CLI runs a hook through `sh -c` (Windows: `cmd /c`) in the folder that holds hooks.json.
  const node = platform === 'win32' ? `"${nodePath}"` : shellQuote(nodePath);
  const hook = { matcher: `^(${ANTIGRAVITY_SUBAGENT_TOOLS.join('|')})$`, hooks: [{ type: 'command', command: `${node} ${SCRIPT}`, timeout: 10 }] };
  return `${JSON.stringify({ 'squawk-no-native-subagents': { PreToolUse: [hook] } }, null, 2)}\n`;
}

/** The hook script: it reads the hook input, then prints the denial. */
export function antigravityGuardScript(): string {
  const decision = JSON.stringify({ decision: 'deny', reason: ANTIGRAVITY_SUBAGENT_DENIAL });
  return `process.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write(${JSON.stringify(decision)}));\n`;
}

/**
 * Writes the guard under the session's temp folder and returns the folder for `--add-dir`. The CLI
 * reads `.agents/hooks.json` from every workspace root, and an added root leaves the command cwd on
 * the task checkout (measured on CLI 1.5.14, docs/runners/antigravity-wire.md).
 */
export function writeAntigravitySubagentGuard(temp: string, nodePath = process.execPath, platform = process.platform): string {
  const root = join(temp, GUARD_DIR);
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'hooks.json'), antigravityGuardHooks(nodePath, platform));
  writeFileSync(join(agents, SCRIPT), antigravityGuardScript());
  return root;
}
