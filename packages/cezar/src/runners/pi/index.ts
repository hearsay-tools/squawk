import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { piRunner } from './definition.ts';

/** Where the pi runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 40;

/** The pi runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(piRunner);
};
export default plugin;
