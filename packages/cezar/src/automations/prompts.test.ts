import '../core/register-all-runners.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from '../core/built-in-runner-ids.testkit.ts';
import { describe, expect, it } from 'vitest';
import { createAutomationInputSchema } from '@open-mercato/cezar-contract/automations';
import { SCHEDULE_HOURS_OPTIONS, SCHEDULE_TYPES } from '@open-mercato/cezar-contract/automation-schedule';
import { GITHUB_PLACEHOLDERS, SCHEDULE_PLACEHOLDERS } from './task-template.ts';
import { automationDefinitionObjectSchema, automationDefinitionSchema, automationEventSchema, automationFiltersSchema, automationTaskSchema } from './types.ts';
import {
  automationSchemaReference,
  automationCliCommand,
  automationsPrompt,
} from './prompts.ts';

/** The storage schema supplies documented keys; retired read-only fields are excluded below. */
const objectKeys = (schema: unknown): string[] => {
  let current = schema as { shape?: Record<string, unknown>; _def?: { schema?: unknown; innerType?: unknown } };
  while (!current.shape && current._def) current = (current._def.schema ?? current._def.innerType) as typeof current;
  return Object.keys(current.shape ?? {});
};

// `archived` is written by the server when a one-time schedule's task exists or it is cancelled.
const SERVER_OWNED = new Set(['id', 'revision', 'enabled', 'createdAt', 'updatedAt', 'archived']);

describe('automationSchemaReference()', () => {
  it('names every definition key a caller may send', () => {
    const keys = objectKeys(automationDefinitionObjectSchema).filter((key) => !SERVER_OWNED.has(key));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(automationSchemaReference(), key).toContain(`"${key}"`);
  });

  it('names every task and filter key, event, schedule type and runner', () => {
    for (const key of objectKeys(automationTaskSchema).filter((key) => key !== 'variants')) expect(automationSchemaReference(), key).toContain(`"${key}"`);
    for (const key of objectKeys(automationFiltersSchema)) expect(automationSchemaReference(), key).toContain(`"${key}"`);
    for (const event of automationEventSchema.options) expect(automationSchemaReference()).toContain(event);
    for (const type of SCHEDULE_TYPES) expect(automationSchemaReference()).toContain(`"${type}"`);
    for (const every of SCHEDULE_HOURS_OPTIONS) expect(automationSchemaReference()).toContain(String(every));
    for (const runner of BUILT_IN_RUNNER_IDS) expect(automationSchemaReference()).toContain(runner);
  });

  it('states the storage bounds', () => {
    for (const bound of ['60-86400', '1-90', '1-100', '1-200', '1-4']) expect(automationSchemaReference()).toContain(bound);
  });

  it('states the opt-in completion behavior and its scope', () => {
    expect(automationSchemaReference()).toContain('"archiveWhenDone": boolean (default false)');
    expect(automationSchemaReference()).toContain('"autoMergePr": boolean (default false)');
    expect(automationSchemaReference()).toContain('current-head CI and GitHub rules pass');
    expect(automationSchemaReference()).toContain('may mark a draft ready');
    expect(automationSchemaReference()).toContain('merge before archive');
    expect(automationSchemaReference()).toContain('editing the automation does not change tasks it already launched');
  });

  it('lists exactly the placeholders the template renderer accepts', () => {
    const named = new Set([...automationSchemaReference().matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!));
    named.delete('task'); // the workflow step token in the inline-steps example, not an automation placeholder
    expect([...named].sort()).toEqual([...GITHUB_PLACEHOLDERS, ...SCHEDULE_PLACEHOLDERS].sort());
  });

  // Review of #1018: agents copy these examples into `--json`/`--file`, so each must be a valid
  // definition as written, with no comments inside it.
  it('prints examples that parse as JSON and that the create route accepts', () => {
    const blocks = [...automationSchemaReference().matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => match[0]);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      const parsed = JSON.parse(block) as unknown;
      const created = createAutomationInputSchema.safeParse(parsed);
      expect(created.success, JSON.stringify(created.error?.issues)).toBe(true);
    }
  });

  // hearsay-tools/cezarion#1465.
  it('the schema reference\'s once example parses with the storage schema', () => {
    const blocks = [...automationSchemaReference().matchAll(/^\{\n[\s\S]*?^\}$/gm)].map((match) => JSON.parse(match[0]) as { schedule?: { type: string } });
    const once = blocks.find((block) => block.schedule?.type === 'once');
    expect(once).toMatchObject({ kind: 'schedule', schedule: { type: 'once', at: expect.any(String), timeZone: expect.any(String) } });
    expect(automationDefinitionSchema.safeParse({ ...once, id: 'x', revision: 1, enabled: false, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' }).success).toBe(true);
    for (const words of ['archived', 'Run now', 'cancel']) expect(automationSchemaReference()).toContain(words);
  });
});

describe('automationsPrompt', () => {
  const command = "'/usr/bin/node' '/opt/cezar/dist/index.js' automation";

  it('addresses the CLI by the command it is given, never a bare cez on PATH', () => {
    for (const text of [automationsPrompt(command)]) {
      expect(text).toContain(command);
      const withoutCommand = text.replaceAll(command, '<CLI>');
      expect(withoutCommand).not.toMatch(/(^|[\s`"'(])(cez|cezar|cezarion) automation /m);
    }
  });

  it('uses the repeating tool and requires explicit consent and a preview in this session', () => {
    const prompt = automationsPrompt(command);
    for (const text of ['Use cezar_automation', 'explicit: true', 'in this session first', 'always PAUSED', 'without launching tasks or advancing its execution cursor', '"url" the tool returns', 'exact prompt template']) expect(prompt).toContain(text);
    expect(prompt).not.toContain(`${command} create`);
    expect(prompt).not.toContain(`${command} enable`);
    expect(prompt).not.toContain(automationSchemaReference());
    expect(prompt).toContain('update replaces each key given; "task" merges key by key, null removes one');
    for (const operation of ['schema', 'list | show <id>', 'update <id> --file <def.json>', 'pause <id> | delete <id>', 'run <id>', 'check <id> --execute']) expect(prompt).toContain(`${command} ${operation}`);
  });

  it('never tells an agent to start a cockpit', () => {
    for (const text of [automationsPrompt(command), automationSchemaReference()]) {
      expect(text).not.toMatch(/start (the|a) cockpit|run `?cez`?\b|\bcez serve\b/i);
    }
  });

  it('steers work that starts much later to a one-time schedule, enabled only when the user asked', () => {
    expect(automationsPrompt(command)).toContain('use cezar_schedule_task (at in UTC or delay) instead of keeping this session waiting on repeated timers; enable it only when the user asked for the work to run later.');
    expect(automationsPrompt(command)).toContain('Use cezar_scheduled_tasks to list, show, update, pause, enable or cancel a one-time schedule.');
  });

  it('tells the agent to stop and report when the CLI is refused, not to substitute a cron job', () => {
    expect(automationsPrompt(command)).toMatch(/stop and report that automations are unavailable/);
    expect(automationsPrompt(command)).toMatch(/cron job/);
  });

  it('keeps the automation paused under an autonomy nudge: only the user\'s request enables it', () => {
    for (const text of [automationsPrompt(command)]) {
      expect(text).toContain('A paused automation is the finished state of this task');
      expect(text).toMatch(/continue autonomously, not to ask for confirmation, or to make reasonable assumptions is not that request/);
    }
  });

  it('does not infer completion consent from autonomy or enabling an automation', () => {
    expect(automationsPrompt(command)).toContain('Use task.archiveWhenDone only when the user asks');
    for (const text of [automationsPrompt(command)]) {
      expect(text).toMatch(/only when the user asks|unless the user asks/);
      expect(text).toContain('current-head CI and GitHub rules');
      expect(text).toContain('future tasks only');
    }
  });

  it('builds the CLI command from this process, quoted for a POSIX shell', () => {
    const cli = automationCliCommand();
    expect(cli.startsWith(`'${process.execPath}'`)).toBe(true);
    expect(cli.endsWith(' automation')).toBe(true);
  });
});
