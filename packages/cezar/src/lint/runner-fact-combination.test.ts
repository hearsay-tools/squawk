import { checkRule, ruleCases, spanError } from './ast-rule.testkit.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBINATION_ROWS, combinationFindings, declaredFactKeys, factCombinations as sourceCombinations, runnerFactCombination } from './runner-fact-combination.ts';
import { repoRoot } from './source-rule.ts';

function factCombinations(source: string, keys?: Set<string>): ReturnType<typeof sourceCombinations> {
  const combinations = sourceCombinations(source, keys);
  if (!keys) {
    const findings = checkRule(runnerFactCombination, 'packages/cezar/src/workflows/ast-fixture.ts', source);
    expect(findings.map(finding => ({
      name: finding.message.split(' touches a runner fact source')[0],
      line: finding.line,
      facts: finding.message.split(' and reads ')[1]!.split('. Shared parity')[0]!.split(' and '),
    }))).toEqual(combinations);
  }
  return combinations;
}

describe('runner-fact-combination (hearsay-tools/cezarion#2991)', () => {
  it.each([
    ['a row fact and the resume prompt', "function f(runner, id) { return runner.systemPromptOnResume === 'resent' && RUNNER_FACTS[id].nativeAsk === 'none'; }", 'f', ['nativeAsk', 'systemPromptOnResume']],
    ['two delivery fields', "const g = (state, runner) => state.inputState.inputDelivery?.consumption === 'observable' && inputDeliveryOf(runner).mode === 'steer';", 'g', ['consumption', 'mode']],
    ['a fact in a nested callback', "class A { settle(runner) { if (runner.facts.costReport === 'cumulative') return list.filter(x => x.inputDelivery.acknowledgement === 'write'); } }", 'A>settle', ['acknowledgement', 'costReport']],
    ['destructured facts', "function h(id) { const { nativeAsk, nativeTimerTool } = RUNNER_FACTS[id]; return nativeAsk && nativeTimerTool; }", 'h', ['nativeAsk', 'nativeTimerTool']],
    ['a private method', "class B { #pick(id, runner) { return RUNNER_FACTS[id]?.nativeSubagents ?? inputDeliveryOf(runner).humanInputAtTurnEnd; } }", 'B>#pick', ['humanInputAtTurnEnd', 'nativeSubagents']],
  ])('names a function that reads %s', (_case, source, name, facts) => {
    expect(factCombinations(source)).toEqual([{ name, line: 1, facts }]);
  });

  it.each([
    ['one fact twice', "function f(id, other) { return RUNNER_FACTS[id].costReport === RUNNER_FACTS[other].costReport; }"],
    ['one fact per function', "const a = runner => runner.systemPromptOnResume;\nconst b = id => RUNNER_FACTS[id].nativeAsk;"],
    ['a same-named key that is no fact', "function f(state) { return { nativeAsk: !!state.ask, mode: state.mode, costReport: x.costReport }; }"],
    ['the whole delivery and the documentation field', "function f(state, runner) { state.declare(inputDeliveryOf(runner)); return runner.inputDelivery.via; }"],
  ])('passes %s', (_case, source) => {
    expect(factCombinations(source)).toEqual([]);
  });

  // Each way a function can hold a fact source in a local, then read two facts from it.
  it.each([
    ['a const bound to .inputDelivery', "function f(runner) { const d = runner.inputDelivery; return d.mode === 'steer' && d.humanInputAtTurnEnd === 'always-held'; }",
      ['humanInputAtTurnEnd', 'mode']],
    ['a const bound to inputDeliveryOf(…)', 'function f(runner) { const d = inputDeliveryOf(runner); return d.mode && d.acknowledgement; }',
      ['acknowledgement', 'mode']],
    ['a let assigned later', 'function f(runner) { let d; d = inputDeliveryOf(runner); return d.mode && d.consumption; }',
      ['consumption', 'mode']],
    ['a const bound to RUNNER_FACTS[x]', 'function f(id) { const row = RUNNER_FACTS[id]; return row.nativeAsk && row.costReport; }', ['costReport', 'nativeAsk']],
    ['a const bound to RUNNER_FACTS.x', 'function f() { const row = RUNNER_FACTS.claude; return row.nativeTimerTool && row.nativeSubagents; }',
      ['nativeSubagents', 'nativeTimerTool']],
    ['a const bound to .facts', 'function f(runner) { const facts = runner.facts; return facts.nativeAsk && facts.costReport; }', ['costReport', 'nativeAsk']],
    ['a delivery read off a row alias', 'function f(id) { const row = RUNNER_FACTS[id]; const d = row.inputDelivery; return d.mode && row.nativeAsk; }',
      ['mode', 'nativeAsk']],
    ['an alias of an alias', 'function f(runner) { const d = runner.inputDelivery; const e = d; return e.mode && e.acknowledgement; }',
      ['acknowledgement', 'mode']],
    ['optional chaining through an alias', "function f(state) { const d = state.inputDelivery; return d?.mode === 'steer' && d?.consumption === 'observable'; }",
      ['consumption', 'mode']],
    ['a cast or non-null alias', 'function f(runner) { const d = runner.inputDelivery as InputDelivery; return d!.mode && (d).consumption; }',
      ['consumption', 'mode']],
    ['a runner destructured to its delivery and resume prompt', 'function f(runner) { const { inputDelivery, systemPromptOnResume } = runner; return inputDelivery.mode && systemPromptOnResume; }',
      ['mode', 'systemPromptOnResume']],
    ['a runner destructured to nested delivery fields', 'function f(runner) { const { inputDelivery: { mode, acknowledgement } } = runner; return mode && acknowledgement; }',
      ['acknowledgement', 'mode']],
    ['a runner destructured to a renamed fact row', 'function f(runner) { const { facts: row } = runner; return row.nativeAsk && row.costReport; }', ['costReport', 'nativeAsk']],
    ['a delivery alias destructured', 'function f(runner) { const d = runner.inputDelivery; const { mode, humanInputAtTurnEnd } = d; return mode && humanInputAtTurnEnd; }',
      ['humanInputAtTurnEnd', 'mode']],
    ['a destructuring assignment', 'function f(runner) { let mode, consumption; ({ mode, consumption } = inputDeliveryOf(runner)); return mode && consumption; }',
      ['consumption', 'mode']],
    ['a destructured parameter', 'function f({ inputDelivery }) { return inputDelivery.mode && inputDelivery.consumption; }',
      ['consumption', 'mode']],
  ])('names a function that reads two facts through %s', (_case, source, facts) => {
    expect(factCombinations(source)).toEqual([{ name: 'f', line: 1, facts }]);
  });

  it.each([
    ['one fact read twice through aliases', 'function f(a, b) { const d = a.inputDelivery; const e = b.inputDelivery; return d.mode === e.mode; }'],
    ['one fact on two runners', 'function f(a, b) { const x = RUNNER_FACTS[a]; const y = RUNNER_FACTS[b]; return x.costReport === y.costReport; }'],
    ['same-named fields of another object', 'function f(options) { const { mode, consumption, nativeAsk } = options; return mode && consumption && nativeAsk; }'],
  ])('passes %s', (_case, source) => {
    expect(factCombinations(source)).toEqual([]);
  });

  // Review round 2 bypasses of value tracking: the rule now tracks no value, so each is flagged.
  it.each([
    ['a source chosen by ??', "function f(state, runner) { const d = state.inputState.inputDelivery ?? inputDeliveryOf(runner); return d.acknowledgement === 'response' && d.humanInputAtTurnEnd === 'held-when-late'; }",
      ['acknowledgement', 'humanInputAtTurnEnd']],
    ['a source chosen by a ternary', 'function f(runner, other, c) { const d = c ? runner.inputDelivery : other.inputDelivery; return d.mode && d.consumption; }', ['consumption', 'mode']],
    ['a name a block shadows', 'function f(runner, x) { const d = runner.inputDelivery; if (x) { const d = 1; void d; } return d.mode && d.consumption; }', ['consumption', 'mode']],
    ['a conditional reassignment', 'function f(runner, options, c) { let d = runner.inputDelivery; if (c) d = options; return d.mode && d.consumption; }', ['consumption', 'mode']],
    ['rest destructuring', 'function f(runner) { const { inputDelivery: { ...d } } = runner; return d.mode && d.acknowledgement; }', ['acknowledgement', 'mode']],
    ['a parameter default', 'function f(runner, d = runner.inputDelivery) { return d.mode && d.consumption; }', ['consumption', 'mode']],
    ['a value typed InputDelivery', 'function f(d: InputDelivery) { return d.mode && d.consumption; }', ['consumption', 'mode']],
    ['a value typed RunnerFacts', 'function f(row: Readonly<RunnerFacts>) { return row.nativeAsk && row.costReport; }', ['costReport', 'nativeAsk']],
  ])('names a function that reads two facts through %s', (_case, source, facts) => {
    expect(factCombinations(source)).toEqual([{ name: 'f', line: 1, facts }]);
  });

  // The over-approximation: a fact source anywhere plus two fact keys from any object.
  it.each([
    ['a module-level source with a shadowing parameter', 'const d = runner.inputDelivery;\nfunction f(d) { return d.mode && d.consumption; }', ['consumption', 'mode'], 2],
    ['a local reassigned to another value', 'function f(runner, options) { let d = runner.inputDelivery; d = options; return d.mode && d.consumption; }', ['consumption', 'mode'], 1],
    ['an unrelated object with a same-named key', "function f(runner, options) { const resent = runner.systemPromptOnResume === 'resent'; return resent && options.mode === 'fast'; }",
      ['mode', 'systemPromptOnResume'], 1],
    ['a source in one callback and keys in another', 'function f(ids, list) { ids.map(id => RUNNER_FACTS[id]); return list.filter(x => x.mode).map(x => x.costReport); }', ['costReport', 'mode'], 1],
  ] as const)('flags %s, by design', (_case, source, facts, line) => {
    expect(factCombinations(source)).toEqual([{ name: 'f', line, facts }]);
  });

  // Review round 3: renamed and module-level sources, and static computed keys.
  it.each([
    ['a renamed type import', "import type { InputDelivery as InputDeliveryPolicy } from '../../core/agent-runner.ts';\nfunction f(d: InputDeliveryPolicy) { return d.mode && d.consumption; }",
      ['consumption', 'mode']],
    ['a renamed value import', "import { RUNNER_FACTS as table } from '../../core/runner-facts.ts';\nfunction f(id) { const row = table[id]; return row.nativeAsk && row.costReport; }",
      ['costReport', 'nativeAsk']],
    ['a renamed inputDeliveryOf import', "import { inputDeliveryOf as deliveryOf } from '../../core/agent-runner.ts';\nfunction f(runner) { const d = deliveryOf(runner); return d.mode && d.acknowledgement; }",
      ['acknowledgement', 'mode']],
    ['a local alias of the type', 'type Policy = Readonly<InputDelivery>;\nfunction f(d: Policy) { return d.mode && d.humanInputAtTurnEnd; }', ['humanInputAtTurnEnd', 'mode']],
    ['a module-level captured value', 'const d = RUNNER_FACTS.codex.inputDelivery;\nfunction f() { return d.mode && d.acknowledgement; }', ['acknowledgement', 'mode']],
    ['template and string computed keys', "function f(runner) {\n  const d = runner.inputDelivery; return d[`mode`] && d['consumption'];\n}", ['consumption', 'mode']],
  ] as const)('names a function that reads two facts through %s', (_case, source, facts) => {
    expect(factCombinations(source)).toEqual([{ name: 'f', line: source.split('\n').findIndex(line => line.includes('function f')) + 1, facts }]);
  });

  it('lets a reported function pass only through an exception, which names its reason', () => {
    const source = "function f(runner, options) { return runner.systemPromptOnResume === 'resent' && options.mode === 'fast'; }";
    const file = 'packages/cezar/src/workflows/run/x.ts';
    expect(combinationFindings(file, source, {})).toEqual([{ line: 1, message: expect.stringMatching(/^f touches a runner fact source and reads mode and systemPromptOnResume\. .*COMBINATION_ROWS/) }]);
    expect(combinationFindings(file, source, { [`${file}#f`]: { reason: 'options.mode is the CLI mode, not a delivery mode' } })).toEqual([]);
    expect(combinationFindings(file, source, { [`${file}#g`]: { reason: 'another function' } })).toHaveLength(1);
  });

  it('reads the fact keys from the declared types, so a new fact joins the rule', () => {
    expect([...declaredFactKeys()].sort()).toEqual(['acknowledgement', 'childWork', 'claudeModelAliases', 'consumption', 'costReport',
      'hookEvents', 'humanInputAtTurnEnd', 'humanPromptHold', 'mode', 'nativeAsk', 'nativePermission', 'nativeSubagents',
      'nativeTimerTool', 'sessionIdSource', 'skillTriggerMidTurn', 'skillUnknownName', 'skillsSeenBySession', 'systemPromptOnResume', 'transport', 'turnStart']);
    const grown = declaredFactKeys(path => {
      const text = readFileSync(join(repoRoot, path), 'utf8');
      return path.endsWith('runner-facts.ts') ? text.replace('export interface RunnerFacts {', 'export interface RunnerFacts {\n  readonly nativeVoice: boolean;') : text;
    });
    expect(grown.has('nativeVoice')).toBe(true);
    expect(factCombinations('function f(id) { return RUNNER_FACTS[id].nativeVoice && RUNNER_FACTS[id].nativeAsk; }', grown))
      .toEqual([{ name: 'f', line: 1, facts: ['nativeAsk', 'nativeVoice'] }]);
  });

  it('reports every qualifying function, the outer one with its nested reads', () => {
    const source = "function outer(id, runner) {\n  const inner = () => RUNNER_FACTS[id].nativeAsk && runner.systemPromptOnResume;\n  return inner;\n}";
    expect(factCombinations(source)).toEqual([
      { name: 'outer', line: 1, facts: ['nativeAsk', 'systemPromptOnResume'] },
      { name: 'outer>inner', line: 2, facts: ['nativeAsk', 'systemPromptOnResume'] },
    ]);
  });

  it('clears only the function an exception names, so an inner exception leaves the outer combination', () => {
    const file = 'packages/cezar/src/workflows/run/x.ts';
    const source = "function outer(id, runner) {\n  const inner = () => RUNNER_FACTS[id].nativeAsk && RUNNER_FACTS[id].costReport;\n  return inner() && runner.inputDelivery.mode === 'steer';\n}";
    expect(combinationFindings(file, source, { [`${file}#outer>inner`]: { reason: 'a probe' } }))
      .toEqual([{ line: 1, message: expect.stringMatching(/^outer touches a runner fact source and reads costReport and mode and nativeAsk\./) }]);
  });

  it('names functions apart by their enclosing class and function, and numbers repeats', () => {
    const source = "class A { run(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }\nclass B { run(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }\nlist.map(r => r.inputDelivery.mode && r.inputDelivery.consumption);\nlist.map(r => r.inputDelivery.mode && r.inputDelivery.consumption);";
    expect(factCombinations(source).map(found => found.name)).toEqual(['A>run', 'B>run', '(anonymous function)', '(anonymous function)#2']);
  });

  it('applies to workflow sources and not to their tests', () => {
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/run/launch-read-resolver.ts')).toBe(true);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/input-acknowledgement.ts')).toBe(true);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/run/turn-settler.test.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-cells.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-fixture.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-catalog.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-asks-cells.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-base-fold.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/core/runner-facts.ts')).toBe(false);
  });

  it('keeps combination exceptions explicit and reasoned', () => {
    for (const [name, exception] of Object.entries(COMBINATION_ROWS)) {
      expect(name).toMatch(/^packages\/cezar\/src\/workflows\/.+\.ts#.+$/);
      expect(exception.reason.trim()).not.toBe('');
    }
  });
});

// Shapes, report nodes and spans the rule matched with the Babel view (hearsay-tools/squawk#3806).
// They stay pinned after the rule moved to oxlint's own tree.
describe('runner-fact-combination keeps its names, report nodes and spans', () => ruleCases(runnerFactCombination, {
  file: 'packages/cezar/src/workflows/ast-fixture.ts',
  valid: [
    "import { RUNNER_FACTS } from '../core/runner-facts.ts';\nfunction f(o) { return o.mode && o.consumption; }",
    "function f(o) { return o.mode && o.consumption; }\nfunction g(o) { return o.inputDelivery; }",
    "function f(r) { return r.inputDelivery[mode] && r.inputDelivery.consumption; }",
  ],
  invalid: [
    { code: "export function f(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; }", errors: [spanError("1:7-1:84", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "const g = (r) => r.inputDelivery?.mode && r.inputDelivery?.consumption;", errors: [spanError("1:10-1:70", /^g touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { static async run(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }", errors: [spanError("1:10-1:93", /^A>run touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { [key](r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }", errors: [spanError("1:10-1:82", /^A>key touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { 'str'(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }", errors: [spanError("1:10-1:82", /^A>\(anonymous function\) touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { get m() { return this.inputDelivery.mode && this.inputDelivery.consumption; } }", errors: [spanError("1:10-1:87", /^A>m touches a runner fact source and reads consumption and mode\./)] },
    { code: "const o = { m(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } };", errors: [spanError("1:12-1:80", /^m touches a runner fact source and reads consumption and mode\./)] },
    { code: "const o = { m: function (r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } };", errors: [spanError("1:15-1:91", /^m touches a runner fact source and reads consumption and mode\./)] },
    { code: "const o = { get m() { return this.inputDelivery.mode && this.inputDelivery.consumption; } };", errors: [spanError("1:17-1:89", /^m touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { m = (r) => r.inputDelivery.mode && r.inputDelivery.consumption; }", errors: [spanError("1:14-1:72", /^A>m touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { #m = (r) => r.inputDelivery.mode && r.inputDelivery.consumption; }", errors: [spanError("1:15-1:73", /^A>\(anonymous function\) touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { #m(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }", errors: [spanError("1:10-1:79", /^A>#m touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { m(r: InputDelivery): void; m(r) { return r.mode && r.consumption; } }", errors: [spanError("1:37-1:77", /^A>m touches a runner fact source and reads consumption and mode\./)] },
    { code: "abstract class A { abstract m(r: InputDelivery): void; n(r) { return r.mode && r.consumption; } }", errors: [spanError("1:55-1:95", /^A>n touches a runner fact source and reads consumption and mode\./)] },
    { code: "const K = class { run(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } };", errors: [spanError("1:18-1:88", /^K>run touches a runner fact source and reads consumption and mode\./)] },
    { code: "export default class { run(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; } }", errors: [spanError("1:23-1:93", /^\(anonymous class\)>run touches a runner fact source and reads consumption and mode\./)] },
    { code: "function outer(r) {\n  function inner() { return r.inputDelivery.mode; }\n  return r.facts.costReport;\n}", errors: [spanError("1:0-4:1", /^outer touches a runner fact source and reads costReport and mode\./)] },
    { code: "function f(d: InputDelivery) { return (d as InputDelivery).mode && d!.consumption && (d satisfies object)['acknowledgement']; }", errors: [spanError("1:0-1:127", /^f touches a runner fact source and reads acknowledgement and consumption and mode\./)] },
    { code: "function f(d) { return d?.['mode'] && d?.[`consumption`] && RUNNER_FACTS; }", errors: [spanError("1:0-1:75", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "import * as facts from '../core/runner-facts.ts';\nfunction f(id) { return facts.RUNNER_FACTS[id].nativeAsk && facts.RUNNER_FACTS[id].costReport; }", errors: [spanError("2:0-2:96", /^f touches a runner fact source and reads costReport and nativeAsk\./)] },
    { code: "type P = Readonly<InputDelivery>;\nexport type Q = P | undefined;\nfunction f(d: Q) { return d.mode && d.consumption; }", errors: [spanError("3:0-3:52", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "function f(d: ns.InputDelivery) { return d.mode && d.consumption; }", errors: [spanError("1:0-1:67", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "export { RUNNER_FACTS } from '../core/runner-facts.ts';\nfunction f(o) { return o.mode && o.consumption; }", errors: [spanError("2:0-2:49", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "function f(r) { const { inputDelivery: { mode }, facts: { costReport } } = r; return mode && costReport; }", errors: [spanError("1:0-1:106", /^f touches a runner fact source and reads costReport and mode\./)] },
    { code: "list.map(function named(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; });\nlist.map(function named(r) { return r.inputDelivery.mode && r.inputDelivery.consumption; });", errors: [spanError("1:9-1:90", /^named touches a runner fact source and reads consumption and mode\./), spanError("2:9-2:90", /^named#2 touches a runner fact source and reads consumption and mode\./)] },
    { code: "@decorate((r) => r.inputDelivery.mode)\nclass A { run(r) { return r.inputDelivery.consumption && r.facts.nativeAsk; } }", errors: [spanError("2:10-2:77", /^A>run touches a runner fact source and reads consumption and nativeAsk\./)] },
    { code: "class A { constructor(private r = RUNNER_FACTS) { this.x = r.mode && r.consumption; } }", errors: [spanError("1:10-1:85", /^A>constructor touches a runner fact source and reads consumption and mode\./)] },
    { code: "const f = async function* (r) { yield r.inputDelivery.mode; yield r.inputDelivery.consumption; };", errors: [spanError("1:10-1:96", /^f touches a runner fact source and reads consumption and mode\./)] },
    { code: "class A { #RUNNER_FACTS = 1; run(o) { return o.mode && o.consumption; } }", errors: [spanError("1:29-1:71", /^A>run touches a runner fact source and reads consumption and mode\./)] },
  ],
}));
