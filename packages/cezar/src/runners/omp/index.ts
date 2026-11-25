import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { ompRunner } from './definition.ts';

/** Where the omp runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 50;

/** The omp runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(ompRunner);
};
export default plugin;
