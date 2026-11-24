import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentRunSpec } from './agent-runner.ts';
import { driveSeam, waitFor, type SeamObservation } from './harness-parity-core.testkit.ts';
import { parityRunners } from './parity-classes.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';
import { runnerDefinition } from './runner-registry.ts';
import type { NativeRecording } from '../workflows/native-session-wire.testkit.ts';
import { nativeRecording, sessionWire } from '../workflows/runner-session-wires.testkit.ts';

const TOKEN = 'TRIGGER-FIXTURE';
const ARGS = 'native arguments';
const CONTEXT = 'opening context sentinel';
const CONTINUE = 'Continue with the revised task.';
export const SKILL_TRIGGER_ROWS = ['first', 'context', 'later', 'resume', 'fallback-fresh', 'fallback-resume', 'fallback-bootstrap', 'unknown', 'position', 'plain'] as const;

const SKILL = 'probe-project';

/** The runner's native trigger of the probe skill carries `args`, with `context` beside it. */
function assertTriggerWire(runner: string, recording: NativeRecording, context = '', args = ARGS): void {
  sessionWire(runner).expectSkillTrigger(recording, { name: SKILL, args, context });
}

/** Every native skill invocation the wire recorded, whatever skill it names: an extra skill sent
 *  beside the probe counts too. */
function triggerCount(runner: string, recording: NativeRecording): number {
  return sessionWire(runner).skillTriggers(recording).length;
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
    // Read from the registered definition: the per-runner file registers and seals its runner before calling this kit.
    const missingSession = runnerDefinition(runner).mock.missingSession;
    for (const row of SKILL_TRIGGER_ROWS.filter(row => row !== 'fallback-bootstrap' || missingSession)) it(row, async () => {
      const dir = mkdtempSync(join(tmpdir(), `skill-trigger-${runner}-`));
      const argsFile = join(dir, 'args.ndjson');
      const stdinFile = join(dir, 'stdin.ndjson');
      const wire = () => nativeRecording(argsFile, stdinFile);
      const skill = { id: row === 'unknown' ? 'probe-missing' : SKILL, path: join(dir, 'SKILL.md'), args: ARGS };
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
          expect(JSON.stringify(wire())).not.toContain(SKILL);
          expect(JSON.stringify(wire())).not.toContain(CONTEXT);
          expect(sessionWire(runner).prompts(wire())).toContain('/compact');
          expect(resumed.v1.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: first.result.sessionId, resumed: true }]);
          return;
        }
        if (row === 'fallback-bootstrap') {
          // Native resume can create a new id: absent pi/OpenCode session, or moved omp session (`mock.missingSession`).
          const requestedSession = missingSession!.session === 'unknown-id' ? 'ses_missing_skill' : join(dir, 'empty-session.jsonl');
          const obs = await driveSeam(runner, 'baseline', { spec: { ...base, resume: true, sessionId: requestedSession,
            userPrompt: '/compact', resumeFallbackSkill: { ...skill, args: CONTEXT },
            env: { ...base.env, ...missingSession!.env } } });
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
          expect(sessionWire(runner).prompts(wire())).toContain(prompt);
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
