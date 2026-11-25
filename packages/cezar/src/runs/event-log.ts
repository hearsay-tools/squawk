/**
 * The event-log topic of the run store (hearsay-tools/squawk#4040): a run's NDJSON event log, its
 * sequence numbers, the live `run.event` fan-out and the reference markers an event carries.
 * `RunStore` keeps one of these as `store.eventLog`; the redaction it applies is `run-redaction.ts`.
 */
import { appendFileSync } from 'node:fs';
import { runPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import type { RunPullRequest } from '@open-mercato/cezar-contract';
import { defined } from '../core/defined.ts';
import { hasPlainHistory, historyPaths, readHistoryText, readHistoryTextAsync, restoreHistory } from './history-file.ts';
import type { LiveItemSnapshots } from './live-item-snapshots.ts';
import { snapshotRun, type RunLifecycle } from './lifecycle.ts';
import type { RunEventLog, RunMarkerRefs } from './ports.ts';
import { stagePullRequests } from './record-write-rules.ts';
import type { RunRedaction } from './run-redaction.ts';
import { originatingIssue, refUrlNumber, referencedPrDeclaration, resolveIssueReference, resolveReferencedRef, scanEventReferences, setReferencedIssueUrl } from './run-references.ts';
import type { RepoHandle, RunEvent, RunRecord } from './store.ts';
import { isRepoScopedRef, promptNamesRepo } from './task-refs.ts';
import type { RunTranscriptFacts } from './transcript-facts-topic.ts';

/** NDJSON transcript text to events; a damaged line is skipped, never fatal. */
function parseEvents(raw: string): RunEvent[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RunEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is RunEvent => e !== null);
}


/** What the topic asks of the store; no import of `store.ts` values. */
export interface RunEventLogState {
  readonly seqs: Map<string, number>;
  readonly published: RunLifecycle;
  readonly liveItems: LiveItemSnapshots;
  readonly transcriptFacts: RunTranscriptFacts;
  readonly redaction: RunRedaction;
  record(id: string): RunRecord | undefined;
  /** The error `appendEvent` throws for a run this store cannot write or does not know. */
  missingRunError(runId: string): Error;
  sourceDataDir(id: string): string;
  touch(run: RunRecord, before: Readonly<RunRecord> | undefined): void;
  change(id: string, apply: (run: RunRecord) => void): RunRecord | undefined;
  /** Read at call time: `setRepoHandle` replaces it after the store opens. */
  repoHandle(): RepoHandle | null | undefined;
  maybeEnqueueHistoryCompress(run: RunRecord): void;
}

export class RunEventLogTopic implements RunEventLog, RunMarkerRefs {
  constructor(private readonly dataDir: string, private readonly state: RunEventLogState) {}

  appendEvent(runId: string, event: { type: string; stepId?: string | undefined; [key: string]: unknown }): RunEvent {
    const run = this.state.record(runId);
    if (!run) {
      throw this.state.missingRunError(runId);
    }
    const seq = this.nextSeq(runId);
    // Scrub credentials before the event touches disk or the live wire (#427):
    // tool-result output is persisted verbatim and served back over the API, so
    // a secret in an agent's command output would otherwise land in `.ai/cezar/`.
    const full: RunEvent & { stepId?: string } = this.state.redaction.redact(defined({ ...event, seq, ts: new Date().toISOString() }));
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    if (!hasPlainHistory(this.dataDir, runId)) restoreHistory(this.dataDir, runId);
    const line = `${JSON.stringify(full)}\n`;
    appendFileSync(this.eventsPath(runId), line, 'utf8');
    this.state.transcriptFacts.index.append(runId, full, Buffer.byteLength(line));
    this.state.maybeEnqueueHistoryCompress(run);
    this.state.liveItems.observe(runId, full, false);
    this.state.published.publish('run.event', { runId, event: full });

    // Reference discovery runs last, after the event is persisted, indexed and
    // published: the janitor reads the event text and may still update the run.
    const before = snapshotRun(run);
    scanEventReferences(
      run, full, this.state.repoHandle(),
      (target, entries) => this.accumulatePullRequests(target, entries),
      (target) => this.state.touch(target, before),
    );
    return full;
  }

  /**
   * Apply agent-declared reference markers (spec 2026-07-18-task-ref-markers).
   * Marker values are authoritative for the display tier: they overwrite the
   * regex/namer numbers unless the prompt identifies the originating issue, and a declared PR re-resolves the referenced URL
   * against the candidate working set — including down to `undefined` when no
   * candidate matches (a wrong chip is worse than no chip). The created tier
   * (`pullRequestUrl`) is deliberately untouched.
   *
   * One declaration is NOT a statement about the referenced tier: the number of the PR this run
   * itself created. See `referencedPrDeclaration` — the marker contract asks the agent to
   * re-declare after it opens a PR, and taking that literally cost the task the PR it was about.
   */
  applyMarkerRefs(runId: string, refs: { pr?: number | undefined; prs?: readonly number[] | undefined; issue?: number | undefined }): RunRecord | undefined {
    if (refs.pr === undefined && refs.issue === undefined) return this.state.record(runId);
    return this.state.change(runId, (run) => {
      const repoHandle = this.state.repoHandle();
      const numbers = [...new Set([...(run.markerRefs?.pr === undefined ? [] : [run.markerRefs.pr]),
        ...(refs.prs ?? (refs.pr === undefined ? [] : [refs.pr]))])];
      if (numbers.length) this.accumulatePullRequests(run, numbers.flatMap((number) => {
        const matches = (run.referencedPrCandidates ?? []).filter((url) => refUrlNumber(url) === number &&
          (repoHandle ? isRepoScopedRef(url, run.task, repoHandle) : promptNamesRepo(url, run.task)));
        const url = matches.length === 1 ? matches[0] : matches.length === 0 && repoHandle
          ? `https://github.com/${repoHandle.owner}/${repoHandle.name}/pull/${number}` : undefined;
        const parsed = runPullRequestSchema.safeParse({ number, ...(url ? { url } : {}), source: 'declared' });
        return parsed.success ? [parsed.data] : [];
      }));
      run.markerRefs = {
        ...run.markerRefs,
        ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
        ...(refs.issue !== undefined ? { issue: refs.issue } : {}),
      };
      // `prNumber` is the about-PR as well (it is what paints a numeric-only chip), so a
      // re-declaration naming the created PR only FILLS it — it never overwrites the number the
      // task came in with, which is still the PR this task is about.
      if (refs.pr !== undefined && (run.prNumber === undefined || refs.pr !== refUrlNumber(run.pullRequestUrl))) {
        run.prNumber = refs.pr;
      }
      if (refs.issue !== undefined) {
        run.issueNumber = originatingIssue(run) ?? refs.issue;
        delete run.referencedIssueNumberSeeded;
      }
      if (run.markerRefs.pr !== undefined) {
        run.referencedPullRequestUrl = resolveReferencedRef(
          run.referencedPrCandidates ?? [],
          run.task,
          referencedPrDeclaration(run),
          repoHandle,
        );
      }
      if (run.markerRefs.issue !== undefined) {
        setReferencedIssueUrl(run, resolveIssueReference(run, repoHandle));
      }
    });
  }

  /** Authoritative creation keeps the first scalar for publishing, plus every created identity. */
  recordCreatedPr(runId: string, url: string): RunRecord | undefined {
    const run = this.state.record(runId);
    const parsed = runPullRequestSchema.safeParse({ number: refUrlNumber(url), url, source: 'created' });
    if (!run || !parsed.success) return run;
    const before = snapshotRun(run);
    let changed = this.accumulatePullRequests(run, [parsed.data]);
    if (!run.pullRequestUrl) { run.pullRequestUrl = url; changed = true; }
    if (changed) this.state.touch(run, before);
    return run;
  }
  private accumulatePullRequests(run: RunRecord, entries: readonly RunPullRequest[]): boolean {
    return stagePullRequests(run, entries, this.state.repoHandle());
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis. Finite polling coalesces active item content
   * into bounded in-memory snapshots on that clock; disk replay still has gaps
   * (dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = this.state.redaction.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() });
    this.state.liveItems.observe(runId, full, true);
    this.state.published.publish('run.event', { runId, event: full });
    return full;
  }

  hasProjection(runId: string, projectionId: string): boolean {
    return this.state.transcriptFacts.transcriptFacts(runId).projectionIds.includes(projectionId);
  }

  /** `readEvents` off the event loop (async read and async brotli), for collection paths. */
  async readEventsAsync(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readHistoryTextAsync(this.state.sourceDataDir(runId), runId);
      return raw === undefined ? [] : parseEvents(raw);
    } catch {
      return [];
    }
  }

  readEvents(runId: string): RunEvent[] {
    try {
      const raw = readHistoryText(this.state.sourceDataDir(runId), runId);
      if (raw === undefined) return [];
      return parseEvents(raw);
    } catch {
      return [];
    }
  }

  private nextSeq(runId: string): number {
    const next = (this.state.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.state.seqs.set(runId, next);
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    return this.state.transcriptFacts.transcriptFacts(runId).lastSeq;
  }

  private eventsPath(runId: string): string {
    return historyPaths(this.state.sourceDataDir(runId), runId).plain;
  }
}
