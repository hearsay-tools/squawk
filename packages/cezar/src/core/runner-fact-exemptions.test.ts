import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { exemptionFor, humanPromptReadReleases } from './harness-parity-core.testkit.ts';

// Swap the declarations of three runners, so the test proves the parity exemptions read the
// declared facts and not the runner ids (hearsay-tools/squawk#3642). The exemptions read the rows
// of `runner-fact-rows.testkit.ts`, so `factsWhere` reads the swapped rows.
vi.mock('./runner-fact-rows.testkit.ts', async (load) => {
  const actual = await load<typeof import('./runner-fact-rows.testkit.ts')>();
  const { RUNNER_IDS: ids } = await import('./agent-runner.ts');
  const rows = actual.factRows();
  const facts = {
    ...rows,
    codex: { ...rows.codex, hookEvents: 'none', childWork: 'none', transport: 'http', humanPromptHold: 'acknowledgement' },
    pi: { ...rows.pi, hookEvents: 'reported', childWork: 'nested', nativePermission: 'after-turn', humanPromptHold: 'consumption' },
    opencode: { ...rows.opencode, transport: 'stdio', nativePermission: 'none' },
  } as const;
  return { ...actual, factRows: () => facts, factsWhere: (matches: (row: typeof facts[keyof typeof facts]) => boolean) =>
    ids.filter(id => matches(facts[id])) };
});

const exempted = (criterion: string) => RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined);

describe('parity expectations follow the runner facts rows', () => {
  it('exempts R77 exactly where the wire carries no hook frame (hookEvents)', () => {
    expect(exempted('R77')).toEqual(['codex', 'opencode', 'omp']);
  });

  it.each(['S9', 'R12', 'R15'])('exempts %s exactly where the wire carries no child work (childWork)', criterion => {
    expect(exempted(criterion)).toEqual(['codex']);
  });

  it.each(['S25', 'F7'])('exempts %s exactly where the wire runs over stdio (transport)', criterion => {
    expect(exempted(criterion)).toEqual(['claude', 'opencode', 'pi', 'omp']);
  });

  it('exempts the native permission rows by the declared nativePermission', () => {
    const none = ['claude', 'opencode', 'omp'];
    for (const criterion of ['P1', 'P3', 'P4', 'P6']) expect(exempted(criterion), criterion).toEqual(none);
    // P2, P5 and P7 keep a named single-runner exemption for codex beside the declared ones.
    for (const criterion of ['P2', 'P5', 'P7']) expect(exempted(criterion), criterion).toEqual(['claude', 'codex', 'opencode', 'omp']);
    // Only a runner whose request can arrive after its turn ended runs P8.
    expect(exempted('P8')).toEqual(['claude', 'codex', 'opencode', 'omp']);
  });

  it('nudges before a held human acknowledgement exactly where the prompt read ends the hold (humanPromptHold)', () => {
    expect(humanPromptReadReleases()).toEqual(['pi']);
  });
});
