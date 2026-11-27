import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import type { RunnerDefinition, RunnerMock } from './runner-definition.ts';
import type { RunnerFacts } from './runner-facts.ts';
import { registerRunner } from './runner-registry.ts';
import { sealTestRunners } from './runner-registry.testkit.ts';
import { bypassAllowlistRunners } from './ci-tools.testkit.ts';
import { resumeSessionIdFor } from './harness-parity-core.testkit.ts';
import { exemptionFor } from './parity-exemptions.testkit.ts';
import { describeHarnessGroups, type CellBody, type HarnessGroup, type HarnessPartScope, type ObservedCell } from './harness-parity-registrar.testkit.ts';
import { ownedInputGroups } from './harness-parity-owned-input.rows.testkit.ts';
import { runGroups } from './harness-parity-run.rows.testkit.ts';
import { SESSION_GROUPS } from './harness-parity-session.cells.testkit.ts';
import { FOREIGN_EXTRA_TOOLS, TOOL_GRANT_CASES } from './tool-grant-parity-cells.testkit.ts';
import { sessionWire } from '../workflows/runner-session-wires.testkit.ts';
import { DEFAULT_ALLOWED_TOOLS } from '../workflows/types.ts';

function syntheticRunner(
  id: string,
  overrides: { facts?: Partial<RunnerFacts>; mock?: Partial<RunnerMock>; extraTools?: readonly string[] } = {},
): RunnerDefinition {
  return {
    ...fixtureRunner,
    id,
    facts: { ...fixtureRunner.facts, ...overrides.facts },
    mock: { ...fixtureRunner.mock, ...overrides.mock },
    extraTools: overrides.extraTools ?? fixtureRunner.extraTools,
  };
}

const HTTP_RUNNER = syntheticRunner('synth-http', {
  facts: { transport: 'http' },
  mock: { sessionStore: { env: 'SYNTH_SESSIONS', argsFileSuffix: '.synth-sessions.json' }, resumeSessionId: 'synth_thread_9' },
  extraTools: [],
});

const STDIO_BYPASS_RUNNER = syntheticRunner('synth-bypass', {
  facts: { transport: 'stdio' },
  mock: { defaultToolsBypassAllowlist: true },
  extraTools: ['CustomExtra'],
});

registerRunner(HTTP_RUNNER);
registerRunner(STDIO_BYPASS_RUNNER);
sealTestRunners();

const COLLECTED: CellBody & ObservedCell<never> = Object.assign(
  async () => { throw new Error('collected only'); },
  {
    assert: () => { throw new Error('collected only'); },
    observe: async () => { throw new Error('collected only'); },
  },
);
const collectedCells = <Cells extends object>(): Cells => new Proxy({}, { get: () => () => COLLECTED }) as Cells;

function collectCellTitles(scope: HarnessPartScope, groups: readonly HarnessGroup[]): string[] {
  const titles: string[] = [];
  describeHarnessGroups(scope, {
    describe: ((_name: string, ...args: unknown[]) => { (args.at(-1) as () => void)(); }) as typeof describe,
    it: ((title: string) => { titles.push(title); }) as unknown as typeof it,
    beforeAll: (() => undefined) as typeof beforeAll,
    afterAll: (() => undefined) as typeof afterAll,
    toolGrants: () => undefined,
    allGroups: true,
    probe: true,
  }, groups);
  return titles;
}

describe('parity cell selection follows declared facts and runner data (hearsay-tools/squawk#3998)', () => {
  it('selects durable-input owned-input cells by facts.transport === http, not runner id', () => {
    const groups = Object.values(ownedInputGroups(collectedCells()));
    const httpTitles = collectCellTitles({ runner: HTTP_RUNNER, part: 'owned-input' }, groups);
    const stdioTitles = collectCellTitles({ runner: STDIO_BYPASS_RUNNER, part: 'owned-input' }, groups);
    expect(httpTitles.filter(title => title.includes('opening answer never checkpoints'))).toHaveLength(3);
    expect(httpTitles.filter(title => title.includes('late reply acknowledgement plus DONE'))).toHaveLength(2);
    expect(httpTitles.filter(title => title.includes('rejected mid-session human POST'))).toHaveLength(1);
    expect(httpTitles.filter(title => title.includes('rejected agent POST fails'))).toHaveLength(2);
    expect(stdioTitles.filter(title => title.includes('POST') || title.includes('opening answer never checkpoints') || title.includes('late reply acknowledgement plus DONE'))).toEqual([]);
  });

  it('selects fatal server-diagnostic cells in run/diagnostics by facts.transport === http', () => {
    const groups = [runGroups(collectedCells()).diagnostics];
    const httpTitles = collectCellTitles({ runner: HTTP_RUNNER, part: 'run' }, groups);
    const stdioTitles = collectCellTitles({ runner: STDIO_BYPASS_RUNNER, part: 'run' }, groups);
    expect(httpTitles.filter(title => title.endsWith('remains fatal'))).toHaveLength(6);
    expect(stdioTitles.filter(title => title.endsWith('remains fatal'))).toEqual([]);
  });

  it('selects governed restricted-session cells by facts.transport === http and mock.sessionStore', () => {
    const groups = [SESSION_GROUPS.governed];
    const httpTitles = collectCellTitles({ runner: HTTP_RUNNER, part: 'session' }, groups);
    const stdioTitles = collectCellTitles({ runner: STDIO_BYPASS_RUNNER, part: 'session' }, groups);
    expect(httpTitles.filter(title => title.includes('governed Continue'))).toHaveLength(2);
    expect(stdioTitles.filter(title => title.includes('governed Continue'))).toEqual([]);
  });

  it('selects extra R35 default-tool-list cells by mock.defaultToolsBypassAllowlist', () => {
    const groups = [SESSION_GROUPS.tools];
    const bypassTitles = collectCellTitles({ runner: STDIO_BYPASS_RUNNER, part: 'session' }, groups);
    const plainTitles = collectCellTitles({ runner: HTTP_RUNNER, part: 'session' }, groups);
    expect(bypassTitles.filter(title => title.includes('on the default tool list'))).toHaveLength(3);
    expect(plainTitles.filter(title => title.includes('on the default tool list'))).toEqual([]);
  });

  it('selects TG3 inherited tools by runnerDefinition(backend).extraTools.length, not runner id', () => {
    const tg3 = TOOL_GRANT_CASES.find(entry => entry.id === 'inherited')!;
    expect(tg3.grant(HTTP_RUNNER.id)).toEqual({ kind: 'inherited', tools: [...DEFAULT_ALLOWED_TOOLS, ...FOREIGN_EXTRA_TOOLS] });
    expect(tg3.grant(STDIO_BYPASS_RUNNER.id)).toEqual({ kind: 'inherited', tools: [...DEFAULT_ALLOWED_TOOLS] });
  });

  it('selects U0 bypass-allowlist drives by mock.defaultToolsBypassAllowlist', () => {
    expect(bypassAllowlistRunners([HTTP_RUNNER.id, STDIO_BYPASS_RUNNER.id])).toEqual([STDIO_BYPASS_RUNNER.id]);
  });

  it('selects S14/S42/S44 resume session id by mock.resumeSessionId', () => {
    expect(resumeSessionIdFor(HTTP_RUNNER.id)).toBe('synth_thread_9');
    expect(resumeSessionIdFor(HTTP_RUNNER.id, 'pinned')).toBe('synth_thread_9');
    expect(resumeSessionIdFor(STDIO_BYPASS_RUNNER.id)).toBeUndefined();
    expect(resumeSessionIdFor(STDIO_BYPASS_RUNNER.id, 'pinned')).toBe('pinned');
  });

  it('resolves SessionWire readers for every built-in runner and matches expectGovernedWire to D1 non-exemptions', () => {
    for (const id of BUILT_IN_RUNNER_IDS) {
      const wire = sessionWire(id);
      expect(typeof wire.systemPrompts, `${id}.systemPrompts`).toBe('function');
      expect(typeof wire.expectCiWire, `${id}.expectCiWire`).toBe('function');
      expect(typeof wire.expectSquawkToolAdmission, `${id}.expectSquawkToolAdmission`).toBe('function');
      expect(typeof wire.started, `${id}.started`).toBe('function');
      expect(typeof wire.resumed, `${id}.resumed`).toBe('function');
      expect(typeof wire.freshSessions, `${id}.freshSessions`).toBe('function');
      expect(typeof wire.skillTriggers, `${id}.skillTriggers`).toBe('function');
    }
    const governedReaders = BUILT_IN_RUNNER_IDS.filter(id => sessionWire(id).expectGovernedWire !== undefined);
    const nonExemptD1 = BUILT_IN_RUNNER_IDS.filter(id => exemptionFor('D1', id) === undefined);
    expect(governedReaders).toEqual(nonExemptD1);
  });
});
