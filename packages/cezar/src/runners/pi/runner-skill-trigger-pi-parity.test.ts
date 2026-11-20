import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { driveSeam, waitFor } from '../../core/harness-parity-core.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from '../../core/runner-skill-trigger.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));
describeNativeSkillTriggers('pi');


it.each(['human', 'agent'] as const)('correlates a pi expanded mid-turn %s trigger before its reply', async origin => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-skill-consumption-'));
  const gate = join(dir, 'release');
  const stdin = join(dir, 'stdin.ndjson');
  const steerAdmitted = () => existsSync(stdin) && readFileSync(stdin, 'utf8').includes('"streamingBehavior":"steer"');
  const consumed: string[] = [];
  let live: AgentSession | undefined;
  let heldAtReply: boolean | undefined;
  let consumedAtReply: string[] = [];
  try {
    const obs = await driveSeam('pi', 'steer-tool', {
      spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_STEER_GATE: gate, CEZ_MOCK_STDIN_FILE: stdin } },
      sessionOptions: { onAgentInputConsumed: ids => consumed.push(...ids) },
      onEvent: entry => {
        if ('v1' in entry && entry.v1.type === 'text' && entry.v1.text.includes('TRIGGER-FIXTURE')) {
          heldAtReply = live?.holdsHumanInput();
          consumedAtReply = [...consumed];
        }
      },
      whileOpen: async (session, { v1 }) => {
        live = session;
        await waitFor(() => v1.some(event => event.type === 'tool-call'));
        const content = [{ type: 'skill' as const, id: 'probe-project', args: 'mid-turn </skill> arguments  ' }];
        if (origin === 'human') {
          expect(session.sendMessage(content)).toBe(true);
          expect(session.holdsHumanInput()).toBe(true);
        } else {
          const ack = session.sendAgentMessage(content, ['skill-input']);
          expect(ack).not.toBe(false);
          await ack;
        }
        // The mock admits the steer into the held turn before the gate lets that turn end.
        await waitFor(steerAdmitted);
        writeFileSync(gate, '');
        await waitFor(() => v1.some(event => event.type === 'turn-end'));
      },
    });
    expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
    expect(heldAtReply).toBe(false);
    expect(consumedAtReply).toEqual(origin === 'agent' ? ['skill-input'] : []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
