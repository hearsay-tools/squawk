import { parse } from '@babel/parser';
import { traverse, type Expression, type Node } from '@babel/types';

/** How a source binds names from a module. `static`: an import declaration. `import`: `await import('x')`.
 *  `import-url`: `await import(new URL('x', base))`. `load`: `await load('x')`, a local helper that imports
 *  a built module by its path. */
export type ModuleLoadForm = 'static' | 'import' | 'import-url' | 'load';

export interface ModuleLoad {
  form: ModuleLoadForm;
  specifier: string;
  /** The bound names, in source order: imported names, or the destructured keys. */
  names: string[];
}

const literal = (node: Node | undefined): string | undefined => node?.type === 'StringLiteral' ? node.value : undefined;

function unwrap(expression: Expression): Node {
  let node: Node = expression;
  for (;;) {
    if (node.type === 'AwaitExpression') node = node.argument;
    else if (node.type === 'TSAsExpression' || node.type === 'ParenthesizedExpression') node = node.expression;
    else return node;
  }
}

function dynamicLoad(init: Expression): Omit<ModuleLoad, 'names'> | undefined {
  const call = unwrap(init);
  if (call.type === 'ImportExpression') {
    const direct = literal(call.source);
    if (direct !== undefined) return { form: 'import', specifier: direct };
    const url = call.source.type === 'NewExpression' && call.source.callee.type === 'Identifier' && call.source.callee.name === 'URL'
      ? literal(call.source.arguments[0]) : undefined;
    return url === undefined ? undefined : { form: 'import-url', specifier: url };
  }
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'load') return undefined;
  const path = literal(call.arguments[0]);
  return path === undefined ? undefined : { form: 'load', specifier: path };
}

const keyName = (key: Node): string | undefined => key.type === 'Identifier' ? key.name : literal(key);

/** Every import declaration and every `const { a, b } = await <load>` in a JavaScript or TypeScript
 *  source, read from its syntax tree. */
export function moduleLoads(source: string): ModuleLoad[] {
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const found: ModuleLoad[] = [];
  traverse(tree, (node) => {
    if (node.type === 'ImportDeclaration') {
      const names = node.specifiers.flatMap((spec) => spec.type === 'ImportSpecifier' ? [keyName(spec.imported) ?? ''] : [spec.local.name]);
      found.push({ form: 'static', specifier: node.source.value, names });
      return;
    }
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || !node.init) return;
    const load = dynamicLoad(node.init);
    if (!load) return;
    const names = node.id.properties.map((property) => property.type === 'ObjectProperty' ? keyName(property.key) ?? '' : '...');
    found.push({ ...load, names });
  });
  return found;
}
