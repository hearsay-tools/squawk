import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from './agent-runner.ts';
import { driveSeam, waitFor } from './harness-parity-core.testkit.ts';
import { OmpRunner } from '../runners/omp/omp-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';
import { ompRunner } from '../runners/omp/definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));
describeNativeSkillTriggers('omp');

it('passes an omp mid-message skill token unchanged for native expansion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-mid-message-skill-'));
  const stdinFile = join(dir, 'stdin.ndjson');
  const prompt = 'Say hi, then run /skill:probe-project';
  try {
    const obs = await driveSeam('omp', 'baseline', {
      spec: { cwd: dir, userPrompt: prompt, env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_STDIN_FILE: stdinFile } },
    });
    expect(obs.failure).toBeUndefined();
    expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
    expect(obs.result.text).toContain('TRIGGER-FIXTURE');
    const input = readFileSync(stdinFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(input.filter(row => row.userText)).toEqual([{ userText: prompt, imageCount: 0 }]);
    expect(obs.v2.filter(event => event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'user'))
      .toMatchObject([{ item: { text: prompt } }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['human', 'agent'] as const)('correlates an omp expanded mid-turn %s trigger before its reply', async origin => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-skill-consumption-'));
  const gate = join(dir, 'release');
  const stdin = join(dir, 'stdin.ndjson');
  const steerAdmitted = () => existsSync(stdin) && readFileSync(stdin, 'utf8').includes('"streamingBehavior":"steer"');
  const consumed: string[] = [];
  let live: AgentSession | undefined;
  let heldAtReply: boolean | undefined;
  let consumedAtReply: string[] = [];
  try {
    const obs = await driveSeam('omp', 'steer-tool', {
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
    const expanded = obs.v2.filter(event => event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'user');
    expect(expanded).toMatchObject([{ item: { skillInput: { id: expect.any(String), source: origin } } }]);
    expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
    expect(heldAtReply).toBe(false);
    expect(consumedAtReply).toEqual(origin === 'agent' ? ['skill-input'] : []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('carries opening submission identity on the omp skill item', async () => {
  const obs = await driveSeam('omp', 'baseline', {
    spec: { userPrompt: 'Attachment: /tmp/fixture.pdf', skill: { id: 'probe-project', args: 'fixture arguments  ' } },
  });
  expect(obs.v2.filter(event => event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'user'))
    .toMatchObject([{ item: { skillInput: { id: expect.any(String), source: 'opening' } } }]);
});
