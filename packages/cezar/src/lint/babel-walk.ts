import type { Node } from '@babel/types';

/** Fields of a `@babel/parser` node that hold metadata, not syntax. */
const METADATA = new Set(['loc', 'start', 'end', 'range', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null
  && typeof (value as { type?: unknown }).type === 'string';

/** Call `accept` for `node` and every syntax node under it, parents first, children in field order. */
export function visit(node: Node, accept: (node: Node) => void): void {
  accept(node);
  for (const key of Object.keys(node)) {
    if (METADATA.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) { for (const entry of value) if (isNode(entry)) visit(entry, accept); }
    else if (isNode(value)) visit(value, accept);
  }
}
