import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';

/** The session-context parity groups, apart from the cells so registration guards load no run engine. */
export const SESSION_CONTEXT_GROUPS = {
  opening: ['R120'],
  live: ['R121'],
  retry: ['R122'],
  recovery: ['R123'],
  worker: ['R124'],
} as const;

export type SessionContextGroup = keyof typeof SESSION_CONTEXT_GROUPS;

export type SessionContextCells = {
  R120: (runner: string) => () => Promise<void>;
  R121: (runner: string) => () => Promise<void>;
  R122: (runner: string) => () => Promise<void>;
  R123: (runner: string) => () => Promise<void>;
  R124: (runner: string) => () => Promise<void>;
};

export type SessionContextSuite = {
  describe: (name: string, fn: () => void) => unknown;
  it: (name: string, fn: () => Promise<void>, timeout?: number) => unknown;
  afterEach: (fn: () => void) => unknown;
  useWorkerWaitFixture: () => unknown;
};

const SESSION_CONTEXT_TITLES: Readonly<Record<keyof SessionContextCells, string>> = {
  R120: 'R120 opens a fresh step with the whole handoff and parent rules, then refreshes them on Continue',
  R121: 'R121 never injects into a live message',
  R122: 'R122 injects into a check retry',
  R123: 'R123 injects into restart recovery with no live session',
  R124: "R124 renders an owned worker's own handoff and worker rules, never the parent's",
};

/** Single registrar shared by `describeSessionContext` and the registration guard, without loading the run engine. */
export function registerSessionContext(
  rows: readonly string[],
  cells: SessionContextCells,
  suite: SessionContextSuite,
  afterEachReset: () => void,
): void {
  suite.describe('session-start context through every native wire (hearsay-tools/cezarion#1584)', () => {
    suite.useWorkerWaitFixture();
    suite.afterEach(afterEachReset);
    for (const runner of PARITY_ROSTER) {
      for (const row of Object.keys(SESSION_CONTEXT_TITLES) as Array<keyof SessionContextCells>) {
        if (rows.includes(row) && runsOn('session-context', row, runner)) {
          suite.it(`${runner} ${SESSION_CONTEXT_TITLES[row]}`, cells[row](runner), 60_000);
        }
      }
    }
  });
}

const collectedOnly = () => async () => { throw new Error('registration collector cell should not run'); };
const COLLECTED_CELLS: SessionContextCells = {
  R120: collectedOnly, R121: collectedOnly, R122: collectedOnly, R123: collectedOnly, R124: collectedOnly,
};

/** Collect the real test titles registered by `registerSessionContext` for the given rows. */
export function collectSessionContextTitles(rows: readonly string[]): string[] {
  const titles: string[] = [];
  registerSessionContext(rows, COLLECTED_CELLS, {
    describe: (_name, fn) => fn(),
    it: (name) => { titles.push(name); },
    afterEach: () => {},
    useWorkerWaitFixture: () => {},
  }, () => {});
  return titles;
}
