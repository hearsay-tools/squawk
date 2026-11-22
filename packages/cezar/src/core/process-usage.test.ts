import { describe, expect, it } from 'vitest';

import { buildProcessIndex, aggregateIndexedTreeUsage, aggregateTreeUsage, parsePsOutput, registerRunProcess,
  replaceRunProcess, recordUsageSampleForTest, unregisterRunProcess } from './process-usage.ts';

describe('run process replacement', () => {
  it('keeps the peak when the session replaces its backend process', () => {
    const runId = 'replacement-peak';
    try {
      registerRunProcess(runId, 123);
      recordUsageSampleForTest(runId, { cpuPct: 1, rssBytes: 30_000, procCount: 4 });
      replaceRunProcess(runId, 456);
      recordUsageSampleForTest(runId, { cpuPct: 1, rssBytes: 10_000, procCount: 1 });
      expect(unregisterRunProcess(runId)).toEqual({ peakRssBytes: 30_000, peakProcCount: 4 });
    } finally {
      unregisterRunProcess(runId);
    }
  });
});

describe('parsePsOutput', () => {
  it('parses the unix `ps` shape (pid ppid rssKb cpu)', () => {
    const rows = parsePsOutput('  100   1  20480  3.5\n  101 100  10240  1.0\n');
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssKb: 20480, cpuPct: 3.5 },
      { pid: 101, ppid: 100, rssKb: 10240, cpuPct: 1.0 },
    ]);
  });

  it('parses the Windows PowerShell shape (pid ppid rssKb 0) — same columns, cpu 0', () => {
    // Get-CimInstance Win32_Process emits "PID PPID WorkingSetKB 0".
    const rows = parsePsOutput('4321 4000 51200 0\n4400 4321 12000 0\n');
    expect(rows.map((r) => [r.pid, r.ppid, r.rssKb])).toEqual([
      [4321, 4000, 51200],
      [4400, 4321, 12000],
    ]);
    expect(rows.every((r) => r.cpuPct === 0)).toBe(true);
  });

  it('skips malformed / truncated rows', () => {
    expect(parsePsOutput('garbage\n100 1\n200 1 4096 2.0')).toEqual([
      { pid: 200, ppid: 1, rssKb: 4096, cpuPct: 2.0 },
    ]);
  });
});

describe('aggregateTreeUsage', () => {
  const procs = parsePsOutput(
    ['500 1 100000 10', '501 500 50000 5', '502 501 25000 2', '900 1 999999 99'].join('\n'),
  );

  it('reuses one snapshot index across roots, including missing roots and cycles', () => {
    const rows = [...procs, { pid: 1, ppid: 502, rssKb: 10, cpuPct: 0 }];
    const index = buildProcessIndex(rows);
    for (const root of [500, 501, 900, 12345]) {
      expect(aggregateIndexedTreeUsage(index, root)).toEqual(aggregateTreeUsage(rows, root));
    }
    expect(aggregateIndexedTreeUsage(index, 500)?.procCount).toBe(5);
  });

  it('sums RSS over the whole descendant tree, in bytes', () => {
    const usage = aggregateTreeUsage(procs, 500);
    // (100000 + 50000 + 25000) KB * 1024
    expect(usage?.rssBytes).toBe(175000 * 1024);
    expect(usage?.procCount).toBe(3);
  });

  it('returns null when the root pid is gone (no data, not zero)', () => {
    expect(aggregateTreeUsage(procs, 12345)).toBeNull();
  });

});
