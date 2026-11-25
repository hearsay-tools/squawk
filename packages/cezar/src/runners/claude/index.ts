import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { claudeRunner } from './definition.ts';

/** Where the claude runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 10;

/** The claude runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(claudeRunner);
};
export default plugin;
