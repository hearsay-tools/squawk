import { describeHarnessPart, type HarnessPartScope, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { providerGroups } from './harness-parity-provider.rows.testkit.ts';
import { runRowCell } from './harness-parity-run-tier.testkit.ts';

export const PROVIDER_GROUPS = providerGroups({ runRow: runRowCell });

/** Register the provider part's cells for one runner: `harness-<runner>-provider-parity.test.ts`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('provider', PROVIDER_GROUPS, scope, registration);
}
