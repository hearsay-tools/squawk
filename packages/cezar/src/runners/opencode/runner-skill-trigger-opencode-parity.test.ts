import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { expect, it } from 'vitest';
import { driveSeam } from '../../core/harness-parity-core.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from '../../core/runner-skill-trigger.testkit.ts';
import { opencodeRunner } from './definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));
sealTestRunners();
describeNativeSkillTriggers('opencode');


it('reports a fresh session once when the requested native session is missing', async () => {
  const obs = await driveSeam('opencode', 'baseline', {
    spec: { resume: true, sessionId: 'ses_missing_skill', userPrompt: '', skill: { id: 'probe-project', args: 'fresh arguments' } },
  });
  expect(obs.v1.filter(event => event.type === 'session')).toEqual([
    { type: 'session', sessionId: obs.result.sessionId, resumed: false },
  ]);
  expect(obs.result.sessionId).not.toBe('ses_missing_skill');
  expect(obs.result.text).toContain('TRIGGER-FIXTURE');
});
