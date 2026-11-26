import type { Readable, Writable } from 'node:stream';
import { z } from '@hearsay-tools/squawk/plugin';
import { readNdjson } from '@hearsay-tools/squawk/plugin/runtime';

const idSchema = z.union([z.string(), z.number()]);
const frameSchema = z.object({
  jsonrpc: z.literal('2.0'), id: idSchema.optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export type RpcId = z.infer<typeof idSchema>;
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** ACP v1 uses one JSON-RPC object per UTF-8 line, not Content-Length headers.
 * The caller owns the child, its deadline and process-tree cleanup. Closing this wire
 * rejects receipts immediately; it does not claim that the child has exited. */
export class AcpTransport {
  private serial = 0;
  private failure: Error | undefined;
  private pending = new Map<RpcId, Pending>();
  readonly completion: Promise<Error | undefined>;

  constructor(private readonly streams: { input: Writable; output: Readable }, private readonly handlers: {
    notification: (method: string, params: unknown) => void;
    request: (method: string, params: unknown, id: RpcId) => unknown | Promise<unknown>;
    answered?: (method: string, id: RpcId) => void;
    activity?: () => void;
    notice?: (message: string) => void;
  }) {
    const fail = (error: Error) => this.close(error);
    streams.input.on('error', fail);
    streams.output.on('error', fail);
    this.completion = this.read().finally(() => {
      streams.input.off('error', fail);
      streams.output.off('error', fail);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.close(asError(error)); }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(error = new Error('ACP input/output transport closed')): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private write(frame: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.streams.input.writable) throw new Error('ACP input is not writable');
    this.streams.input.write(`${JSON.stringify(frame)}\n`, error => { if (error) this.close(error); });
  }

  private async read(): Promise<Error | undefined> {
    try {
      for await (const line of readNdjson(this.streams.output)) {
        const frame = frameSchema.parse(JSON.parse(line));
        this.handlers.activity?.();
        if (frame.method !== undefined) {
          if (frame.id === undefined) this.notification(frame.method, frame.params);
          else void this.answer(frame.method, frame.params, frame.id);
        } else {
          if (frame.id === undefined || (!('result' in frame) && !frame.error)) throw new Error('Invalid ACP response');
          const pending = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          if (frame.error) pending?.reject(new AcpRpcError(frame.error.code, frame.error.message, frame.error.data));
          else pending?.resolve(frame.result);
        }
      }
      this.close();
      return undefined;
    } catch (error) {
      const failure = asError(error);
      this.close(failure);
      return failure;
    }
  }

  private notification(method: string, params: unknown): void {
    try { this.handlers.notification(method, params); }
    catch (error) {
      // A well-framed notification is not a transport failure. Provider extensions and
      // malformed update payloads must not reject an unrelated in-flight prompt.
      try { this.handlers.notice?.(`ACP ignored ${method}: ${asError(error).message}`); }
      catch { /* A diagnostic consumer cannot turn a dropped notification into a disconnect. */ }
    }
  }

  private async answer(method: string, params: unknown, id: RpcId): Promise<void> {
    let result: unknown;
    try {
      result = await this.handlers.request(method, params, id);
    } catch (error) {
      if (this.failure) return;
      const rpc = error instanceof AcpRpcError ? error : new AcpRpcError(-32603, asError(error).message);
      try { this.write({ jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message } }); }
      catch (writeError) { this.close(asError(writeError)); }
      return;
    }
    if (this.failure) return;
    try { this.write({ jsonrpc: '2.0', id, result }); }
    catch (writeError) { this.close(asError(writeError)); return; }
    this.handlers.answered?.(method, id);
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
