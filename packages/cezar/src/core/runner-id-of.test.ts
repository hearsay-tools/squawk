import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { runnerIdOf } from './runner-registry.ts';

describe('runnerIdOf', () => {
  it.each(RUNNER_IDS)('keeps the runner id %s', (id) => {
    expect(runnerIdOf(id)).toBe(id);
  });

  it('maps the legacy claude-cli id to claude', () => {
    expect(runnerIdOf('claude-cli')).toBe('claude');
  });

  it.each([undefined, 'unknown', 'constructor', 'toString'])('maps %s to claude, as createRunner does', (backend) => {
    expect(runnerIdOf(backend)).toBe('claude');
  });
});
