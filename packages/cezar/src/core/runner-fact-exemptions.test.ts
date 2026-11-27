import type { RunnerFacts } from './runner-facts.ts';
import type { RunnerMock } from './runner-definition.ts';
import { describe, expect, it, vi } from 'vitest';
import { exemptionFor, humanPromptReadReleases } from './parity-exemptions.testkit.ts';
import { factRows } from './runner-fact-rows.testkit.ts';
import { mockRows } from './runner-mock-rows.testkit.ts';
import { SESSION_STORE_RUNNERS } from './skill-resume-rows.testkit.ts';

// Swap the declarations of runners so the test proves parity exemptions and cell selections read
// the declared facts and mock data instead of runner ids (hearsay-tools/squawk#3642, hearsay-tools/squawk#3998).
vi.mock('./runner-fact-rows.testkit.ts', async (load) => {
  const actual = await load<typeof import('./runner-fact-rows.testkit.ts')>();
  const rows = actual.factRows();
  const facts = {
    ...rows,
    codex: { ...rows.codex, childWork: 'none', transport: 'http', humanPromptHold: 'acknowledgement', turnStart: 'on-write' },
    pi: { ...rows.pi, childWork: 'nested', nativePermission: 'after-turn', humanPromptHold: 'consumption', turnStart: 'on-wire' },
    opencode: { ...rows.opencode, transport: 'stdio', nativePermission: 'none' },
  } as const;
  const rowsById = facts as unknown as Record<string, (typeof facts)[keyof typeof facts]>;
  return { ...actual, factRows: () => facts, factsWhere: (matches: (row: (typeof facts)[keyof typeof facts]) => boolean) =>
    Object.keys(rowsById).filter(id => matches(rowsById[id]!)) };
});

vi.mock('./runner-mock-rows.testkit.ts', async (load) => {
  const actual = await load<typeof import('./runner-mock-rows.testkit.ts')>();
  const rows = actual.mockRows();
  const { implicitAutoResume: _ompAuto, ...ompWithoutAuto } = rows.omp!;
  const { sessionStore: opencodeStore, ...opencodeWithoutStore } = rows.opencode!;
  const mocks: Record<string, RunnerMock> = {
    ...rows,
    omp: ompWithoutAuto,
    pi: { ...rows.pi!, implicitAutoResume: true },
    opencode: opencodeWithoutStore,
    claude: { ...rows.claude!, sessionStore: opencodeStore! },
  };
  return { ...actual, mockRows: () => mocks };
});

const declared = factRows() as Readonly<Record<string, RunnerFacts>>;
const real = (await vi.importActual<typeof import('./runner-fact-rows.testkit.ts')>('./runner-fact-rows.testkit.ts')).factRows();
const declaredMocks = mockRows();
const realMocks = (await vi.importActual<typeof import('./runner-mock-rows.testkit.ts')>('./runner-mock-rows.testkit.ts')).mockRows();
const runners = Object.keys(declared);

const exempted = (criterion: string) => runners.filter(runner => exemptionFor(criterion, runner) !== undefined);

/** The runners whose swapped facts match. The swap must move one, or the check would not tell the
 *  declared facts from the runner ids. */
function where(matches: (facts: RunnerFacts) => boolean): string[] {
  const selected = runners.filter(id => matches(declared[id]!));
  expect(selected, 'the swapped facts select the same runners as the real ones').not.toEqual(runners.filter(id => matches(real[id]!)));
  return selected;
}

/** The runners whose swapped mock data match. The swap must move one. */
function whereMock(matches: (mock: RunnerMock) => boolean): string[] {
  const selected = runners.filter(id => matches(declaredMocks[id]!));
  expect(selected, 'the swapped mocks select the same runners as the real ones').not.toEqual(runners.filter(id => matches(realMocks[id]!)));
  return selected;
}

describe('parity expectations follow the runner facts rows', () => {
  it.each(['S9', 'R12', 'R15'])('exempts %s exactly where the wire carries no child work (childWork)', criterion => {
    expect(exempted(criterion)).toEqual(where(facts => facts.childWork === 'none'));
  });

  it.each(['S25', 'F7'])('exempts %s exactly where the wire runs over stdio (transport)', criterion => {
    expect(exempted(criterion)).toEqual(where(facts => facts.transport === 'stdio'));
  });

  it('exempts the native permission rows by the declared nativePermission', () => {
    const none = where(facts => facts.nativePermission === 'none');
    for (const criterion of ['P1', 'P4', 'P6']) expect(exempted(criterion), criterion).toEqual(none);
    // These rows also keep named wire gaps from the mock part, including ACP's lack of a
    // notification that settles a native permission without the client's response (P3).
    for (const criterion of ['P2', 'P3', 'P5', 'P7']) {
      const named = runners.filter(id => mockRows()[id]!.parityExemptions?.[criterion] !== undefined);
      expect(named, criterion).not.toEqual([]);
      expect(exempted(criterion), criterion).toEqual(runners.filter(id => none.includes(id) || named.includes(id)));
    }
    // Only a runner whose request can arrive after its turn ended runs P8.
    expect(exempted('P8')).toEqual(where(facts => facts.nativePermission === 'none' || facts.nativePermission === 'in-turn'));
  });

  it('nudges before a held human acknowledgement exactly where the prompt read ends the hold (humanPromptHold)', () => {
    expect(humanPromptReadReleases()).toEqual(where(facts => facts.humanPromptHold === 'consumption'));
  });

  it('exempts F11 exactly where the wire emits no native turn-start frame (turnStart)', () => {
    expect(exempted('F11')).toEqual(where(facts => facts.turnStart !== 'on-wire'));
  });

  it('exempts S21 exactly where the mock declares no implicitAutoResume', () => {
    expect(exempted('S21')).toEqual(whereMock(mock => mock.implicitAutoResume !== true));
  });

  it('selects lost-session skill-resume cells by declared mock.sessionStore', () => {
    expect(SESSION_STORE_RUNNERS).toEqual(whereMock(mock => mock.sessionStore !== undefined));
  });
});
