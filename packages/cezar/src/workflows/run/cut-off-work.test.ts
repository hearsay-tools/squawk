import { describe, expect, it } from 'vitest';
import { cutOffWork } from './cut-off-work.ts';

// hearsay-tools/squawk#3909: the resume after a restart names the work the restart cut off, from
// Squawk's own event log, the same on every runner.
const tool = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'item.updated', item: { kind: 'tool', id, name: 'Bash', toolKind: 'execute', title: `Ran ${id}`, status, ...extra } });
const turn = { type: 'turn.started', turnId: 't' };

describe('cutOffWork', () => {
  it('names the last turn\'s open root calls and every background subagent still running', () => {
    const events = [
      tool('old-agent', 'running', { name: 'Agent', title: 'Docs sweep', background: true }),
      tool('stale', 'running'),
      turn,
      tool('done', 'completed'),
      tool('prepr', 'running'),
      tool('child', 'running', { parentItemId: 'old-agent' }),
      tool('spawn', 'running', { name: 'Agent', title: 'Lint sweep' }),
      tool('spawn', 'running', { name: 'Agent', title: 'Lint sweep', background: true }),
    ];
    expect(cutOffWork(events)).toEqual({ tools: ['Bash: Ran prepr'], subagents: ['Agent: Docs sweep', 'Agent: Lint sweep'] });
  });

  it('names nothing when every call has its result', () => {
    expect(cutOffWork([turn, tool('a', 'completed'), tool('b', 'failed'), tool('c', 'running', { background: true }), tool('c', 'completed', { background: true })])).toBeUndefined();
  });

  it('caps the list and shortens a long title', () => {
    const many = Array.from({ length: 8 }, (_, i) => tool(`t${i}`, 'running'));
    expect(cutOffWork([turn, ...many])!.tools).toEqual(['Bash: Ran t0', 'Bash: Ran t1', 'Bash: Ran t2', 'Bash: Ran t3', 'Bash: Ran t4', '3 more']);
    const long = cutOffWork([turn, tool('x', 'running', { title: 'y'.repeat(300) })])!.tools![0]!;
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });
});
