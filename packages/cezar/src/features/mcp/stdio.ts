import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOrchestratorMcpServer, type OrchestratorMcpOptions } from './tools.ts';

export interface ServeMcpStdioOptions extends OrchestratorMcpOptions {
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

/**
 * Run the orchestrator MCP server over stdio until the transport closes, stdin ends, or a
 * termination signal arrives. Keeps stdout exclusively for MCP JSON-RPC frames.
 */
export async function serveMcpStdio(options: ServeMcpStdioOptions): Promise<void> {
  const server = createOrchestratorMcpServer(options);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin as typeof process.stdin, stdout as typeof process.stdout);

  let closing = false;
  const closeOnce = () => {
    if (closing) return;
    closing = true;
    void server.close().catch(() => { /* ignore close errors during shutdown */ });
  };

  await new Promise<void>((resolve, reject) => {
    const onSignal = () => closeOnce();
    const cleanup = () => {
      stdin.removeListener('end', closeOnce);
      stdin.removeListener('close', closeOnce);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    server.onclose = () => {
      cleanup();
      resolve();
    };
    stdin.once('end', closeOnce);
    stdin.once('close', closeOnce);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    void server.connect(transport).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}
