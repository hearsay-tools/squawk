import './tools.testkit.ts';
import '../built-in-wait-kinds.testkit.ts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerBuiltInCliCommands, sealBuiltInCliCommands } from '../built-in-cli-commands.ts';
import { waitToolDefinition } from './tools.ts';

type Schema = { properties: Record<string, { description?: string }> };
const fields = () => (waitToolDefinition.inputSchema as Schema).properties;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// `cezar_wait` names `hsq job` only while that command can run (spec
// 2026-11-26-launch-slot-and-bundled-jobs § 7). This file seals the CLI without the jobs feature.
describe('cezar_wait without the jobs feature', () => {
  it('names hsq job while the CLI table is unsealed, as a contract test or a tool server sees it', () => {
    expect(waitToolDefinition.description).toContain('`hsq job start <name> -- <command> [args...]`');
    expect(fields().exit_file!.description).toContain('`hsq job start`');
    expect(fields().pid!.description).toContain('the job start command printed');
    // The text the default install sends, byte for byte.
    expect(digest(waitToolDefinition.description)).toBe('014728f9839ed6afd2787d94f48eb8cf24fb90c23cdfd56e7296c283acb606e7');
  });

  it('names no job command once the sealed CLI has no job command', () => {
    registerBuiltInCliCommands();
    sealBuiltInCliCommands();
    const description = waitToolDefinition.description;
    expect(description).not.toMatch(/hsq job|Long commands|job start/);
    expect(description).toContain('kind "process" wakes you when a background command ends. Pass its `pid`, and as `exit_file` a file that the command writes its exit code to');
    expect(description).toContain('For a command that is already running, or that writes its own status file somewhere else, pass only its `pid` and leave `exit_file` out.');
    expect(fields().pid!.description).toBe('kind "process": the PID of the background command.');
    expect(fields().exit_file!.description).toBe('kind "process": optional. A file that your own wrapper writes the exit code to, in $TMPDIR or the worktree, with a new name for each command. Leave it out for a command that is already running or that writes its status file somewhere else.');
  });
});
