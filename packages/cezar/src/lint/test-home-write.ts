import { TEST_FILE } from './home-boundary.ts';
import { child, type AstContext, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { bare, reportNode, scanSource } from './ast-tree.ts';

const SOURCES = new Set(['homedir', 'cezarHomeDir', 'resolveHome']);
const EXPRESSIONS = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSInstantiationExpression']);
const TYPE_ONLY = new Set([
  'TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSTypeParameter',
  'TSInterfaceDeclaration', 'TSInterfaceBody', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSDeclareMethod',
  'TSTypeReference', 'TSTypeLiteral', 'TSTypeQuery', 'TSImportType', 'TSExpressionWithTypeArguments', 'TSClassImplements',
  'TSMappedType', 'TSUnionType', 'TSIntersectionType', 'TSConditionalType', 'TSInferType', 'TSParenthesizedType',
  'TSTypeOperator', 'TSIndexedAccessType', 'TSArrayType', 'TSTupleType', 'TSNamedTupleMember', 'TSOptionalType', 'TSRestType',
  'TSFunctionType', 'TSConstructorType', 'TSLiteralType', 'TSTypePredicate', 'TSMethodSignature', 'TSPropertySignature',
  'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration', 'TSIndexSignature',
]);

/** Read syntax only. Computed expressions are never evaluated. */
function guarded(node: EsNode | undefined): boolean {
  return node?.type === 'Identifier' ? SOURCES.has(node.name as string)
    : node?.type === 'Literal' && typeof node.value === 'string' && SOURCES.has(node.value);
}

const TYPE_FIELDS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments']);

/** A method signature with no body: an overload or an abstract method. */
function declaredMethod(node: EsNode): boolean {
  return node.type === 'TSAbstractMethodDefinition' || (node.type === 'MethodDefinition' && child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression');
}

/** Type syntax cannot import or invoke a runtime home source: the rule reads nothing under it. */
function typeOnly(node: EsNode): boolean {
  if (TYPE_ONLY.has(node.type) || declaredMethod(node) || node.declare === true) return true;
  if (node.type === 'TSModuleDeclaration' && child(node, 'id')?.type === 'Literal') return true;
  return node.importKind === 'type' || node.exportKind === 'type';
}

/** Whether the rule reads `node`'s own syntax: no type-only node holds it, and no type field. */
function runtime(node: EsNode): boolean {
  if (EXPRESSIONS.has(node.type) || typeOnly(node)) return false;
  for (let current = node, owner = node.parent; owner; current = owner, owner = owner.parent) {
    if (typeOnly(owner)) return false;
    if (EXPRESSIONS.has(owner.type) && owner.expression !== current) return false;
    for (const key of TYPE_FIELDS) if (owner[key] === current) return false;
  }
  return true;
}

/** The guarded name a bare call invokes, through casts. */
function bareCall(node: EsNode): EsNode | undefined {
  let callee = bare(child(node, 'callee'));
  while (callee && EXPRESSIONS.has(callee.type)) callee = bare(child(callee, 'expression'));
  return callee?.type === 'Identifier' && guarded(callee) ? callee : undefined;
}

/**
 * The visitors that find ambient home syntax in one file, and its sites in source order. Each
 * visitor checks a guarded name first, so it climbs the tree only at a candidate.
 */
function homeWriteVisitors(): { visitors: Visitors; sites(sourceCode: AstContext['sourceCode']): EsNode[] } {
  const found = new Map<number, EsNode>();
  const add = (site: EsNode | undefined, node: EsNode) => {
    if (site && guarded(site) && !found.has(site.start as number) && runtime(node)) found.set(site.start as number, site);
  };
  const names = (fields: string[]) => (node: EsNode) => { for (const key of fields) add(child(node, key), node); };
  return {
    visitors: {
      CallExpression(node) { add(bareCall(node), node); },
      MemberExpression(node) { add(child(node, 'property'), node); },
      Property(node) { if (node.parent?.type === 'ObjectPattern') add(child(node, 'key'), node); },
      ImportSpecifier: names(['imported', 'local']),
      ExportSpecifier: names(['local', 'exported']),
      ExportAllDeclaration: names(['exported']),
      ImportDefaultSpecifier: names(['local']),
      ImportNamespaceSpecifier: names(['local']),
    },
    sites(sourceCode) {
      if (found.size === 0) return [];
      const allowed = allowedLines(sourceCode);
      return [...found.values()].filter(site => !allowed.has((site.loc as { start: { line: number } }).start.line))
        .sort((a, b) => (a.start as number) - (b.start as number));
    },
  };
}

/** Lines with a `// test-home-read: <reason>` comment. */
function allowedLines(sourceCode: AstContext['sourceCode']): Set<number> {
  return new Set(sourceCode.getAllComments().filter(comment => comment.type === 'Line'
    && typeof comment.value === 'string' && /^\s*test-home-read:\s*\S/.test(comment.value))
    .map(comment => (comment.loc as { start: { line: number } }).start.line));
}

/** Ban guarded syntax instead of attempting open-ended binding or value flow. */
export function unsafeHomeWrites(source: string, file = 'file.test.ts'): number[] {
  const scan = homeWriteVisitors();
  let offsets: number[] = [];
  scanSource(file, source, sourceCode => ({ ...scan.visitors, 'Program:exit'() { offsets = scan.sites(sourceCode).map(site => site.start as number); } }));
  return offsets;
}

export const testHomeWriteMessage = 'Ambient home syntax in a test; use Home.sandbox or add // test-home-read: <reason> on this line (hearsay-tools/cezarion#2813).';

export const testHomeWrite: AstRule = {
  name: 'test-home-write',
  description: 'Test home syntax requires a reasoned exception (hearsay-tools/cezarion#2813).',
  applies: file => TEST_FILE.test(file),
  create(report, { sourceCode }) {
    const scan = homeWriteVisitors();
    return {
      ...scan.visitors,
      'Program:exit'() {
        for (const site of scan.sites(sourceCode)) report(reportNode(site), testHomeWriteMessage);
      },
    };
  },
};
