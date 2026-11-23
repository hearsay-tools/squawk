import { createKeyedRegistry } from '../../core/registry.ts';
import type { Wait, PluginWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { z } from 'zod';
import type { BuiltInWaitKindRow } from './wait-kinds.ts';
import type { RunStore } from '../../runs/store.ts';
import type { WaitEngineHost } from './wait-engine.ts';
import type { WaitResult } from '../waits.ts';

/** One tool request shape. Lower order wins when request kinds share a property. */
export interface WaitInputDescriptor {
  kind: string;
  order: number;
  inputSchema: z.ZodType;
  properties: Record<string, unknown>;
  descriptions?: Record<string, string>;
  description: string;
}
export interface WaitWatchContext {
  runId: string;
  store: RunStore;
  host: WaitEngineHost;
  wait: Wait;
  signal: AbortSignal;
  resolve(result?: WaitResult): void;
}
export interface WaitRegistrationContext {
  runId: string;
  turnId: string;
  via: string;
  now: number;
  signal?: AbortSignal | undefined;
}
/** Hooks use core wait values, so feature adapters need no private engine entry point. */
export interface WaitLifecycle {
  arm?(context: WaitWatchContext): void;
  disarm?(context: WaitWatchContext): void;
  dispose?(): void;
  postOpen?(context: WaitWatchContext): void;
  openedEntry?(wait: Wait, waits: readonly Wait[]): Wait;
}
type Policy = Omit<BuiltInWaitKindRow<Wait['kind']>, 'entry' | 'registration' | 'chargesWake' | 'answerKind' | 'requestKinds'>;
export type WaitKindRegistration = Policy & {
  kind: string;
  isPlugin?: boolean;
  requestKinds: readonly string[];
  inputs?: readonly WaitInputDescriptor[];
  lifecycle?: WaitLifecycle;
  entry?: unknown;
  registration: string;
  chargesWake: boolean | ((wait: Wait) => boolean);
  answerKind: (wait: Wait) => string | undefined;
  /** Plugin validation runs before its handler. The engine validates the returned durable entry. */
  duplicatePlugin?: (wait: PluginWaitEntry, request: Record<string, unknown>, turnId: string) => boolean;
  canonicalizePlugin?: (request: Record<string, unknown>) => void;
  inputSchema?: z.ZodType<Record<string, unknown> & { kind: string; operation_id?: string | undefined }>;
  register?: (request: Record<string, unknown> & { kind: string }, context: WaitRegistrationContext) => PluginWaitEntry | Promise<PluginWaitEntry>;
};
export type WaitKindRow = WaitKindRegistration;
const registry = createKeyedRegistry<string, WaitKindRow>({
  name: 'wait-kind registry',
  bootHint: 'Register core and feature wait kinds, then call sealWaitKinds() at the runtime boot boundary.',
});
const requestOwners = new Map<string, WaitKindRow>();
const builtInNames = new Set(['human', 'timer', 'process', 'pr', 'worker', 'request', 'peer', 'subagent', 'plugin']);
export function registerWaitKind(row: WaitKindRegistration): void {
  if (!row.kind || row.kind.length > 64 || row.kind === 'plugin' || (row.isPlugin && builtInNames.has(row.kind))) {
    throw new Error(`wait-kind registry: reserved or invalid kind '${row.kind}'.`);
  }
  for (const kind of row.requestKinds) {
    const owner = requestOwners.get(kind);
    if (owner && owner !== row) throw new Error(`wait-kind registry: conflicting request kind '${kind}'.`);
  }
  registry.register(row.kind, row);
  for (const kind of row.requestKinds) requestOwners.set(kind, row);
}
export const sealWaitKinds = registry.seal;
export const waitKindsSealed = registry.isSealed;
export const registeredWaitKinds = registry.values;
export const waitKindRow = registry.get;
export function waitKindForWait(wait: Wait): WaitKindRow | undefined {
  return waitKindRow(wait.kind === 'plugin' ? wait.pluginKind : wait.kind);
}
