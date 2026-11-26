import { expect } from 'vitest';
import { exemptionFor, HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';
import type { HarnessRegistrar } from './harness-parity-registrar.testkit.ts';
import type { ParityRow } from './harness-parity-rows.testkit.ts';

/**
 * How the run tier registers its rows, apart from the drives and assertions in
 * `harness-parity-run-tier.testkit.ts`, which load the workflow engine. A guard that only reads
 * which rows register loads this module and no engine (hearsay-tools/squawk#3962).
 */

/** One run-tier row's body for one runner. An exempt row asserts that the row fails there. */
export type RunRowCell = (backend: string, id: string, exempt: boolean) => () => Promise<void>;

export function runRows({ runners, it }: HarnessRegistrar, rows: readonly ParityRow[], cell: RunRowCell): void {
  for (const backend of runners) {
    for (const row of rows) {
      const exempt = exemptionFor(row.id, backend);
      if (exempt?.kind === 'scenario-unconstructible') {
        it(`${backend} is exempt from ${row.id} — ${exempt.reason}`, () => {
          expect(HARNESS_ADAPTERS[backend]!.scenarios[row.scenario]!).toBeUndefined();
        });
        continue;
      }
      it(
        exempt
          ? `${backend} is exempt from ${row.id} — ${exempt.reason}`
          : `${backend} ${row.name}`,
        cell(backend, row.id, Boolean(exempt)),
        (row.timeoutMs ?? 55_000) + 5_000,
      );
    }
  }
}
