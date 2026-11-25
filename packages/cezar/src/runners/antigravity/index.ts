import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { antigravityRunner } from './definition.ts';

/** Where the antigravity runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 60;

/** The antigravity runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(antigravityRunner);
};
export default plugin;
