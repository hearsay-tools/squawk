import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one public plugin entry (spec 2026-11-24-plugin-loader-and-runner-kit § 4). */
export const PLUGIN_ENTRY_SPECIFIER = '@hearsay-tools/squawk/plugin';

/**
 * The running copy's plugin entry: `index.ts` next to this file under source (tsx, Node type
 * stripping, Vitest), `index.js` next to it under the built `dist/`.
 */
export function runningPluginEntryUrl(moduleUrl: string = import.meta.url): string {
  return new URL(`./index${extname(fileURLToPath(moduleUrl))}`, moduleUrl).href;
}

let installed = false;

/** Squawk's own package. Any specifier in it other than the plugin entry would load a second copy. */
const PACKAGE_NAME = '@hearsay-tools/squawk';

/**
 * Map `@hearsay-tools/squawk/plugin` to the running copy for every later import in this process,
 * so a plugin outside the repository and a built-in runner share one set of module state. Any other
 * specifier in the package (its root, a deeper subpath) is refused: it has no running copy to map
 * to, and an installed copy would split process state. Installs once; a second call does nothing.
 * Loads no runner code.
 */
export function installPluginResolveHook(): void {
  if (installed) return;
  installed = true;
  const url = runningPluginEntryUrl();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === PLUGIN_ENTRY_SPECIFIER) return { url, shortCircuit: true };
      if (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)) {
        throw new Error(`Cannot import ${specifier}: a plugin imports Squawk only from ${PLUGIN_ENTRY_SPECIFIER}.`);
      }
      return nextResolve(specifier, context);
    },
  });
}
