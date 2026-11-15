/** What the run-store benchmarks share: a temporary project seeded with the store's own rows. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBenchmarkEnv } from './benchmark-home.ts';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';
import { seedRuns } from '../src/runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../src/runs/store.ts';

// The store reaches the worker ownership policy, which needs the host's identity store (ADR 0032).
installWindowsIdentityStore();

/** A fixed timestamp `minute` minutes after the fixtures' epoch. */
export const benchAt = (minute: number) => new Date(Date.UTC(2026, 9, 1) + minute * 60_000).toISOString();
export const median = (samples: readonly number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

/** Seed a temporary project with `records(root)`, open its store as `serve` does, run `measure`,
 *  then close the store and remove the project. */
export async function withSeededStore<T>(prefix: string, records: (root: string) => RunRecord[], measure: (store: RunStore, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const dataDir = join(root, '.ai/cezar');
    seedRuns(dataDir, records(root));
    const store = RunStore.open(dataDir, { keepLive: true });
    try { return await measure(store, root); } finally { store.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A benchmark's command-line run: one row per size in a sandboxed home, the table on stdout and
 *  the rows as JSON in `out`. */
export async function runSizes<Row>(sizes: readonly number[], out: string | undefined, measure: (size: number) => Promise<Row>, format: (rows: readonly Row[]) => string): Promise<void> {
  const ownHome = prepareBenchmarkEnv();
  try {
    const rows: Row[] = [];
    for (const size of sizes) rows.push(await measure(size));
    console.log(format(rows));
    if (out) writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
  } finally {
    if (ownHome) rmSync(ownHome, { recursive: true, force: true });
  }
}
