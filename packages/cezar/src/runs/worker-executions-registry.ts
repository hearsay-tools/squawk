import type { RunLifecycle } from './lifecycle.ts';
import type { WorkerExecutionRecords, WorkerExecutions, WorkerResults } from './ports.ts';
import type { RunRecord } from './store.ts';

/**
 * Where the store finds the worker execution, process and scope records (hearsay-tools/squawk#4039).
 * The code that reads and writes them belongs to the workers feature (`delegation/`), which the core
 * may not import (ADR 0065), so each process registers one factory before it opens a store: an
 * entry through `registerBuiltInRunSlots()` (`built-in-run-slots.ts`), a test through
 * `delegation/worker-executions.testkit.ts`. It is not a removal slot.
 *
 * Fail closed: the store builds its worker executions on first use, and with no factory registered
 * that first use throws an error that names the missing registration, before any side effect. So no
 * worker check of a deletion, a reclaim, an archive or an admission is skipped.
 */

/** What the worker executions get from the store they belong to. */
export interface WorkerExecutionsState {
  peek(id: string): RunRecord | undefined;
  getRun(id: string): RunRecord | undefined;
  writeDir(id: string): string;
  sourceDataDir(id: string): string;
  commitIndex(input: ReadonlyMap<string, RunRecord | null>): void;
  readonly published: RunLifecycle;
  readonly workerResults: WorkerResults;
}

export type WorkerExecutionsFactory = (dataDir: string, state: WorkerExecutionsState) => WorkerExecutions & WorkerExecutionRecords;

let registered: WorkerExecutionsFactory | undefined;

/** Register this process's factory. Registering the same factory again does nothing; another one throws. */
export function registerWorkerExecutions(factory: WorkerExecutionsFactory): void {
  if (registered && registered !== factory) throw new Error('A different worker-executions factory is already registered in this process.');
  registered = factory;
}

/** The registered factory. Throws when none is registered. */
export function workerExecutionsFactory(): WorkerExecutionsFactory {
  if (!registered) {
    throw new Error('No worker-executions factory is registered: call registerBuiltInRunSlots() from built-in-run-slots.ts at the process entry, '
      + 'or import delegation/worker-executions.testkit.ts in this test.');
  }
  return registered;
}

/** Whether this process registered a factory. Never throws. */
export function workerExecutionsRegistered(): boolean {
  return registered !== undefined;
}
