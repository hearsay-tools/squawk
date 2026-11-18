/**
 * What a shrink-only ratchet may do to its baseline in this run (hearsay-tools/squawk#3908).
 *
 * - `write`: its `<NAME>_UPDATE=1` variable is set. Lower the baseline, or write the first one when it is missing.
 * - `lower`: a local run. Lower a pin or count that the code has fallen below, so a file or test that only got
 *   smaller never fails the gate. A missing baseline stays missing: writing the first one is a decision.
 * - `report`: CI. Write nothing and fail a stale entry, so a lowering that was never committed cannot reach
 *   `main`, where a stale pin would let the file grow back.
 */
export type BaselineMode = 'write' | 'lower' | 'report';

/** `update`: the ratchet's `<NAME>_UPDATE` variable is `1`. `ci`: the run is in CI. */
export function baselineMode(update: boolean, ci = process.env.CI === 'true'): BaselineMode {
  if (update) return 'write';
  return ci ? 'report' : 'lower';
}

/** Where a run says it lowered a baseline. `npm run prepr` copies these `lowered:` lines into its report. */
export const printLowered = (line: string): void => console.log(`lowered: ${line}`);
