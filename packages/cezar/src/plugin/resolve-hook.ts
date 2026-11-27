import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The primary public plugin entry (spec 2026-11-24-plugin-loader-and-runner-kit § 4). */
export const PLUGIN_ENTRY_SPECIFIER = '@hearsay-tools/squawk/plugin';

/**
 * Allowed `@hearsay-tools/squawk/plugin*` specifiers and their module stem next to this file.
 * Narrow subpaths keep `bootRuntime()` and runner `definition.ts` modules off eager
 * `node:child_process`, TOML/YAML parsers, managed-CLI storage, Pi RPC, and ACP code.
 */
export const PLUGIN_ENTRY_SUBPATHS: Readonly<Record<string, string>> = {
  [PLUGIN_ENTRY_SPECIFIER]: 'index',
  '@hearsay-tools/squawk/plugin/runtime': 'runtime',
  '@hearsay-tools/squawk/plugin/model-settings': 'model-settings',
  '@hearsay-tools/squawk/plugin/managed-cli': 'managed-cli',
  '@hearsay-tools/squawk/plugin/pi-rpc': 'pi-rpc',
  '@hearsay-tools/squawk/plugin/acp': 'acp',
};

/**
 * The running copy's plugin entry: `<stem>.ts` next to this file under source (tsx, Node type
 * stripping, Vitest), `<stem>.js` next to it under the built `dist/`.
 */
export function runningPluginEntryUrl(moduleUrl: string = import.meta.url, stem = 'index'): string {
  return new URL(`./${stem}${extname(fileURLToPath(moduleUrl))}`, moduleUrl).href;
}

let installed = false;

/** Squawk's own package. Any specifier in it outside the allowlisted plugin entries is refused. */
const PACKAGE_NAME = '@hearsay-tools/squawk';

/**
 * Map the allowlisted `@hearsay-tools/squawk/plugin*` entries to the running copy for every later
 * import in this process, so a plugin outside the repository and a built-in runner share one set
 * of module state. Any other specifier in the package (its root or an unknown subpath) is refused:
 * an installed copy would split process state. Installs once; a second call does nothing. Loads no
 * runner code.
 */
export function installPluginResolveHook(): void {
  if (installed) return;
  installed = true;
  const urls = new Map(
    Object.entries(PLUGIN_ENTRY_SUBPATHS).map(([specifier, stem]) => [specifier, runningPluginEntryUrl(import.meta.url, stem)]),
  );
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = urls.get(specifier);
      if (target !== undefined) return { url: target, shortCircuit: true };
      if (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)) {
        throw new Error(`Cannot import ${specifier}: a plugin imports Squawk only from ${PLUGIN_ENTRY_SPECIFIER} (or its documented kit subpaths).`);
      }
      return nextResolve(specifier, context);
    },
  });
}
