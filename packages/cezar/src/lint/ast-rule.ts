import { repoPath, type RuleContext } from './source-rule.ts';

/**
 * Repository rules that visit oxlint's own syntax tree (hearsay-tools/squawk#3774). Oxlint parses
 * each file once and calls every rule's visitors on that tree, so an AST rule adds no parse and no
 * text scan. `docs/sdlc/lint.md` says how to add one.
 */

/**
 * One ESTree node as oxlint hands it to a JS rule. The fields differ per `type`; read them through
 * the helpers below, which check the shape before they trust it.
 */
export interface EsNode {
  readonly type: string;
  readonly parent?: EsNode | null;
  readonly [field: string]: unknown;
}

/** Visitor functions by ESTree node type, such as `MemberExpression` or `ImportDeclaration`. */
export type Visitors = Record<string, (node: EsNode) => void>;

/** Reports `message` at `node`. */
export type Position = { line: number; column: number };
export type Report = (node: EsNode, message: string, position?: Position) => void;

/** A repository rule that visits the syntax tree of each file in its scope. */
export interface AstRule {
  /** Its id inside the `cez` plugin: `cez/<name>` in `.oxlintrc.json` and in each diagnostic. */
  name: string;
  description: string;
  /** Whether the rule reads `file`, a path relative to the root oxlint runs in. */
  applies(file: string): boolean;
  /** The visitors for one file. They call `report` for each violation. */
  create(report: Report, context: AstContext): Visitors;
}

/** Source metadata for node diagnostics, reason comments and per-file allowances. */
export interface AstContext {
  file: string;
  sourceCode: {
    readonly text: string;
    getText(node: EsNode): string;
    getAllComments(): EsNode[];
  };
}

const isNode = (value: unknown): value is EsNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** The child node in `field`, or `undefined` when the field holds no node. */
export function child(node: EsNode, field: string): EsNode | undefined {
  const value = node[field];
  return isNode(value) ? value : undefined;
}

const NO_NODES: readonly EsNode[] = Object.freeze([]);

/**
 * The child nodes in the list `field`. Holes, such as `[, b] = list`, are left out. A list with no
 * hole is returned as it is, so callers must not change the result.
 */
export function children(node: EsNode, field: string): readonly EsNode[] {
  const value = node[field];
  if (!Array.isArray(value)) return NO_NODES;
  for (const item of value) if (!isNode(item)) return value.filter(isNode);
  return value as EsNode[];
}

/** The name of an identifier or a private name, or `undefined` for any other node. */
export function nameOf(node: EsNode | undefined): string | undefined {
  if (!node || (node.type !== 'Identifier' && node.type !== 'PrivateIdentifier')) return undefined;
  return typeof node.name === 'string' ? node.name : undefined;
}

/**
 * The text of a string literal, or of a template literal with no substitution. Any other node,
 * such as a template with `${…}`, has no static text and gives `undefined`.
 */
export function stringOf(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type !== 'TemplateLiteral' || children(node, 'expressions').length > 0) return undefined;
  const [quasi] = children(node, 'quasis');
  const value = quasi?.value as { cooked?: unknown } | undefined;
  return typeof value?.cooked === 'string' ? value.cooked : undefined;
}

/** The subset of oxlint's rule context an AST rule uses. */
export interface AstRuleContext extends Pick<RuleContext, 'cwd' | 'filename'> {
  sourceCode: AstContext['sourceCode'];
  report(descriptor: { node: EsNode; message: string; loc?: { start: Position; end: Position } }): void;
}

let lastFile = { cwd: '', filename: '', path: '' };
/** Oxlint creates every rule for one file before the next, so they share one relative path. */
function fileOf(cwd: string, filename: string): string {
  if (lastFile.cwd !== cwd || lastFile.filename !== filename) lastFile = { cwd, filename, path: repoPath(cwd, filename) };
  return lastFile.path;
}

/**
 * The rule as oxlint runs it. Outside the rule's scope it returns no visitor, so oxlint calls
 * nothing of it for that file. Paths are relative to the directory oxlint runs in.
 */
export function oxlintAstRule(rule: AstRule) {
  return {
    meta: { type: 'problem' as const, docs: { description: rule.description } },
    create(context: AstRuleContext): Visitors {
      const file = fileOf(context.cwd, context.filename);
      if (!rule.applies(file)) return {};
      return rule.create((node, message, position) => context.report({ node, message,
        ...(position ? { loc: { start: position, end: position } } : {}),
      }), { file, sourceCode: context.sourceCode });
    },
  };
}
