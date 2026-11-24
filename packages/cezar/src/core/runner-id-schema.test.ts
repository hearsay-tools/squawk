import './register-all-runners.testkit.ts';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { registeredRunnerIdSchema, storedRunnerIdSchema } from './runner-id-schema.ts';
import { defineRunner } from './runner-definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';

// The closed decoder these schemas replaced (hearsay-tools/squawk#3936, item 5).
const closedEnum = () => z.enum(BUILT_IN_RUNNER_IDS as [string, ...string[]]);
const issues = (schema: z.ZodType, value: unknown) => schema.safeParse(value).error?.issues;

describe('registeredRunnerIdSchema', () => {
  it.each(['gemini', '', 5, null, 'claude-cli', ['claude'], 'claude', 'omp'])('decodes %j as the closed runner enum did', (value) => {
    const wrap = (id: z.ZodType) => z.object({ runner: id.default('claude') });
    expect(issues(wrap(registeredRunnerIdSchema()), { runner: value })).toEqual(issues(wrap(closedEnum()), { runner: value }));
    expect(registeredRunnerIdSchema().safeParse(value).data).toEqual(closedEnum().safeParse(value).data);
  });

  it('runs no later check on a refused id, as the enum did', () => {
    const later = (id: z.ZodType) => id.refine(() => false, { message: 'later check' });
    expect(issues(later(registeredRunnerIdSchema()), 'gemini')).toEqual(issues(later(closedEnum()), 'gemini'));
  });

  it('reads the completed registry at parse time, even when the schema predates boot', async () => {
    vi.resetModules();
    const { registeredRunnerIdSchema: schemaFactory } = await import('./runner-id-schema.ts');
    const { registerRunner, sealRunners } = await import('./runner-registry.ts');
    const schema = schemaFactory();
    expect(schema.safeParse('late-runner').success).toBe(false);
    registerRunner(defineRunner({ ...codexRunner, id: 'late-runner' }));
    sealRunners();
    expect(schema.safeParse('late-runner').data).toBe('late-runner');
  });
});

describe('storedRunnerIdSchema', () => {
  it.each(['ghost', 'p'.repeat(64), '  ghost  '])('keeps a trimmed non-empty id within 64 characters: %j', (value) => {
    const parsed = storedRunnerIdSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(value.trim());
  });

  it.each(['', '   ', 'p'.repeat(65), `gho${String.fromCharCode(10)}st`, `bad${String.fromCharCode(127)}id`, 5, null])('drops %j', (value) => {
    expect(storedRunnerIdSchema.safeParse(value).success).toBe(false);
  });
});
