import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runsOn } from './parity-classes.testkit.ts';
import { FINAL_MESSAGE_CRITERIA } from './harness-parity.testkit.ts';
import { workflowFinalMessageCellNames, WORKFLOW_FINAL_MESSAGE_GROUPS } from './workflow-final-message-rows.testkit.ts';

describe('workflow final-message family registration', () => {
  it('registers every runner and row variant exactly once', () => {
    const groups = Object.keys(WORKFLOW_FINAL_MESSAGE_GROUPS) as Array<keyof typeof WORKFLOW_FINAL_MESSAGE_GROUPS>;
    const rows = groups.flatMap(group => [...WORKFLOW_FINAL_MESSAGE_GROUPS[group]]);
    expect([...rows].sort()).toEqual(FINAL_MESSAGE_CRITERIA.map(row => row.id).sort());
    const names: string[] = [];
    const registration = {
      describe: ((_name: string, body: () => void) => body()) as typeof describe,
      it: ((name: string) => { names.push(name); }) as typeof it,
    };
    const expectedFiles = groups.map(group => `workflow-final-message-${group}-parity.test.ts`);
    const actualFiles = readdirSync(new URL('.', import.meta.url)).filter(file =>
      file !== 'workflow-final-message-parity.test.ts' && file.startsWith('workflow-final-message-') && file.endsWith('-parity.test.ts') && file !== 'workflow-final-message-silent-tail-parity.test.ts');
    expect(actualFiles.sort()).toEqual(expectedFiles.sort());
    for (const group of groups) {
      const source = readFileSync(new URL(`./workflow-final-message-${group}-parity.test.ts`, import.meta.url), 'utf8');
      expect(source).toContain(`describeWorkflowFinalMessage('${group}');`);
      expect(source.match(/describeWorkflowFinalMessage\(/g)).toHaveLength(1);
      workflowFinalMessageCellNames(group, registration);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const runner of BUILT_IN_RUNNER_IDS) for (const row of FINAL_MESSAGE_CRITERIA) {
      if (!runsOn('workflow-final-message', row.id, runner)) { expect(names.filter(name => name.startsWith(`${runner} ${row.id} `))).toEqual([]); continue; }
      expect(names.filter(name => name.startsWith(`${runner} ${row.id} `))).toHaveLength(1);
    }
  });
});
