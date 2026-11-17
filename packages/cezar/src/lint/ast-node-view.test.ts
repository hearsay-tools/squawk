import { expect, it } from 'vitest';
import { babelView } from './ast-node-view.ts';
import type { AstRule, EsNode } from './ast-rule.ts';
import { checkRule } from './ast-rule.testkit.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';

const waitSource = 'vi.waitFor(() => ready(), { timeout: 100 })?.then(done)';

it.each([
  [waitSource, 'vi.waitFor', 'MemberExpression'],
  [waitSource, 'vi.waitFor(() => ready(), { timeout: 100 })', 'CallExpression'],
  [waitSource, 'vi.waitFor(() => ready(), { timeout: 100 })?.then', 'OptionalMemberExpression'],
  [waitSource, waitSource, 'OptionalCallExpression'],
  ['vi.waitFor?.(ready)', 'vi.waitFor', 'MemberExpression'],
  ['vi?.waitFor(ready)', 'vi?.waitFor(ready)', 'OptionalCallExpression'],
  ['a.b?.c()', 'a.b', 'MemberExpression'],
  ['a?.b.c()', 'a?.b.c', 'OptionalMemberExpression'],
  ['a?.b.c()', 'a?.b.c()', 'OptionalCallExpression'],
  ['(a?.b).c()', '(a?.b).c', 'MemberExpression'],
  ['(a?.b)()', '(a?.b)()', 'CallExpression'],
  ['a?.[b.c()]', 'b.c()', 'CallExpression'],
  ['a?.b(c.d())', 'c.d()', 'CallExpression'],
  ['a?.b!.c()', 'a?.b!.c()', 'OptionalCallExpression'],
])('preserves the Babel chain shape of %s at %s', (source, selected, expected) => {
  const inspector: AstRule = {
    name: 'ast-view-inspector',
    description: 'Inspect the cached AST shape for a fixture (hearsay-tools/squawk#3774).',
    applies: () => true,
    create(report, { sourceCode }) {
      const inspect = (node: EsNode) => {
        if (sourceCode.getText(node) === selected) report(node, babelView(node).type);
      };
      return { CallExpression: inspect, MemberExpression: inspect };
    },
  };
  expect(checkRule(inspector, 'packages/cezar/src/ast-view-fixture.test.ts', source).map(finding => finding.message))
    .toEqual([expected]);
});

it.each([
  ['server', testWaitDiscipline, 'packages/cezar/src/ast-view-fixture.test.ts'],
  ['unit', unitWaitDiscipline, 'packages/web/src/ast-view-fixture.test.ts'],
] as const)('keeps the short wait before an optional continuation in %s', (_profile, rule, file) => {
  expect(checkRule(rule, file, waitSource).map(finding => finding.message.split(']')[0]))
    .toEqual(['[short-bound']);
});

it('computes optional-chain membership once along a shared spine', () => {
  const members: EsNode[] = [];
  let objectReads = 0;
  let previous: EsNode = { type: 'Identifier', name: 'root' };
  for (let index = 0; index < 80; index += 1) {
    const object = previous;
    const member: EsNode = {
      type: 'MemberExpression', computed: false, optional: index === 0,
      property: { type: 'Identifier', name: `field${index}` },
    };
    Object.defineProperty(member, 'object', { enumerable: true, get() { objectReads += 1; return object; } });
    Object.assign(previous, { parent: member });
    members.push(member);
    previous = member;
  }
  Object.assign(previous, { parent: { type: 'ChainExpression', expression: previous } });
  for (const member of members) expect(babelView(member).type).toBe('OptionalMemberExpression');
  // One object read builds the shallow view; at most one more establishes cached membership.
  expect(objectReads).toBeLessThanOrEqual(members.length * 2);
});
