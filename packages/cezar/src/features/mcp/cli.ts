import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { productEnv } from '../../core/product-env.ts';
import { commandText } from '../../home/command.ts';
import type { Home } from '../../home/home.ts';
import { discoverCockpitOrigin, type DiscoverOriginOptions } from '../../task-cli/discovery.ts';
import { TaskCliError } from '../../task-cli/http.ts';
import { serveMcpStdio, type ServeMcpStdioOptions } from './stdio.ts';
import { runMcpTokenCommand, type McpTokenCliIo } from './token-cli.ts';

export const MCP_HELP = commandText(`Squawk MCP — stdio MCP server and HTTP bearer token management for outside orchestrators

Usage:
  cez mcp [--url <origin>] [--repo <dir>]
  cez mcp token <create|list|revoke> [options]

Options:
  --url <origin>   Connect to this cockpit origin instead of local discovery (also HSQ_URL / CEZ_URL).
  --repo <dir>     Match the cockpit serving this repository (default: cwd, falling back to a single local cockpit).
  -h, --help       Show this help (use \`cez mcp token --help\` for token management options).

Notes:
  - Keeps stdout strictly for MCP JSON-RPC frames; diagnostics go to stderr.
  - Refuses to start inside a Squawk task (when HSQ_TASK_ID or CEZ_TASK_ID is set).`);

export interface McpCliDeps {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  discover?: (options: DiscoverOriginOptions) => Promise<{ origin: string }>;
  serve?: (options: ServeMcpStdioOptions) => Promise<void>;
  home?: () => Home;
  tokenIo?: McpTokenCliIo;
  version?: string;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseMcpArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        repo: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new TaskCliError(64, { code: 'invalid_input', error: error instanceof Error ? error.message : 'invalid arguments' });
  }
}

function formatCliError(error: unknown): { message: string; exitCode: number } {
  if (error instanceof TaskCliError) {
    const msg = typeof error.body.error === 'string' ? error.body.error : error.message;
    const hint = typeof error.body.hint === 'string' ? `\nHint: ${error.body.hint}` : '';
    return { message: `${msg}${hint}`, exitCode: error.exitCode };
  }
  return { message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

async function runMcpTokenDispatch(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: McpCliDeps,
  writeOut: (line: string) => void,
  writeErr: (line: string) => void,
): Promise<number> {
  if (productEnv('TASK_ID', env)?.trim()) {
    writeErr(commandText('cez mcp token is host-only and refuses to run inside a Squawk task (HSQ_TASK_ID / CEZ_TASK_ID is set).'));
    return 1;
  }
  if (!deps.home) {
    writeErr('MCP token management requires a resolved Squawk home.');
    return 1;
  }
  return runMcpTokenCommand(argv.slice(1), deps.home(), deps.tokenIo ?? { stdout: writeOut });
}

export async function runMcpCommand(argv: string[], env: NodeJS.ProcessEnv, deps: McpCliDeps = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((line: string) => console.log(line));
  const writeErr = deps.stderr ?? ((line: string) => console.error(line));
  if (argv[0] === 'token') return runMcpTokenDispatch(argv, env, deps, writeOut, writeErr);
  try {
    const parsed = parseMcpArgs(argv);
    if (parsed.values.help) {
      writeOut(MCP_HELP);
      return 0;
    }
    if (parsed.positionals.length > 0) {
      throw new TaskCliError(64, { code: 'invalid_input', error: `unexpected argument '${parsed.positionals[0]}'` });
    }
    if (productEnv('TASK_ID', env)?.trim()) {
      writeErr(commandText('cez mcp is for outside orchestrators and refuses to start inside a Squawk task (HSQ_TASK_ID / CEZ_TASK_ID is set).'));
      return 1;
    }
    const url = parsed.values.url ?? (productEnv('URL', env)?.trim() || undefined);
    const explicitRepo = parsed.values.repo !== undefined;
    const repoDir = resolve(parsed.values.repo ?? (deps.cwd ? deps.cwd() : process.cwd()));
    const { origin } = await (deps.discover ?? discoverCockpitOrigin)({ url, repoDir, explicitRepo });
    await (deps.serve ?? serveMcpStdio)({ origin, version: deps.version ?? readPackageVersion() });
    return 0;
  } catch (error) {
    const formatted = formatCliError(error);
    writeErr(formatted.message);
    return formatted.exitCode;
  }
}
