/**
 * Conversation lookup benchmark: what it costs to find the root tasks whose conversation names a
 * run. Every read of a root task with workers asks it through the completion gate
 * (`openCompletionRequests` → `rootsAwaitingPeer`), and so does every settled root, on the event
 * loop. Run it unchanged before and after a change to how the store answers that question.
 *
 *   npm run bench:conversation-lookup -w @wjarka/cezarion
 *   node --import tsx packages/cezar/scripts/benchmark-conversation-lookup.ts --roots 100,1000,3000
 *
 * Flags: --roots (100,1000,3000) --conversation-share (0.33) --messages (40) --root-kb (300)
 * --passes (5) --out (a JSON file for the result rows).
 *
 * Method:
 * - Each size seeds one project's `runs.db` with the store's own row encoding: `--roots` archived
 *   `done` root tasks of about `--root-kb` each, a `--conversation-share` of them carrying a
 *   conversation of `--messages` peer messages with other roots. The defaults follow a busy local
 *   project: 1,332 roots, 438 of them with a conversation, 19,178 messages in all.
 * - The store is opened as `serve` opens it. A lookup is `rootsAwaitingPeer` for one root that
 *   two other roots name, and `listConversationRootIds()` is the unnamed list recovery reads.
 * - Times are the median of `--passes` calls, after one warm-up call.
 */
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { benchAt as at, median, runSizes, withSeededStore } from './benchmark-store-fixture.ts';
import { rootsAwaitingPeer } from '../src/delegation/conversations.ts';
import type { RunRecord } from '../src/runs/store.ts';

export interface ConversationBenchOptions { roots: number; conversationShare: number; messages: number; rootKb: number; passes: number }
export interface ConversationBenchRow { roots: number; conversations: number; awaiting: number; lookupMs: number; listMs: number }

/** The roots, and the one root (`target`) that two conversations send an open request to: a
 *  lookup finds a few roots among many conversations, as a real one does. */
function records(options: ConversationBenchOptions): { rows: RunRecord[]; target: string; conversations: number } {
  const ids = Array.from({ length: options.roots }, () => randomUUID());
  const target = ids[0]!, task = 'x'.repeat(options.rootKb * 1024);
  // Root 0 is the target, so at most every other root talks.
  const talking = Math.min(Math.round(options.roots * options.conversationShare), options.roots - 1);
  const rows = ids.map((id, index) => {
    const messages: ConversationMessage[] = index > 0 && index <= talking ? Array.from({ length: options.messages }, (_, n) => ({
      id: randomUUID(), senderRunId: id, recipientRunId: n === 0 && index <= 2 ? target : ids[1 + ((index + n) % (ids.length - 1))]!, kind: 'request', relationship: 'peer',
      text: `message ${n}`, createdAt: at(index), requestHash: 'a'.repeat(64), state: 'accepted',
    })) : [];
    return makeRunRecord({ id, status: 'done', archived: true, task, createdAt: at(index), finishedAt: at(index + 1),
      delegation: { role: 'root', permissions: ['spawn'], receipts: [], ...(messages.length ? { conversation: { messages, outcomes: [] } } : {}) } });
  });
  return { rows, target, conversations: talking };
}

/** Seed one temporary project, open its store and time the two lookups. */
export async function measureConversationLookup(options: ConversationBenchOptions): Promise<ConversationBenchRow> {
  const { rows, target, conversations } = records(options);
  return withSeededStore('cez-bench-conversations-', () => rows, async (store) => {
    const time = (call: () => unknown) => { const t = performance.now(); call(); return performance.now() - t; };
    const awaiting = rootsAwaitingPeer(store, target).length;
    store.listConversationRootIds();
    const lookupMs: number[] = [], listMs: number[] = [];
    for (let i = 0; i < options.passes; i++) {
      lookupMs.push(time(() => rootsAwaitingPeer(store, target)));
      listMs.push(time(() => store.listConversationRootIds()));
    }
    return { roots: options.roots, conversations, awaiting,
      lookupMs: Math.round(median(lookupMs)), listMs: Math.round(median(listMs)) };
  });
}

export interface ConversationBenchArgs { sizes: number[]; base: Omit<ConversationBenchOptions, 'roots'>; out: string | undefined }

/** The command line as one run's settings; throws on a size or count it cannot use. */
export function parseConversationBenchArgs(args: string[]): ConversationBenchArgs {
  const { values } = parseArgs({ args, options: {
    roots: { type: 'string', default: '100,1000,3000' },
    'conversation-share': { type: 'string', default: '0.33' },
    messages: { type: 'string', default: '40' },
    'root-kb': { type: 'string', default: '300' },
    passes: { type: 'string', default: '5' },
    out: { type: 'string' },
  } });
  const sizes = values.roots.split(',').map(Number);
  const base = { conversationShare: Number(values['conversation-share']), messages: Number(values.messages), rootKb: Number(values['root-kb']), passes: Number(values.passes) };
  if (sizes.some(size => !Number.isInteger(size) || size < 2) || !(base.conversationShare >= 0 && base.conversationShare <= 1) || !(Number.isInteger(base.messages) && base.messages >= 1) || !(Number.isInteger(base.passes) && base.passes >= 1)) {
    throw new Error('--roots takes whole numbers >= 2; --conversation-share takes 0 to 1; --messages and --passes take whole numbers >= 1');
  }
  return { sizes, base, out: values.out };
}

/** The result as a Markdown table under one line naming the settings and the host. */
export function formatConversationTable(base: ConversationBenchArgs['base'], rows: readonly ConversationBenchRow[]): string {
  return [
    `root ${base.rootKb} KB, ${base.conversationShare} with a conversation of ${base.messages} messages, median of ${base.passes} calls, ${cpus().length} cores, Node ${process.version}`,
    '| roots | with a conversation | awaiting the target | rootsAwaitingPeer ms | listConversationRootIds ms |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.roots} | ${row.conversations} | ${row.awaiting} | ${row.lookupMs} | ${row.listMs} |`),
  ].join('\n');
}

async function main(): Promise<void> {
  const { sizes, base, out } = parseConversationBenchArgs(process.argv.slice(2));
  await runSizes(sizes, out, roots => measureConversationLookup({ ...base, roots }), rows => formatConversationTable(base, rows));
}

if (import.meta.main) await main();
