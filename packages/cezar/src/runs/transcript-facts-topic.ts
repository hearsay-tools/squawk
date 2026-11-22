/**
 * The transcript facts topic of the run store (hearsay-tools/squawk#4036): what the transcript
 * says about a run, answered from `TranscriptFactsIndex` and never from a transcript read once a
 * run's index is loaded. `RunStore` keeps one of these as `store.transcriptFacts`; it holds the
 * main index, the read-only index of the fallback source, and the open-time warm-up.
 */
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { TranscriptFactsPort } from './ports.ts';
import { familyRootOf, isLiveRecord } from './run-row.ts';
import { emptyFacts, TranscriptFactsIndex, type TranscriptFacts } from './transcript-facts.ts';

/** Runs (and conversation roots, one family query each) the open-time facts warm-up enumerates
 *  per event-loop turn (hearsay-tools/cezarion#949), so each slice stays a few milliseconds. */
const WARM_IDS_PER_SLICE = 100;

/** What the topic asks of the store; no import of `store.ts`. */
export interface TranscriptFactsState {
  isFallbackRun(id: string): boolean;
  sourceDataDir(id: string): string;
  /** Whether the database is open. */
  isOpen(): boolean;
  readonly held: ReadonlyMap<string, RunRecord>;
  listFamilyRunIds(rootId: string): string[];
  listConversationRootIds(): string[];
  listRunIds(): string[];
}

export class RunTranscriptFacts implements TranscriptFactsPort {
  /** Transcript facts the delegation paths ask about, so they never re-read a transcript (#880). */
  readonly index: TranscriptFactsIndex;
  private fallbackFacts: TranscriptFactsIndex | undefined;
  private factsWarming: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly state: TranscriptFactsState) {
    this.index = new TranscriptFactsIndex(dataDir);
  }

  factsFor(id: string): TranscriptFactsIndex { return this.state.isFallbackRun(id) ? this.fallbackFacts ??= new TranscriptFactsIndex(this.state.sourceDataDir(id), true) : this.index; }

  /** The run's indexed transcript facts (#880): a read-only view, never a transcript read once
   *  the run's index is loaded. An unreadable transcript answers as empty, as readEvents does. */
  transcriptFacts(runId: string): Readonly<TranscriptFacts> {
    return this.factsFor(runId).get(runId) ?? emptyFacts();
  }

  /** The run's transcript facts when they are known: undefined when the transcript exists but its
   *  facts are not current or cannot be read, so a caller can tell "no ask" from "no evidence". */
  knownTranscriptFacts(runId: string): Readonly<TranscriptFacts> | undefined {
    return this.factsFor(runId).peek(runId);
  }

  private recoveryFactIds(familyRootId?: string): string[] {
    if (familyRootId !== undefined) return this.state.listFamilyRunIds(familyRootId);
    const ids = new Set<string>();
    for (const [id, run] of this.state.held) {
      if (!isLiveRecord(run)) continue;
      const root = familyRootOf(run);
      for (const member of root === undefined ? [id] : this.state.listFamilyRunIds(root)) ids.add(member);
    }
    return [...ids];
  }

  /** Readiness owns no run snapshot across an await: refresh only the currently held owner. */
  async prepareTranscriptFacts(runIds: Iterable<string>): Promise<void> {
    for (const id of new Set(runIds)) {
      // Exact sidecars resolve immediately too: recovery must yield to timers/I/O between IDs.
      await new Promise<void>(resolve => setImmediate(resolve));
      await this.factsFor(id).ready(id);
    }
  }

  prepareRecoveryFacts(familyRootId?: string): Promise<void> {
    return this.prepareTranscriptFacts(this.recoveryFactIds(familyRootId));
  }

  /** Register IDs only here; the index yields between cache reads and off-loop rebuilds. */
  warmTranscriptFacts(): void {
    this.factsWarming = Promise.resolve().then(async () => {
      if (!this.state.isOpen()) return;
      const ids = new Set(this.recoveryFactIds());
      // hearsay-tools/cezarion#949: this microtask ends open()'s synchronous slice, and on a
      // large history the JSON scan for conversation roots plus one family query per root cost
      // as much again. Past one slice's worth of runs, yield before the scan and between root
      // batches; a small store (every unit test) still registers in this one microtask.
      const large = this.state.listRunIds().length > WARM_IDS_PER_SLICE;
      const turn = async (): Promise<boolean> => {
        await new Promise<void>(resolve => setImmediate(resolve));
        return this.state.isOpen();
      };
      if (large && !await turn()) return;
      const roots = this.state.listConversationRootIds();
      for (let i = 0; i < roots.length; i++) {
        if (large && i > 0 && i % WARM_IDS_PER_SLICE === 0 && !await turn()) return;
        for (const id of this.state.listFamilyRunIds(roots[i]!)) ids.add(id);
      }
      if (large && !await turn()) return;
      // Re-list after the yields: a run deleted meanwhile must not be registered again.
      const present = this.state.listRunIds();
      if (large) {
        const live = new Set(present);
        for (const id of ids) if (!live.has(id)) ids.delete(id);
      }
      for (const id of present) ids.add(id);
      await this.index.warm(ids);
    }).catch(() => undefined);
  }

  /** Resolves when the open-time warm-up is done (tests). */
  factsWarmIdle(): Promise<void> {
    return this.factsWarming;
  }

  /** The store closes: stop the fallback index and the main one, then write what the main one holds. */
  stop(): void {
    this.fallbackFacts?.stop();
    this.index.stop();
    this.index.flush();
  }
}
