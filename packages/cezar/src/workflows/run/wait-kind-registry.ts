import { createKeyedRegistry } from '../../core/registry.ts';
import type { Wait, PluginWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { z } from 'zod';
import type { BuiltInWaitKindRow } from './wait-kinds.ts';
import type { AskErrorCode, BuiltInSquawkWaitRequest, WaitErrorCode, WaitVia } from '@open-mercato/cezar-contract';
import type { CiPrIdentity, CiWait, CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ProcessWaitSupervisor } from '../../process-wait/supervisor.ts';
import type { ExitFileRoots } from '../../process-wait/exit-file.ts';
import type { ActiveRun } from '../active-run.ts';
import type { WaitEngine, WaitEngineHost } from './wait-engine.ts';
import type { RegistrationIdentity } from './wait-registration.ts';
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
/** The CI watch behind `pr` waits. The core declares this port and the forge's supervisor
 *  implements it, so the core imports no feature (ADR 0065). */
export interface CiWatchPort {
  resolve(pr: string, signal?: AbortSignal): Promise<CiPrIdentity>;
  watch(wait: CiWait, signal: AbortSignal): Promise<CiWaitResult>;
  close(): void;
}
/** The ports the run manager offers feature wait kinds, beside the core host. */
export interface WaitFeatureServices {
  ciSupervisor(): CiWatchPort;
}
/** The registry host a wait request handler reads, beside the feature services. */
export interface WaitRequestHost extends WaitFeatureServices {
  executionBlockedByRootFinish(run: RunRecord): boolean;
}
/** One armed wait. The engine owns the timer and the signal, and ends both when it disarms the wait. */
export interface WaitWatchContext {
  runId: string;
  store: RunStore;
  host: WaitEngineHost;
  /** The wait as last armed or observed. */
  wait: Wait;
  signal: AbortSignal;
  resolve(result?: WaitResult): void;
  disposed(): boolean;
  /** Whether the wait's timer is armed. */
  deadlineArmed(): boolean;
  /** Arm the wait's timer for `delay` ms; it replaces an armed one. */
  armTimer(delay: number, due: () => void): void;
  /** Arm the wait's deadline unless its timer is armed. At the deadline, or at once when it is
   *  overdue, a run that can proceed calls `due` (default: resolve with no result). */
  armDeadline(due?: () => void): void;
  processes: Pick<ProcessWaitSupervisor, 'watch'>;
  exitFileRoots(): ExitFileRoots;
}
export interface WaitRegistrationContext {
  runId: string;
  turnId: string;
  via: string;
  now: number;
  signal?: AbortSignal | undefined;
}
/** What a built-in request handler reaches of the registry, for registrations outside `cezar_wait`. */
export interface WaitRegistryPort {
  readonly store: RunStore;
  readonly engine: Pick<WaitEngine, 'hasRoom' | 'open' | 'cancel'>;
  disposed(): boolean;
  active(id: string): ActiveRun | undefined;
  reconcileWorkerWaits(family?: string): void;
}
/** A built-in `cezar_wait` request that passed the shared registration gate. */
export interface WaitRequestContext {
  runId: string;
  run: RunRecord;
  state: ActiveRun;
  via: WaitVia;
  generation: string;
  registration: RegistrationIdentity | undefined;
  store: RunStore;
  host: WaitRequestHost;
  port: WaitRegistryPort;
  turnId(): string;
  refuse(code: WaitErrorCode | AskErrorCode): never;
  assertCanRegister(): unknown;
  hasRoom(run: Pick<RunRecord, 'waits'>): boolean;
  repeat(wait: Wait, timeoutSeconds: number | undefined): Wait;
  /** The open wait this request repeats in `turnId`; otherwise a full list refuses it. */
  repeatOrRefuseFull(turnId: string): Wait | undefined;
  /** Commit, arm and park on the wait, with the request's receipt. */
  open(wait: Wait): Wait;
  /** One registration per key at a time: a second caller joins the first and repeats its wait. */
  inFlight(key: string, timeoutSeconds: number, start: (signal: AbortSignal) => Promise<Wait>): Promise<Wait>;
}
/** Hooks use core wait values, so feature adapters need no private engine entry point. */
export interface WaitLifecycle {
  /** Start what resolves the wait. Built-in kinds run it at every arm and keep it idempotent;
   *  a plugin kind's runs once per watch. */
  arm?(context: WaitWatchContext): void;
  disarm?(context: WaitWatchContext): void;
  dispose?(): void;
  /** Replaces `arm` when the wait opens unsettled. */
  open?(context: WaitWatchContext): void;
  postOpen?(context: WaitWatchContext): void;
  openedEntry?(wait: Wait, waits: readonly Wait[]): Wait;
  /** Re-observe the wait's target now. True when the wait is no longer open. */
  reconcile?(context: WaitWatchContext): boolean;
  /** Arm again after a resolution whose checkpoint failed. */
  rearm?(context: WaitWatchContext, delay: number): void;
  /** Park only while the store still lists the wait: its open hook can settle it. */
  parkOnlyWhileListed?: boolean;
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
  /** A built-in row's `cezar_wait` handler, after the shared gate. */
  registerRequest?: (request: BuiltInSquawkWaitRequest, context: WaitRequestContext) => Wait | Promise<Wait>;
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

/** Validation failures are definite refusals, never unknown registration outcomes. */
export function parsePluginWaitRequest(row: WaitKindRow, request: unknown) {
  const parsed = row.inputSchema?.safeParse(request);
  if (!parsed?.success) throw Object.assign(new Error('Invalid plugin wait request'), { code: 'invalid_request' });
  return parsed.data;
}
