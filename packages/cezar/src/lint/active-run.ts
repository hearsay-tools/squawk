import { child, children, nameOf, type AstRule, type EsNode } from './ast-rule.ts';

const LITERAL_MESSAGE = 'Build an ActiveRun only in createActiveRun (workflows/active-run.ts), which RunManager.execute and RunManager.runContinuation both call before RunManager.activate. A second literal misses fields the factory sets (open-mercato/cezar#811): add the field to createActiveRun, as a required ActiveRunInit field when it differs by entry path (hearsay-tools/cezarion#1806).';
const MAP_MESSAGE = 'Write RunManager.active only through RunManager.activate (set) or RunManager.dropActive (delete), which pin and unpin the store record (hearsay-tools/cezarion#779; hearsay-tools/cezarion#2419).';

function activeRunType(node: EsNode | undefined): boolean {
  return node?.type === 'TSTypeReference' && nameOf(child(node, 'typeName')) === 'ActiveRun';
}

function castLiteral(node: EsNode): boolean {
  if (!activeRunType(child(node, 'typeAnnotation'))) return false;
  const expression = child(node, 'expression');
  if (expression?.type === 'ObjectExpression') return true;
  return node.type === 'TSAsExpression' && expression?.type === 'TSAsExpression' &&
    child(expression, 'typeAnnotation')?.type === 'TSUnknownKeyword' && child(expression, 'expression')?.type === 'ObjectExpression';
}

/** Same-statement literals only: no unions, return types, aliases or type resolution. */
export const activeRunLiteral: AstRule = {
  name: 'active-run-literal',
  description: LITERAL_MESSAGE,
  applies: file => file.startsWith('packages/cezar/src/') && file.endsWith('.ts'),
  create: report => ({
    VariableDeclaration(node) {
      if (node.kind !== 'const' && node.kind !== 'let') return;
      // The old lexical-declaration pattern inspects the first declarator only.
      const [declaration] = children(node, 'declarations');
      if (!declaration) return;
      const id = child(declaration, 'id');
      const annotation = id && child(id, 'typeAnnotation');
      if (activeRunType(annotation && child(annotation, 'typeAnnotation')) && child(declaration, 'init')?.type === 'ObjectExpression') report(node, LITERAL_MESSAGE);
    },
    TSAsExpression(node) { if (castLiteral(node)) report(node, LITERAL_MESSAGE); },
    TSSatisfiesExpression(node) { if (castLiteral(node)) report(node, LITERAL_MESSAGE); },
  }),
};

function directMember(node: EsNode | undefined, name: string): boolean {
  return node?.type === 'MemberExpression' && node.computed !== true && child(node, 'property')?.type === 'Identifier' && nameOf(child(node, 'property')) === name;
}

/** Stop at the nearest class or object method, including a method nested in an allowed owner. */
function ownsMapWrite(node: EsNode, operation: string): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'Property' && (ancestor.method === true || ancestor.kind === 'get' || ancestor.kind === 'set')) return false;
    if (ancestor.type !== 'MethodDefinition') continue;
    const owner = ancestor.parent?.parent;
    return ancestor.computed !== true && child(ancestor, 'key')?.type === 'Identifier' && nameOf(child(ancestor, 'key')) === (operation === 'set' ? 'activate' : 'dropActive') &&
      owner?.type === 'ClassDeclaration' && nameOf(child(owner, 'id')) === 'RunManager';
  }
  return false;
}

/** Direct .active.set/delete calls only; aliases and computed properties stay outside scope. */
export const activeRunMapWrite: AstRule = {
  name: 'active-run-map-write',
  description: MAP_MESSAGE,
  applies: file => file.startsWith('packages/cezar/src/workflows/') && file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.testkit.ts'),
  create: report => ({
    CallExpression(node) {
      const callee = child(node, 'callee');
      const operation = callee && nameOf(child(callee, 'property'));
      if (!operation || !['set', 'delete'].includes(operation) || !directMember(callee, operation)) return;
      const active = child(callee!, 'object');
      if (!directMember(active, 'active')) return;
      if (child(active!, 'object')?.type === 'ThisExpression' && ownsMapWrite(node, operation)) return;
      report(node, MAP_MESSAGE);
    },
  }),
};
