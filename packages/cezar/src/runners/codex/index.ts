import type { SquawkPlugin } from '@hearsay-tools/squawk/plugin';
import { codexRunner } from './definition.ts';

/** Where the codex runner sits among the bundled runners: lower comes first. `plugin/bundled-runners.ts` reads this line as text. */
export const displayOrder = 20;

/** The codex runner's plugin entry. Boot loads it through the plugin loader. */
const plugin: SquawkPlugin = (api) => {
  api.registerRunner(codexRunner);
};
export default plugin;
