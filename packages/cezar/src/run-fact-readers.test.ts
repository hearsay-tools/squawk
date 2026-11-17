import { describe, expect, it } from 'vitest';
import { checkRule } from './lint/ast-rule.testkit.ts';
import type { AstRule, EsNode } from './lint/ast-rule.ts';
import { runFactReader, scanRunFacts } from './lint/run-fact-reader.ts';

/**
 * The scanner behind `cez/run-fact-reader` (hearsay-tools/cezarion#1496): run facts are read from
 * the contract. `npm run lint` applies it to the repository and checks the reader list for stale
 * entries; these cases pin what it finds and passes.
 */
describe('run facts are read from the contract (hearsay-tools/cezarion#1496)', () => {
  describe('the scan', () => {
    const rules = (source: string, file = 'packages/web/src/lib/x.ts') => {
      const expected = scanRunFacts(file, source).map(s => s.rule);
      const path = source.includes('<StatusDot') ? file.replace(/\.ts$/, '.tsx') : file;
      expect(checkRule(runFactReader, path, source).map(finding => finding.message.split(':')[0])).toEqual(expected);
      return expected;
    };

    it.each([
      ['an attention compared with ===', "if (attention.label === 'usage limit') go()"],
      ['an optional attention compared with !==', "if (row.attention?.label !== 'running') go()"],
      ['a derived attention', "const held = deriveAttention(run).label === 'usage limit'"],
      ['a derived attention of a call', "const held = deriveAttention(pick(run)).label.startsWith('waiting on ')"],
      ['a lower-cased label', "deriveAttention(run).label.toLowerCase() === id"],
      ['a literal on the left', "if ('needs you' === attention.label) go()"],
      ['a switch', 'switch (attention.label) {}'],
    ])('finds %s', (_name, source) => {
      expect(rules(source)).toEqual(['label-comparison']);
    });

    it.each([
      ['a label printed', 'const text = `Task ${deriveAttention(run).label}`'],
      ['a label in an attribute', '<StatusDot aria-label={attention.label} />'],
      ['a label asserted in a test', "expect(deriveAttention(run).label).toBe('needs you')"],
      ['another object\'s label', "if (bucket.label === 'Needs you') go()"],
      ['a rung compared', "if (attention.rung === 'usage-limit') go()"],
      ['a label compared inside a comment', "// attention.label === 'usage limit'"],
    ])('passes %s', (_name, source) => {
      expect(rules(source)).toEqual([]);
    });

    it.each([
      ['the hold', "if (run.status === 'waiting' && run.autoResumeAt !== undefined) go()"],
      ['its negation', "if (run.status !== 'waiting' || !run.autoResumeAt) return"],
      ['the time first', "const held = run.autoResumeAt !== undefined && run.status === 'waiting'"],
      ['a literal on the left', "const held = 'waiting' === run.status && run.autoResumeAt"],
      ['across lines', "const held = run.status === 'waiting' &&\n  run.autoResumeAt !== undefined"],
    ])('finds %s restated', (_name, source) => {
      expect(rules(source, 'packages/cezar/src/runs/store.ts')).toEqual(['restated-hold']);
    });

    it.each([
      ['the write rule', "if (run.status !== 'waiting') run.autoResumeAt = undefined;"],
      ['another status', "if (run.status === 'failed' && run.autoResumeAt !== undefined) heal()"],
      ['a status alone', "if (run.status === 'waiting' && run.waits) go()"],
      ['two statements', "if (run.status === 'waiting') go(); if (other || run.autoResumeAt) stop()"],
    ])('passes %s', (_name, source) => {
      expect(rules(source, 'packages/cezar/src/runs/store.ts')).toEqual([]);
    });

    it('keeps parenthesized and repeated unary negations visible to the hold check', () => {
      expect(rules("!(run.status === 'waiting') || !run.autoResumeAt;"))
        .toEqual(['restated-hold', 'resume-time-read']);
      expect(rules("!!(run.status === 'waiting') && run.autoResumeAt;"))
        .toEqual(['restated-hold', 'resume-time-read']);
      expect(rules("!(run.status === 'waiting') || items.some(item => { return item.autoResumeAt; });"))
        .toEqual(['resume-time-read']);
    });

    it('keeps callback bodies and object blocks outside the surrounding hold condition', () => {
      for (const source of [
        "const held = run.status === 'waiting' && items.some(item => { return item.autoResumeAt; });",
        "const held = run.status === 'waiting' && items.some(function (item) { return item.autoResumeAt; });",
        "const held = run.status === 'waiting' && ({ time: run.autoResumeAt });",
        "const held = run.status === 'waiting' && items.some(({ item }) => item.autoResumeAt);",
        "const held = run.status === 'waiting' && pick({}, run.autoResumeAt);",
      ]) expect(rules(source)).toEqual(['resume-time-read']);
      expect(rules("const held = run.status === 'waiting' && items.some(item => item.autoResumeAt);"))
        .toEqual(['restated-hold', 'resume-time-read']);
      expect(rules("const held = items.some(item => { return item.status === 'waiting' && item.autoResumeAt; });"))
        .toEqual(['restated-hold', 'resume-time-read']);
    });

    it('requires the complete resume access to fit inside the original lookahead window', () => {
      const condition = (length: number) => `const held = run.status === 'waiting' && ${'x'.repeat(length)} && run.autoResumeAt;`;
      expect(rules(condition(136))).toEqual(['restated-hold', 'resume-time-read']);
      expect(rules(condition(137))).toEqual(['resume-time-read']);
    });

    it('keeps the original nearby-access window across long logical chains', () => {
      const comparisons = Array.from({ length: 512 }, (_, index) => `runs[${index}].status === 'waiting'`);
      expect(rules(`const held = ${comparisons.join(' && ')} && run.autoResumeAt;`))
        .toEqual([...Array.from({ length: 5 }, () => 'restated-hold'), 'resume-time-read']);
    });

    it('keeps node reads linear when a chain of waiting comparisons doubles', () => {
      const readsFor = (length: number): number => {
        let reads = 0;
        const proxies = new WeakMap<EsNode, EsNode>();
        const wrap = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(wrap);
          if (!value || typeof value !== 'object' || !('type' in value)) return value;
          const node = value as EsNode;
          let proxy = proxies.get(node);
          if (!proxy) {
            proxy = new Proxy(node, { get(target, key) { reads++; return wrap(Reflect.get(target, key, target)); } });
            proxies.set(node, proxy);
          }
          return proxy;
        };
        const measured: AstRule = {
          ...runFactReader,
          create(report, context) {
            const visitors = runFactReader.create(report, context);
            return Object.fromEntries(Object.entries(visitors).map(([type, visit]) => [type, (node: EsNode) => visit(wrap(node) as EsNode)]));
          },
        };
        const comparisons = Array.from({ length }, (_, index) => `runs[${index}].status === 'waiting'`);
        checkRule(measured, 'packages/web/src/lib/x.ts', `const held = ${comparisons.join(' && ')} && run.autoResumeAt;`);
        return reads;
      };
      const small = readsFor(32);
      const large = readsFor(64);
      expect(small).toBeGreaterThan(0);
      expect(large).toBeLessThan(small * 3);
    });

    it('finds a resume time read in an unlisted source file, once per file', () => {
      expect(rules('const a = run.autoResumeAt; const b = run?.autoResumeAt')).toEqual(['resume-time-read']);
    });

    it('accepts an explicitly listed run module, but not another module', () => {
      const readers = { 'packages/cezar/src/workflows/run/timer.ts': 'owns the timer' };
      const source = 'const time = run.autoResumeAt';
      expect(scanRunFacts('packages/cezar/src/workflows/run/timer.ts', source, readers)).toEqual([]);
      expect(scanRunFacts('packages/cezar/src/workflows/run/other.ts', source, readers).map((s) => s.rule)).toEqual(['resume-time-read']);
    });

    it('passes a resume time in a listed file, a test, a fixture key and a comment', () => {
      expect(rules('const a = run.autoResumeAt', 'packages/web/src/lib/tasks-table.ts')).toEqual([]);
      expect(rules('const a = run.autoResumeAt', 'packages/web/src/lib/x.test.ts')).toEqual([]);
      expect(rules("const run = { autoResumeAt: '2026-10-25T00:00:00.000Z' }")).toEqual([]);
      expect(rules('// reads run.autoResumeAt')).toEqual([]);
    });

    it('lets a test outside the contract spell the hold as its oracle, but not compare a label', () => {
      expect(rules("until(() => run.status === 'waiting' && run.autoResumeAt !== undefined)", 'packages/cezar/src/workflows/x.test.ts')).toEqual([]);
      expect(rules("const needsYou = deriveAttention(run).label === 'needs you'", 'packages/cezar/src/workflows/x.test.ts')).toEqual(['label-comparison']);
    });

    it('lets the contract compare labels and spell the hold, as its definitions and oracles must', () => {
      expect(rules("if (run.status === 'waiting' && run.autoResumeAt !== undefined) go()", 'packages/contract/src/run-predicates.test.ts')).toEqual([]);
      expect(rules("deriveAttention(run).label === 'usage limit'", 'packages/contract/src/attention.test.ts')).toEqual([]);
    });
  });
});
