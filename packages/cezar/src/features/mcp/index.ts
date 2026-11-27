/**
 * The bundled orchestrator MCP feature (spec 2026-11-27-orchestrator-mcp-server,
 * hearsay-tools/squawk#4401 and hearsay-tools/squawk#4402): registers `hsq mcp` and
 * `POST /api/v1/mcp` through the plugin API only. Nothing outside this folder imports it.
 */
import type { CliCommandDefinition, HttpRouteDefinition, SquawkPluginApi } from '../../plugin/index.ts';

/** `hsq mcp`: stdio MCP server and host-CLI bearer token management (`hsq mcp token`). */
export const mcpCliCommand: CliCommandDefinition = {
  name: 'mcp',
  usage: [
    '  cez mcp [--url <origin>] [--repo <dir>]  serve Squawk task tools over MCP stdio (see: mcp --help)',
    '  cez mcp token <create|list|revoke>       manage bearer tokens for POST /api/v1/mcp',
  ],
  parseMode: 'subcommand',
  homeMode: 'conditional',
  runtimeMode: 'none',
  load: async (home) => async (argv, env) =>
    (await import('./cli.ts')).runMcpCommand(argv, env, { home: () => home(env) }),
};

/** Stateless Streamable HTTP MCP route (`/api/v1/mcp`), loaded lazily on first request. */
export const mcpHttpRoute: HttpRouteDefinition = {
  id: 'mcp',
  method: 'ALL',
  path: '/api/v1/mcp',
  handle: async (request, context) => (await import('./http.ts')).handleMcpHttpRequest(request, context),
};

export default function setup(api: SquawkPluginApi): void {
  api.registerCliCommand(mcpCliCommand);
  api.registerHttpRoute(mcpHttpRoute);
}
