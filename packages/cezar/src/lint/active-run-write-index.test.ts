import { describe, expect, it } from 'vitest';
import { activeRunWriteRules } from './active-run-write.ts';
import { type AstContext, type EsNode } from './ast-rule.ts';

// A counted syntax edge proves bounded work without a timing threshold or a repository scan.
const visitorKeys: Record<string, string[]> = {
  Program: ['body'], ImportDeclaration: ['specifiers'], ImportSpecifier: ['imported', 'local'],
  VariableDeclaration: ['declarations'], VariableDeclarator: ['id', 'init'],
  Identifier: ['typeAnnotation'], TSTypeAnnotation: ['typeAnnotation'], TSTypeReference: ['typeName'],
  TSAsExpression: ['expression', 'typeAnnotation'], TSAnyKeyword: [],
};
const node = (type: string, fields: Record<string, unknown> = {}): EsNode => ({ type, ...fields });
const identifier = (name: string, fields: Record<string, unknown> = {}) => node('Identifier', { name, ...fields });

function fixture(imported: string) {
  const cast = node('TSAsExpression', { expression: identifier('view'), typeAnnotation: node('TSAnyKeyword') });
  const body = [
    node('ImportDeclaration', { specifiers: [node('ImportSpecifier', { imported: identifier(imported), local: identifier('View') })] }),
    node('VariableDeclaration', { declarations: [node('VariableDeclarator', {
      id: identifier('view', { typeAnnotation: node('TSTypeAnnotation', { typeAnnotation: node('TSTypeReference', { typeName: identifier('View') }) }) }),
    })] }),
    cast,
  ];
  let reads = 0;
  const program = node('Program');
  Object.defineProperty(program, 'body', { enumerable: true, get() { reads++; return body; } });
  function parents(current: EsNode) {
    for (const key of visitorKeys[current.type] ?? []) {
      const value = current[key];
      for (const part of Array.isArray(value) ? value : value ? [value] : []) {
        Object.assign(part, { parent: current });
        parents(part);
      }
    }
  }
  parents(program);
  reads = 0;
  return { program, cast, reads: () => reads };
}

// oxlint reuses one sourceCode object across files. The cache must use each Program identity.
const sourceCode = {
  text: '', getText: () => '', getAllComments: () => [], visitorKeys,
  getTokenBefore: () => null, getTokenAfter: () => null,
};
function owners(tree: ReturnType<typeof fixture>) {
  const findings: string[] = [];
  const context: AstContext = { file: 'packages/cezar/src/example.ts', sourceCode };
  const visitors = activeRunWriteRules.map(rule => rule.create(() => findings.push(rule.name), context));
  for (const visitor of visitors) visitor.Program!(tree.program);
  return { findings, cast: () => { for (const visitor of visitors) visitor.TSAsExpression!(tree.cast); } };
}

describe('active-run owner syntax index', () => {
  it('waits for a candidate and shares the Program walk across all eight owners', () => {
    const tree = fixture('BoundaryGroup');
    const scan = owners(tree);
    expect(tree.reads()).toBe(0);
    scan.cast();
    expect(scan.findings).toEqual(['active-run-boundary-write-outside-owner']);
    expect(tree.reads()).toBeLessThanOrEqual(2);
  });

  it('keeps imported types separate when sourceCode is reused for the next file', () => {
    const first = owners(fixture('BoundaryGroup'));
    first.cast();
    expect(first.findings).toEqual(['active-run-boundary-write-outside-owner']);
    const second = owners(fixture('UsageGroup'));
    second.cast();
    expect(second.findings).toEqual(['active-run-usage-write-outside-owner']);
  });
});
