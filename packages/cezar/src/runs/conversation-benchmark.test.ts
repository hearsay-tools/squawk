import { expect, it } from 'vitest';
import { formatConversationTable, measureConversationLookup, parseConversationBenchArgs } from '../../scripts/benchmark-conversation-lookup.ts';

/** Smoke test for the conversation lookup benchmark: its fixture is what the real store opens, and
 *  the lookup finds exactly the roots that name the target. */
it('seeds root conversations and finds the two roots that name the target', async () => {
  const row = await measureConversationLookup({ roots: 9, conversationShare: 0.5, messages: 3, rootKb: 1, passes: 1 });
  expect(row).toMatchObject({ roots: 9, conversations: 5, awaiting: 2 });
});

it('reports the conversations it seeded when every root but the target talks', async () => {
  const row = await measureConversationLookup({ roots: 4, conversationShare: 1, messages: 1, rootKb: 1, passes: 1 });
  expect(row).toMatchObject({ roots: 4, conversations: 3 });
});

it('reads its settings from the command line and refuses ones it cannot use', () => {
  expect(parseConversationBenchArgs([])).toEqual({ sizes: [100, 1000, 3000], out: undefined,
    base: { conversationShare: 0.33, messages: 40, rootKb: 300, passes: 5 } });
  expect(parseConversationBenchArgs(['--roots', '5,10', '--passes', '1', '--out', 'r.json'])).toMatchObject({ sizes: [5, 10], out: 'r.json', base: { passes: 1 } });
  for (const args of [['--roots', '1'], ['--roots', '2.5'], ['--conversation-share', '2'], ['--messages', '0'], ['--messages', '1.5'], ['--passes', '0'], ['--passes', 'Infinity']]) {
    expect(() => parseConversationBenchArgs(args), args.join(' ')).toThrow('--roots takes whole numbers');
  }
});

it('prints one table row per size', () => {
  const { base } = parseConversationBenchArgs([]);
  const table = formatConversationTable(base, [{ roots: 3000, conversations: 990, awaiting: 2, lookupMs: 3, listMs: 3 }]).split('\n');
  expect(table[0]).toMatch(/^root 300 KB, 0.33 with a conversation of 40 messages, median of 5 calls/);
  expect(table.at(-1)).toBe('| 3000 | 990 | 2 | 3 | 3 |');
});
