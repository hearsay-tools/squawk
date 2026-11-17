import { child, type AstContext, type EsNode } from './ast-rule.ts';

/** AST boundaries that keep the former tree-sitter syntax scope (hearsay-tools/squawk#3774). */
const TRIVIA = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*$/;
const range = (node: EsNode): readonly [number, number] => node.range as readonly [number, number];

/** ESTree drops parentheses. Only trivia may separate a direct child's matching boundary. */
export function sameBoundary(owner: EsNode, node: EsNode, edge: 0 | 1, { sourceCode }: AstContext): boolean {
  const bounds = [range(owner)[edge], range(node)[edge]].sort((a, b) => a - b);
  return TRIVIA.test(sourceCode.text.slice(bounds[0], bounds[1]));
}

/** Optional chains have an ESTree wrapper that tree-sitter does not add. */
export function chainExpression(node: EsNode | undefined): EsNode | undefined {
  return node?.type === 'ChainExpression' ? child(node, 'expression') : node;
}

/** Match the source spelling: escaped identifiers and private or computed names stay out. */
export function namedMember(node: EsNode | undefined, name: string, { sourceCode }: AstContext): boolean {
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  const property = child(node, 'property');
  return property?.type === 'Identifier' && sourceCode.getText(property) === name;
}
