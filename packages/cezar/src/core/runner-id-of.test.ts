import { sealTestRunners } from './runner-registry.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { defineRunner } from './runner-definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { resolveRunnerId } from './runner-registry.ts';
import { describe, expect, it } from 'vitest';

sealTestRunners(claudeRunner, codexRunner, defineRunner({ ...codexRunner, id: 'custom-runner' }));

describe('resolveRunnerId', () => {
  it.each(['claude', 'codex'])('keeps the registered runner id %s', (id) => {
    expect(resolveRunnerId(id)).toBe(id);
  });

  it('maps the legacy claude-cli id to claude', () => {
    expect(resolveRunnerId('claude-cli')).toBe('claude');
  });

  it.each([undefined, 'unknown', 'constructor', 'toString'])('maps %s to claude, as createRunner does', (backend) => {
    expect(resolveRunnerId(backend)).toBe('claude');
  });

  it('resolves a registered id that is no built-in to itself (C3, B1)', () => {
    expect(resolveRunnerId('custom-runner')).toBe('custom-runner');
    expect(BUILT_IN_RUNNER_IDS).not.toContain('custom-runner');
  });
});
