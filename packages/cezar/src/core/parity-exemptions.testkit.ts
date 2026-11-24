import { buildParityExemptions, releasesHumanPromptOnRead, type ParityExemption } from './harness-parity-core.testkit.ts';
import { factRows, factsWhere } from './runner-fact-rows.testkit.ts';
import { mockRows } from './runner-mock-rows.testkit.ts';

/**
 * Every built-in runner's parity exemptions, built from all runners' data files.
 * Keep this module in cross-runner guards and `scripts/parity-rows.ts` only; single-runner
 * parity tests read `exemptionFor` from `harness-parity-core.testkit.ts`, which looks up only
 * the registered runner (hearsay-tools/squawk#4175).
 */
export const PARITY_EXEMPTIONS: readonly ParityExemption[] = buildParityExemptions(factRows(), mockRows());

export function exemptionFor(criterion: string, backend: string): ParityExemption | undefined {
  return PARITY_EXEMPTIONS.find((e) => e.criterion === criterion && e.backend === backend);
}

/** Every built-in runner whose human-prompt hold ends when the wire reports the prompt read. */
export function humanPromptReadReleases(): string[] {
  return factsWhere(releasesHumanPromptOnRead);
}
