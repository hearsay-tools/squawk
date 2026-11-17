import { askRequestedRead, runSearchFields } from './lint/owner-reader-rules.ts';
import { expect, it } from 'vitest';
import { livenessTimer } from './lint/owner-process-rules.ts';
import { ownerExceptions } from './lint/owner-rule.testkit.ts';

ownerExceptions(livenessTimer);
it('scopes the liveness rule to production run modules outside the owners', () => {
  for (const file of ['run/probe.ts', 'run/nested/probe.ts', 'run.ts']) expect(livenessTimer.applies(`packages/cezar/src/workflows/${file}`)).toBe(true);
  for (const file of ['run/liveness-timers.ts', 'run/probe.test.ts', 'run/probe.testkit.ts', 'probe.ts']) expect(livenessTimer.applies(`packages/cezar/src/workflows/${file}`)).toBe(false);
});

it('retains the former TypeScript grammar scope for ask and search readers', () => {
  for (const rule of [askRequestedRead, runSearchFields]) {
    expect(rule.applies('packages/web/src/fixture.ts')).toBe(true);
    expect(rule.applies('packages/web/src/fixture.tsx')).toBe(false);
  }
});
