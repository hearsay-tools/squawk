import { createListRegistry } from '../core/registry.ts';
import type { WorkerResults } from './ports.ts';
import type { RunRecord } from './store.ts';

/**
 * The removal slots (spec 2026-11-21-run-lifecycle-and-store-ports, "Removal slots"; owner decision
 * 2): the features that a run deletion, a worktree reclaim or a family archive must ask, as three
 * named slots in one process-wide registry. The core asks the registry and imports no feature. An
 * entry fills the registry with `registerBuiltInRunSlots()` (`built-in-run-slots.ts`) before the CLI
 * dispatch; a test seals it with only the slots it needs (`removal-slots.testkit.ts`).
 *
 * Fail closed: until the registry is sealed, every read throws an error that names the missing
 * registration, and each removal path reads it before its first side effect.
 */

/** What a deletion removes: a run's history, its worktree or worker resources, the agent tmp
 *  directory of an archived family member, or the agent tmp directory (scratch) of a run that ended
 *  or of an orphan the startup sweep found. */
export type DeletionKind = 'history' | 'worktree' | 'archive-tmp' | 'scratch';

/** Refuses a deletion while the feature still needs what it removes. */
export interface DeletionGate {
  readonly name: string;
  /** A reason refuses the deletion; undefined lets it go ahead. `dataDir` is the run's data dir. */
  refuse(runId: string, kind: DeletionKind, dataDir: string): string | undefined;
}

/** What a reclaim preparation gets from the reclaim: the repository and the store it reclaims in. */
export interface ReclaimContext {
  readonly repoRoot: string;
  /** The store the reclaim runs in, and the worker results it saves. */
  readonly store: { readonly workerResults: WorkerResults };
}

/** Work that must finish before a reclaimed worktree goes. A rejection stops the reclaim. */
export interface ReclaimPreparation {
  readonly name: string;
  prepare(run: RunRecord, context: ReclaimContext): Promise<void>;
}

/** Removes what a feature keeps for a run when the run's history goes. */
export interface RemovalCleanup {
  readonly name: string;
  removed(runId: string, dataDir: string): void;
}

export interface RunSlots {
  readonly gates?: readonly DeletionGate[] | undefined;
  readonly preparations?: readonly ReclaimPreparation[] | undefined;
  readonly cleanups?: readonly RemovalCleanup[] | undefined;
}

const options = { name: 'The removal slots', bootHint: 'call registerBuiltInRunSlots(), then sealBuiltInRunSlots().' };
const gates = createListRegistry<DeletionGate>(options);
const preparations = createListRegistry<ReclaimPreparation>(options);
const cleanups = createListRegistry<RemovalCleanup>(options);

function registerSlot<T>(registry: { register(slot: T): void }, slot: T): void {
  try { registry.register(slot); } catch (error) {
    if (runSlotsSealed()) throw new Error('The removal slots are sealed: register every slot before sealRunSlots().');
    throw error;
  }
}

/** Add slots, in call order. Registering the same slot object again does nothing. */
export function registerRunSlots(slots: RunSlots): void {
  for (const slot of slots.gates ?? []) registerSlot(gates, slot);
  for (const slot of slots.preparations ?? []) registerSlot(preparations, slot);
  for (const slot of slots.cleanups ?? []) registerSlot(cleanups, slot);
}

/** Close the registry: removals may run, and no new slot may register. */
export function sealRunSlots(): void {
  gates.seal();
  preparations.seal();
  cleanups.seal();
}

/** Whether this process sealed its removal slots. Never throws. */
export function runSlotsSealed(): boolean {
  return gates.isSealed();
}

/** Throws unless the registry is sealed. A removal path calls it before its first side effect. */
export function assertRunSlotsSealed(): void {
  if (!runSlotsSealed()) {
    throw new Error('No removal slot is registered: call registerBuiltInRunSlots() then sealBuiltInRunSlots() from built-in-run-slots.ts at the process entry, '
      + 'or seal the slots this test uses with sealTestRunSlots() from runs/removal-slots.testkit.ts.');
  }
}

/** The first gate's reason to refuse this deletion, in registration order. */
export function deletionRefusal(runId: string, kind: DeletionKind, dataDir: string): string | undefined {
  assertRunSlotsSealed();
  for (const gate of gates.values()) {
    const reason = gate.refuse(runId, kind, dataDir);
    if (reason) return reason;
  }
  return undefined;
}

/** Run every preparation in registration order; the first rejection stops the rest. */
export async function prepareReclaim(run: RunRecord, context: ReclaimContext): Promise<void> {
  assertRunSlotsSealed();
  for (const preparation of preparations.values()) await preparation.prepare(run, context);
}

/** Run every cleanup in registration order, then throw the first failure. */
export function runRemovalCleanups(runId: string, dataDir: string): void {
  assertRunSlotsSealed();
  const failures: unknown[] = [];
  for (const cleanup of cleanups.values()) {
    try { cleanup.removed(runId, dataDir); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}
