/**
 * `hsq mcp token create | list | revoke` (hearsay-tools/squawk#4402): host-CLI management of
 * per-port hashed bearer tokens for `/api/v1/mcp`, mirroring `remote-settings-cli.ts` (ADR 0055).
 * Prints one JSON object per invocation; exit 0 ok, 2 refused, 64 invalid input.
 */
import { parseArgs } from 'node:util';
import { commandText } from '../../home/command.ts';
import type { Home } from '../../home/home.ts';
import {
  createMcpToken,
  listMcpTokens,
  McpTokenRevokeError,
  revokeMcpToken,
} from '../../mcp-tokens.ts';
import { COCKPIT_PORTS } from '../../task-cli/discovery.ts';

export const MCP_TOKEN_USAGE = commandText(`cez mcp token — manage per-port bearer tokens for POST /api/v1/mcp.
One JSON object per invocation; exit 0 ok, 2 refused, 64 usage.

  create [--name <label>] [--port <n>] [--project <id>]
                         create a bearer token for that cockpit port and print the raw token once.
                         Without --port, targets the only cockpit running on 127.0.0.1:4321–4370.
  list [--port <n>]      list stored token metadata (never hashes or raw tokens) for one or all ports.
  revoke [<id>] [--port <n>] [--all]
                         revoke one token by id (resolving across ports when --port is omitted),
                         or revoke all tokens for --port <n> with --all.

Takes effect on the next request; no restart. Run on the host as the cockpit user.`);

const PROBE_TIMEOUT_MS = 800; // bound: one loopback health check per port; a silent port is not a cockpit

export interface McpTokenCliIo {
  stdout(line: string): void;
  /** Running loopback cockpit ports on this host; tests replace the port scan. */
  runningPorts?: () => Promise<number[]>;
}

class TokenCliRefusal extends Error {
  readonly exitCode: number;
  readonly body: Record<string, unknown>;

  constructor(exitCode: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.exitCode = exitCode;
    this.body = body;
  }
}

async function probeLoopbackCockpit(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: unknown };
    return typeof data?.version === 'string' ? port : null;
  } catch {
    return null;
  }
}

export async function scanRunningCockpitPorts(): Promise<number[]> {
  const found = await Promise.all(COCKPIT_PORTS.map(probeLoopbackCockpit));
  return found.filter((port): port is number => port !== null).sort((a, b) => a - b);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65_535) {
    throw new TokenCliRefusal(64, {
      ok: false,
      code: 'invalid_input',
      error: `--port must be a port number (1–65535), not "${value}"`,
      usage: MCP_TOKEN_USAGE,
    });
  }
  return Number(value);
}

async function resolveCreatePort(port: number | undefined, io: McpTokenCliIo): Promise<number> {
  if (port !== undefined) return port;
  const ports = await (io.runningPorts ?? scanRunningCockpitPorts)();
  if (ports.length === 1) return ports[0]!;
  const error = ports.length === 0
    ? 'no cockpit answers on 127.0.0.1 ports 4321–4370; pass --port <n> with its listen port'
    : `several cockpits run on this machine (ports ${ports.join(', ')}); pass --port <n> to choose one`;
  throw new TokenCliRefusal(2, { ok: false, code: 'choose_cockpit', error, ports });
}

function parseTokenArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        name: { type: 'string' },
        project: { type: 'string' },
        all: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new TokenCliRefusal(64, {
      ok: false,
      code: 'invalid_input',
      error: error instanceof Error ? error.message : 'invalid arguments',
      usage: MCP_TOKEN_USAGE,
    });
  }
}

function invalidInput(message: string): never {
  throw new TokenCliRefusal(64, { ok: false, code: 'invalid_input', error: message, usage: MCP_TOKEN_USAGE });
}

type ParsedTokenValues = ReturnType<typeof parseTokenArgs>['values'];

async function runCreateAction(rest: string[], values: ParsedTokenValues, port: number | undefined, home: Home, io: McpTokenCliIo): Promise<Record<string, unknown>> {
  if (rest.length > 0) invalidInput(`unexpected argument '${rest[0]}'`);
  if (values.all) invalidInput('create takes no --all');
  if (values.project !== undefined) {
    const trimmedProject = values.project.trim();
    if (!trimmedProject) invalidInput('--project must not be empty');
    if (trimmedProject === 'all') invalidInput('--project cannot be "all" (reserved for cross-project listing)');
  }
  const targetPort = await resolveCreatePort(port, io);
  const created = createMcpToken({ port: targetPort, home, name: values.name, project: values.project });
  return {
    ok: true,
    id: created.id,
    name: created.name,
    port: created.port,
    createdAt: created.createdAt,
    ...(created.project !== undefined ? { project: created.project } : {}),
    token: created.token,
    path: created.path,
    note: 'Save this token now — only its SHA-256 hash is stored on disk.',
  };
}

function runListAction(rest: string[], values: ParsedTokenValues, port: number | undefined, home: Home): Record<string, unknown> {
  if (rest.length > 0) invalidInput(`unexpected argument '${rest[0]}'`);
  if (values.name !== undefined || values.project !== undefined || values.all) {
    invalidInput('list accepts only --port <n>');
  }
  return { ok: true, ...listMcpTokens(home, port) };
}

function runRevokeAction(rest: string[], values: ParsedTokenValues, port: number | undefined, home: Home): Record<string, unknown> {
  if (values.name !== undefined || values.project !== undefined) {
    invalidInput('revoke accepts only <id>, --port <n>, and --all');
  }
  if (values.all) {
    if (rest.length > 0) invalidInput('revoke --all takes no token id');
    if (port === undefined) invalidInput('revoke --all requires --port <n>');
    return { ok: true, ...revokeMcpToken({ home, port, all: true }) };
  }
  if (rest.length !== 1) invalidInput('revoke requires a token <id> (or --all --port <n>)');
  return { ok: true, ...revokeMcpToken({ home, id: rest[0], port }) };
}

async function runTokenSubcommand(argv: string[], home: Home, io: McpTokenCliIo): Promise<Record<string, unknown>> {
  const { positionals, values } = parseTokenArgs(argv);
  const [action, ...rest] = positionals;
  const port = parsePort(values.port);
  if (action === 'create') return runCreateAction(rest, values, port, home, io);
  if (action === 'list') return runListAction(rest, values, port, home);
  if (action === 'revoke') return runRevokeAction(rest, values, port, home);
  invalidInput(action === undefined ? 'missing command (create, list, revoke)' : `unknown command '${action}'`);
}

export async function runMcpTokenCommand(
  argv: string[],
  home: Home,
  io: McpTokenCliIo = { stdout: (line) => console.log(line) },
): Promise<number> {
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0] ?? '') || argv.includes('--help') || argv.includes('-h')) {
    io.stdout(MCP_TOKEN_USAGE);
    return 0;
  }
  try {
    io.stdout(JSON.stringify(await runTokenSubcommand(argv, home, io), null, 2));
    return 0;
  } catch (error) {
    if (error instanceof McpTokenRevokeError) {
      io.stdout(JSON.stringify({
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.ports ? { ports: error.ports } : {}),
      }, null, 2));
      return 2;
    }
    if (!(error instanceof TokenCliRefusal)) throw error;
    io.stdout(JSON.stringify(error.body, null, 2));
    return error.exitCode;
  }
}
