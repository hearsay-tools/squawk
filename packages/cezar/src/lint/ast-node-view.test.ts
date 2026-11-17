import { expect, it } from 'vitest';
import { babelView, deferredAstView } from './ast-node-view.ts';
import type { AstRule, EsNode } from './ast-rule.ts';
import { checkRule } from './ast-rule.testkit.ts';

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

it.each(['numeric', 'string'])('keeps static-text reads linear for %s addition chains', (kind) => {
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
      name: 'static-text-inspector',
      description: 'Count static text reads through oxlint visitors (hearsay-tools/squawk#3774).',
      applies: () => true,
      create() {
        const visitors = deferredAstView(name => name === 'CEZ_TARGET', () => {});
        return Object.fromEntries(Object.entries(visitors).map(([type, visit]) => [type, (node: EsNode) => visit(wrap(node) as EsNode)]));
      },
    };
    const operands = Array.from({ length }, () => kind === 'numeric' ? '1' : "'x'");
    checkRule(measured, 'packages/cezar/src/static-text-fixture.test.ts', `const total = ${operands.join(' + ')};`);
    return reads;
  };
  let previous = readsFor(100);
  for (const length of [200, 400, 800]) {
    const current = readsFor(length);
    expect(current).toBeGreaterThan(previous);
    expect(current).toBeLessThanOrEqual(previous * 2.1);
    previous = current;
  }
});
