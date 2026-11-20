import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentRunSpec } from './agent-runner.ts';
import { driveSeam, waitFor, type SeamObservation } from './harness-parity-core.testkit.ts';
import { parityRunners } from './parity-classes.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';

const TOKEN = 'TRIGGER-FIXTURE';
const ARGS = 'native arguments';
const CONTEXT = 'opening context sentinel';
const CONTINUE = 'Continue with the revised task.';
export const SKILL_TRIGGER_ROWS = ['first', 'context', 'later', 'resume', 'fallback-fresh', 'fallback-resume', 'fallback-bootstrap', 'unknown', 'position', 'plain'] as const;

function assertTriggerWire(runner: string, wire: string, context = '', args = ARGS): void {
  const rows = wire.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (runner === 'claude') {
    const message = rows.find(row => row.blocks)?.blocks;
    expect(message.at(-1)).toEqual({ type: 'text', text: `/probe-project ${args}` });
    if (context) expect(message.slice(0, -1)).toContainEqual({ type: 'text', text: context });
  } else if (runner === 'codex') {
    const input = rows.find(row => row.method === 'turn/start' && row.params.input.some((item: { type: string }) => item.type === 'skill'))?.params.input;
    expect(input).toContainEqual(expect.objectContaining({ type: 'skill', name: 'probe-project', path: expect.stringContaining('SKILL.md') }));
    expect(input[0].text).toContain(args);
    if (context) expect(input[0].text).toContain(context);
  } else if (runner === 'opencode') {
    const command = rows.find(row => row.url?.endsWith('/command'))?.body;
    expect(command).toMatchObject({ command: 'probe-project', arguments: expect.stringContaining(args) });
    if (context) expect(command.arguments).toContain(context);
    expect(rows.some(row => row.url?.endsWith('/prompt_async'))).toBe(false);
  } else {
    const text = rows.find(row => row.userText?.startsWith('/skill:probe-project'))?.userText;
    expect(text).toBe(`/skill:probe-project ${args}${context ? `\n\n${context}` : ''}`);
  }
}

function triggerCount(runner: string, wire: string): number {
  const rows = wire.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (runner === 'claude') return rows.filter(row => row.blocks?.some((block: { text?: string }) => block.text?.startsWith('/probe-project'))).length;
  if (runner === 'codex') return rows.filter(row => row.method === 'turn/start' && row.params.input.some((item: { type: string }) => item.type === 'skill')).length;
  if (runner === 'opencode') return rows.filter(row => row.url?.endsWith('/command')).length;
  return rows.filter(row => row.userText?.startsWith('/skill:probe-project')).length;
}

function assertSuccess(obs: SeamObservation): void {
  expect(obs.failure).toBeUndefined();
  expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
  expect(obs.result.text).toContain(TOKEN);
  expect(obs.result.toolCalls).toEqual([]);
}

export function describeNativeSkillTriggers(runner: string): void {
  if (!parityRunners('runner-skill-trigger', 'native').includes(runner)) return;
  describe(`${runner}: native skill trigger`, () => {
    for (const row of SKILL_TRIGGER_ROWS.filter(row => row !== 'fallback-bootstrap' || runner === 'pi' || runner === 'omp' || runner === 'opencode')) it(row, async () => {
      const dir = mkdtempSync(join(tmpdir(), `skill-trigger-${runner}-`));
      const argsFile = join(dir, 'args.ndjson');
      const stdinFile = join(dir, 'stdin.ndjson');
      const wire = () => [argsFile, stdinFile].map(file => existsSync(file) ? readFileSync(file, 'utf8') : '').join('\n');
      const skill = { id: row === 'unknown' ? 'probe-missing' : 'probe-project', path: join(dir, 'SKILL.md'), args: ARGS };
      const base: Partial<AgentRunSpec> = { cwd: dir, userPrompt: '', env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile } };
      try {
        if (row === 'fallback-fresh') {
          const obs = await driveSeam(runner, 'baseline', { spec: { ...base, userPrompt: CONTINUE, resumeFallbackSkill: { ...skill, args: '' } } });
          assertSuccess(obs);
          assertTriggerWire(runner, wire(), '', CONTINUE);
          expect(triggerCount(runner, wire())).toBe(1);
          expect(obs.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: obs.result.sessionId, resumed: false }]);
          return;
        }
        if (row === 'fallback-resume') {
          const first = await driveSeam(runner, 'baseline', { spec: { ...base, skill } });
          assertSuccess(first);
          for (const file of [argsFile, stdinFile]) writeFileSync(file, '');
          const resumed = await driveSeam(runner, 'baseline', { spec: { ...base, userPrompt: '/compact', resumeFallbackSkill: { ...skill, args: CONTEXT }, sessionId: first.result.sessionId, resume: true } });
          expect(resumed.failure).toBeUndefined();
          expect(resumed.v1.filter(event => event.type === 'error')).toEqual([]);
          expect(resumed.result.text).not.toContain(TOKEN);
          expect(wire()).not.toContain('probe-project');
          expect(wire()).not.toContain(CONTEXT);
          const rows = wire().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          expect(rows.flatMap(row => [row.userText, row.params?.input?.[0]?.text, row.body?.parts?.[0]?.text])).toContain('/compact');
          expect(resumed.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: first.result.sessionId, resumed: true }]);
          return;
        }
        if (row === 'fallback-bootstrap') {
          // Native resume can create a new id: absent pi/OpenCode session, or moved omp session.
          const requestedSession = runner === 'opencode' ? 'ses_missing_skill' : join(dir, 'empty-session.jsonl');
          const obs = await driveSeam(runner, 'baseline', { spec: { ...base, resume: true, sessionId: requestedSession,
            userPrompt: '/compact', resumeFallbackSkill: { ...skill, args: CONTEXT },
            env: { ...base.env, CEZ_MOCK_OMP_RESUME_MOVED: '1' } } });
          assertSuccess(obs);
          expect(obs.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: obs.result.sessionId, resumed: false }]);
          expect(obs.result.sessionId).not.toBe(requestedSession);
          assertTriggerWire(runner, wire(), '', `${CONTEXT}\n\n/compact`);
          expect(triggerCount(runner, wire())).toBe(1);
          return;
        }
        if (row === 'plain') {
          const prompt = '  opening code\n\n  last line \n';
          const obs = await driveSeam(runner, 'baseline', { spec: { ...base, userPrompt: prompt } });
          expect(obs.failure).toBeUndefined();
          const rows = wire().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
          const texts = rows.flatMap(row => [
            row.userText,
            row.method === 'turn/start' ? row.params.input[0].text : undefined,
            row.url?.endsWith('/prompt_async') ? row.body.parts[0].text : undefined,
          ]);
          expect(texts).toContain(prompt);
          return;
        }
        if (row === 'later' || row === 'position') {
          const obs = await driveSeam(runner, 'baseline', {
            spec: { ...base, userPrompt: 'inspect the tree' },
            whileOpen: async (session, { v1 }) => {
              await waitFor(() => v1.some(event => event.type === 'turn-end'));
              if (row === 'position') {
                expect(session.sendMessage([{ type: 'text', text: 'context' }, { type: 'skill', ...skill }])).toBe(false);
                return;
              }
              expect(session.sendMessage([{ type: 'skill', ...skill }])).toBe(true);
              await waitFor(() => v1.filter(event => event.type === 'turn-end').length === 2);
              expect(session.holdsHumanInput()).toBe(false);
            },
          });
          if (row === 'later') expect(obs.result.text).toContain(TOKEN);
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          return;
        }
        if (row === 'resume') {
          const first = await driveSeam(runner, 'baseline', { spec: { ...base, skill } });
          assertSuccess(first);
          const resumed = await driveSeam(runner, 'baseline', { spec: { ...base, skill, sessionId: first.result.sessionId, resume: true } });
          assertSuccess(resumed);
          expect(resumed.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: first.result.sessionId, resumed: true }]);
          return;
        }
        const obs = await driveSeam(runner, 'baseline', { spec: { ...base, skill, userPrompt: row === 'context' ? CONTEXT : '' } });
        if (row === 'unknown') {
          expect(obs.v1.some(event => event.type === 'error')).toBe(RUNNER_FACTS[runner]!.skillUnknownName === 'error');
          expect(obs.v1.filter(event => event.type === 'turn-end')).toHaveLength(1);
          return;
        }
        assertSuccess(obs);
        expect(obs.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: obs.result.sessionId, resumed: false }]);
        assertTriggerWire(runner, wire(), row === 'context' ? CONTEXT : '');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 20_000); // bound: mock startup and at most two native turns, each awaited by its turn-end signal.
  });
}
