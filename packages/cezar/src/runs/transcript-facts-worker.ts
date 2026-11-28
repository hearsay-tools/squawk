/** Worker owns reads/decode/fold, and commits the sidecar a load rebuilt unless the index revoked it. */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { historyPaths } from './history-file.ts';
import { loadTranscriptFacts, type FactsLoadResult } from './transcript-facts-load.ts';
import { commitSidecar, RESULT_SLOT, type SidecarCommit } from './transcript-facts-sidecar.ts';

export interface FactsJobMessage {
  dataDir: string;
  runId: string;
  port: MessagePort;
  signal: SharedArrayBuffer;
  /** Commit the sidecar of a load that needs one. False for read-only indexes. */
  write: boolean;
}
export type FactsJobReply = { result: FactsLoadResult | undefined; sidecar?: SidecarCommit } | { error: string };

// Static dependencies have finished importing before this module body runs.
// Publish readiness before checking cancellation so either side owns shutdown.
const lifecycle = new Int32Array(workerData.lifecycle);
Atomics.store(lifecycle, 0, 1);
if (Atomics.load(lifecycle, 1) === 1) parentPort!.close();
else parentPort!.on('message', ({ dataDir, runId, port, signal, write }: FactsJobMessage) => {
  const slots = new Int32Array(signal);
  let reply: FactsJobReply;
  try {
    const result = loadTranscriptFacts(dataDir, runId);
    reply = { result, ...(write && result?.needsWrite
      ? { sidecar: commitSidecar(historyPaths(dataDir, runId).facts, JSON.stringify(result.facts), slots) } : {}) };
  } catch (error) {
    reply = { error: String(error) };
  }
  // Publication precedes notification: a blocking parent can consume this exact result.
  port.postMessage(reply);
  Atomics.store(slots, RESULT_SLOT, 1);
  Atomics.notify(slots, RESULT_SLOT);
  port.close();
});
