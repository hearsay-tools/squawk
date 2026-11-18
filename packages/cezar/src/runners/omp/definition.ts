import { defineRunner } from '../../core/runner-definition.ts';
import { OMP_FACTS } from './facts.ts';

/** The OMP runner. */
export const ompRunner = defineRunner({
  id: 'omp',
  facts: OMP_FACTS,
  loadAdapter: async () => new (await import('../../core/omp-runner.ts')).OmpRunner(),
});
