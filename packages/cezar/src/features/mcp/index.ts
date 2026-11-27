/**
 * The bundled orchestrator MCP feature (spec 2026-11-27-orchestrator-mcp-server,
 * hearsay-tools/squawk#4401): registers `hsq mcp` through the plugin API only.
 * Nothing outside this folder imports it.
 */
import type { CliCommandDefinition, SquawkPluginApi } from '../../plugin/index.ts';

/** `hsq mcp`: parses its own argv and talks to a running cockpit over loopback HTTP. */
export const mcpCliCommand: CliCommandDefinition = {
  name: 'mcp',
  usage: ['  cez mcp [--url <origin>] [--repo <dir>]  serve Squawk task tools over MCP stdio (see: mcp --help)'],
  parseMode: 'subcommand',
  homeMode: 'none',
  runtimeMode: 'none',
  load: async () => (await import('./cli.ts')).runMcpCommand,
};

export default function setup(api: SquawkPluginApi): void {
  api.registerCliCommand(mcpCliCommand);
}
