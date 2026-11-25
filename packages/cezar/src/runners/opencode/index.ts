import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { opencodeRunner } from './definition.ts';

/** Where the opencode runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 30;

/** The opencode runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(opencodeRunner);
};
export default plugin;
