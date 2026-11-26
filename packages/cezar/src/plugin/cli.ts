import { commandText } from '../home/command.ts';
import type { PluginContributions } from './api.ts';
import { pluginLoadReport, type PluginLoadReport } from './loader.ts';

const USAGE = `usage: cez plugins [--json]

Lists the plugins this process loaded, what each one registered, and the plugins it skipped with
the reason: first the runners and features bundled with Squawk (source "bundled"), then the plugins in
<config>/plugins/ (source "host"). --json prints the same report as JSON.`;

const CONTRIBUTION_LABELS: ReadonlyArray<[keyof PluginContributions, string]> = [
  ['cliCommands', 'commands'], ['runners', 'runners'], ['agentTools', 'agent tools'],
  ['waitKinds', 'wait kinds'], ['stepKinds', 'step kinds'],
  ['removalSlots', 'removal slots'], ['runLifecycleListeners', 'run lifecycle listeners'],
  ['launchParts', 'launch parts'],
];

function contributionLines(contributions: PluginContributions): string[] {
  return CONTRIBUTION_LABELS.flatMap(([key, label]) => {
    const value = contributions[key];
    if (Array.isArray(value)) return value.length > 0 ? [`    ${label}: ${value.join(', ')}`] : [];
    return value ? [`    ${label}: ${value}`] : [];
  });
}

/** The human-readable report. */
export function formatPluginReport(report: PluginLoadReport): string {
  const lines = report.folders.length > 0
    ? report.folders.map(folder => `Plugin folder: ${folder}`)
    : ['No plugin folder was read.'];
  lines.push('', `Loaded (${report.loaded.length}):`);
  if (report.loaded.length === 0) lines.push('  none');
  for (const plugin of report.loaded) {
    lines.push(`  ${plugin.name}  ${plugin.source}  ${plugin.path}`, ...contributionLines(plugin.contributions));
  }
  lines.push('', `Skipped (${report.failed.length}):`);
  if (report.failed.length === 0) lines.push('  none');
  for (const plugin of report.failed) lines.push(`  ${plugin.name}  ${plugin.source}  ${plugin.path}`, `    error: ${plugin.error}`);
  return lines.join('\n');
}

/** `hsq plugins`: full boot has run, so the report holds this process's plugins. */
export async function runPluginsCommand(argv: string[], _env: NodeJS.ProcessEnv, out = console): Promise<number> {
  if (argv.some(arg => arg === '--help' || arg === '-h' || arg === 'help')) {
    out.log(commandText(USAGE));
    return 0;
  }
  const unknown = argv.filter(arg => arg !== '--json');
  if (unknown.length > 0) {
    out.error(commandText(`unknown argument: ${unknown[0]}\n\n${USAGE}`));
    return 1;
  }
  const report = pluginLoadReport();
  out.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatPluginReport(report));
  return 0;
}
