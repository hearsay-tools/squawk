import type { HarnessGroup, HarnessRegistrar } from './harness-parity-registrar.testkit.ts';
import { PROVIDER_HOLD_ROW_IDS, RUN_ROWS } from './harness-parity-rows.testkit.ts';
import { runRows, type RunRowCell } from './harness-parity-run-tier.rows.testkit.ts';

/** The provider part's cell bodies, which `harness-parity-provider.cells.testkit.ts` holds. */
export type ProviderCells = { readonly runRow: RunRowCell };

/** The provider part's groups, apart from its bodies so a registration guard loads no run engine. */
export function providerGroups(cells: ProviderCells) {
  return {
    provider(r: HarnessRegistrar) {
      const { describeRunners } = r;
      describeRunners('provider', 'harness parity — provider error hold', () => runRows(r, RUN_ROWS.filter(row => PROVIDER_HOLD_ROW_IDS.includes(row.id)), cells.runRow));
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
