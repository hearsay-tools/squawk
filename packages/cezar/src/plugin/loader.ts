import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginHealthEntry, PluginsHealth } from '@open-mercato/cezar-contract';
import { runPluginSetup, type PluginContributions, type SquawkPlugin } from './api.ts';
import { bundledRunnerFolders, bundledRunnersDir } from './bundled-runners.ts';
import { installPluginResolveHook } from './resolve-hook.ts';

/**
 * The plugin loader (spec 2026-11-24-plugin-loader-and-runner-kit § 4). A plugin is one folder
 * whose `index.mjs` or `index.js` default-exports a setup function. The loader runs each folder's
 * setup through `runPluginSetup`, so a plugin that throws or collides commits nothing. A broken
 * host plugin is skipped with one stderr warning and never stops boot. The bundled runners
 * (`runners/<id>/index.ts`) load through the same setup first; a bundled runner that fails stops
 * boot, because it is a defect of Squawk itself.
 */

/** `bundled` ships inside Squawk; `host` comes from `<config>/plugins/`. */
export type PluginSource = 'bundled' | 'host';

export interface LoadedPlugin {
  readonly name: string;
  readonly source: PluginSource;
  readonly path: string;
  readonly contributions: PluginContributions;
}

/** Why a plugin was skipped. Health sends only this; the message can carry any text. */
export type PluginFailureReason = 'missing-entry' | 'no-setup' | 'import' | 'setup';

export interface FailedPlugin {
  readonly name: string;
  readonly source: PluginSource;
  readonly path: string;
  readonly reason: PluginFailureReason;
  /** The full message, for the operator: stderr and `hsq plugins`. Never sent on health. */
  readonly error: string;
}

class PluginLoadFailure extends Error {
  constructor(readonly reason: PluginFailureReason, message: string) {
    super(message);
  }
}

/** What this process loaded. `folders` lists every folder the loader read, in load order. */
export interface PluginLoadReport {
  readonly folders: readonly string[];
  readonly loaded: readonly LoadedPlugin[];
  readonly failed: readonly FailedPlugin[];
}

const EMPTY_REPORT: PluginLoadReport = Object.freeze({ folders: [], loaded: [], failed: [] });
let report: PluginLoadReport = EMPTY_REPORT;

/** The plugins this process loaded and skipped. `hsq plugins` and `GET /api/v1/health` read it. */
export function pluginLoadReport(): PluginLoadReport {
  return report;
}

/** The entry files the loader tries in each plugin folder, in order. */
export const PLUGIN_ENTRY_FILES = ['index.mjs', 'index.js'] as const;

export interface LoadPluginFolderOptions {
  /** The folder whose child folders are plugins. A missing folder loads nothing. */
  dir: string;
  source: PluginSource;
  /** Receives one line per skipped plugin. Default: stderr. */
  warn?: (line: string) => void;
}

/** Locale-independent code-point order, so every host loads plugins in the same order. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isDirectoryEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A thrown value as text. A value with no string conversion still gives a line. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'a thrown value with no string form';
  }
}

/** Child folder names in load order; a missing folder is an empty list. */
function pluginFolders(dir: string, warn: (line: string) => void): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[hsq] plugin folder ${dir} unreadable: ${errorText(error)}`);
    return [];
  }
  return entries.filter(entry => isDirectoryEntry(dir, entry)).map(entry => entry.name).sort(byCodePoint);
}

/** Import one plugin folder's entry and run its setup. Throws the reason the plugin is skipped. */
async function loadOne(path: string): Promise<PluginContributions> {
  const entry = PLUGIN_ENTRY_FILES.map(file => join(path, file)).find(isFile);
  if (!entry) throw new PluginLoadFailure('missing-entry', `missing ${PLUGIN_ENTRY_FILES.join(' or ')}`);
  return loadEntry(path, entry);
}

/** Import `entry`, the entry file of the plugin folder `path`, and run its setup. */
async function loadEntry(path: string, entry: string): Promise<PluginContributions> {
  const entryModule = await import(pathToFileURL(entry).href).catch((error: unknown) => {
    throw new PluginLoadFailure('import', errorText(error));
  }) as { default?: unknown };
  if (typeof entryModule.default !== 'function') throw new PluginLoadFailure('no-setup', `${entry.slice(path.length + 1)} has no default-exported setup function`);
  return runPluginSetup(entryModule.default as SquawkPlugin).catch((error: unknown) => {
    throw new PluginLoadFailure('setup', errorText(error));
  });
}

/**
 * Load every plugin folder under `dir` in code-point order of folder name and add the outcome to
 * the process report. Installs the `@hearsay-tools/squawk/plugin` resolve hook first.
 */
export async function loadPluginFolder({ dir, source, warn = line => { process.stderr.write(`${line}\n`); } }: LoadPluginFolderOptions): Promise<PluginLoadReport> {
  const names = pluginFolders(dir, warn);
  const loaded: LoadedPlugin[] = [];
  const failed: FailedPlugin[] = [];
  if (names.length > 0) installPluginResolveHook();
  for (const name of names) {
    const path = join(dir, name);
    try {
      loaded.push(Object.freeze({ name, source, path, contributions: await loadOne(path) }));
    } catch (error) {
      const reason = error instanceof PluginLoadFailure ? error.reason : 'setup';
      const failure = Object.freeze({ name, source, path, reason, error: errorText(error) });
      failed.push(failure);
      warn(`[hsq] plugin "${name}" skipped: ${failure.error}`);
    }
  }
  return addToReport(dir, loaded, failed);
}

function addToReport(dir: string, loaded: readonly LoadedPlugin[], failed: readonly FailedPlugin[]): PluginLoadReport {
  report = Object.freeze({
    folders: Object.freeze([...report.folders, dir]),
    loaded: Object.freeze([...report.loaded, ...loaded]),
    failed: Object.freeze([...report.failed, ...failed]),
  });
  return report;
}

export interface LoadBundledRunnersOptions {
  /**
   * Allow `dir` to hold no bundled runner. Test-only: `bootRuntime({ bundledRunnersDir })` sets
   * this when overriding the bundled folder so tests and live-run wrappers can boot with host
   * plugins only. Default boot keeps this false so an empty bundle fails closed.
   */
  allowEmpty?: boolean;
}

/**
 * Load the bundled runners under `dir` (default: the `runners/` folder of this Squawk copy) in
 * display order, each through `runPluginSetup` like a host plugin, and add them to the report as
 * `bundled`. A folder with no bundled runner (unless `allowEmpty` is set), or a bundled runner
 * that fails to import or to register, throws: Squawk shipped it, so the cockpit would miss a
 * runner it promises, and boot stops instead of hiding the defect.
 */
export async function loadBundledRunners(
  dir: string = bundledRunnersDir(),
  { allowEmpty = false }: LoadBundledRunnersOptions = {},
): Promise<PluginLoadReport> {
  const folders = bundledRunnerFolders(dir);
  // Squawk always ships its runners: none found means a broken build, never an empty cockpit.
  if (folders.length === 0 && !allowEmpty) {
    throw new Error(`No bundled runner was found in ${dir}: Squawk ships runners/<id>/index.js for each runner; rebuild it.`);
  }
  installPluginResolveHook();
  const loaded: LoadedPlugin[] = [];
  for (const { id, path, entry } of folders) {
    try {
      loaded.push(Object.freeze({ name: id, source: 'bundled' as const, path, contributions: await loadEntry(path, entry) }));
    } catch (error) {
      throw new Error(`Bundled runner "${id}" failed to load: ${errorText(error)}`, { cause: error });
    }
  }
  return addToReport(dir, loaded, []);
}

/**
 * The text health sends for each reason. A plugin's own message can name host paths or carry a
 * secret, and health is CORS-open, so health never sends it; `hsq plugins` on the host does.
 */
export const PLUGIN_FAILURE_TEXT: Readonly<Record<PluginFailureReason, string>> = {
  'missing-entry': 'missing index.mjs or index.js',
  'no-setup': 'the entry has no default-exported setup function',
  import: 'the entry failed to import; run `hsq plugins` on the host for the error',
  setup: 'setup failed or a registration was refused; run `hsq plugins` on the host for the error',
};

/**
 * The health payload for a report. A local cockpit sends each plugin's folder; a hosted one
 * (`HSQ_REMOTE=1` or a non-loopback bind) sends no path. A skipped plugin's error is always the
 * fixed text for its reason.
 */
export function pluginHealth(source: PluginLoadReport, { hostPaths }: { hostPaths: boolean }): PluginsHealth {
  const entry = (plugin: LoadedPlugin | FailedPlugin): PluginHealthEntry =>
    hostPaths ? { name: plugin.name, source: plugin.source, path: plugin.path } : { name: plugin.name, source: plugin.source };
  return {
    loaded: source.loaded.map(entry),
    failed: source.failed.map(plugin => ({ ...entry(plugin), error: PLUGIN_FAILURE_TEXT[plugin.reason] })),
  };
}
