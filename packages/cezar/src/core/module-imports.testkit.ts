import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { traverse, type Expression, type Node } from '@babel/types';

function unreadable(file: string): never {
  throw new Error(`${file}: a module load whose target is not a literal import specifier`);
}

function staticImport(node: Node): string | undefined {
  if (node.type === 'ImportDeclaration') {
    const typeOnly = node.importKind === 'type' ||
      (node.specifiers.length > 0 && node.specifiers.every(spec => spec.type === 'ImportSpecifier' && spec.importKind === 'type'));
    return typeOnly ? undefined : node.source.value;
  }
  if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
    return node.exportKind === 'type' ? undefined : node.source.value;
  }
  if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
    return node.importKind === 'type' ? undefined : node.moduleReference.expression.value;
  }
  return undefined;
}

function dynamicLoad(node: Node, file: string): string | undefined {
  if (node.type === 'ImportExpression') return node.source.type === 'StringLiteral' ? node.source.value : unreadable(file);
  if (node.type !== 'CallExpression') return undefined;
  if (node.callee.type === 'Identifier' && node.callee.name === 'require') return unreadable(file);
  if (node.callee.type !== 'Import') return undefined;
  const [target] = node.arguments;
  return target?.type === 'StringLiteral' ? target.value : unreadable(file);
}

/** Every module a TypeScript source loads at run time: static imports (side-effect ones too),
 *  `export ... from` and `import()` with a literal specifier. Type-only imports and exports are
 *  left out. A form whose target cannot be read, such as `import(name)` or `require`, throws, so
 *  a guard built on this list fails closed (hearsay-tools/cezarion#3242). */
export function runtimeImports(source: string, file = 'source'): string[] {
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const found: string[] = [];
  traverse(tree, (node) => {
    const specifier = staticImport(node) ?? dynamicLoad(node, file);
    if (specifier !== undefined) found.push(specifier);
  });
  return found;
}

const ANY_EXTENSION = /\.[^./]+$/;

/** The modules in `dir` that `file` loads and whose name `name` matches, as file names. Each
 *  relative specifier is resolved against `file` first, so `././x.ts` and `../dir/x.ts` name the
 *  same module as `./x.ts`. A relative load with a query or a hash, or one that names a matching
 *  module by any other extension or by none (the resolver tries extensions), throws: the guard
 *  cannot tell what it loads. */
export function moduleImports(file: URL, dir: URL, name: RegExp): string[] {
  const path = fileURLToPath(file);
  const dirPath = fileURLToPath(dir).replace(/[/\\]+$/, '');
  const found: string[] = [];
  for (const specifier of runtimeImports(readFileSync(path, 'utf8'), basename(path))) {
    if (!specifier.startsWith('.')) continue;
    const target = new URL(specifier, file);
    if (target.search || target.hash) throw new Error(`${basename(path)}: ${specifier} carries a query or a hash`);
    const targetPath = fileURLToPath(target);
    if (dirname(targetPath) !== dirPath) continue;
    const module = basename(targetPath);
    if (name.test(module)) found.push(module);
    else if (name.test(`${module}.ts`) || name.test(module.replace(ANY_EXTENSION, '.ts'))) {
      throw new Error(`${basename(path)}: ${specifier} names a module by another extension or none`);
    }
  }
  return found;
}

/** The modules in the file's own directory that the file loads and whose name `name` matches, as
 *  file names. Same resolution and throws as `moduleImports`. */
export function siblingImports(file: URL, name: RegExp): string[] {
  return moduleImports(file, new URL('.', file), name);
}

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

function boundLoad(init: Expression): Omit<ModuleLoad, 'names'> | undefined {
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
 *  source, read from its syntax tree, with the names each binds. Unlike `runtimeImports`, it lists
 *  only the forms it can read and skips the rest: a guard that must see every load a file makes
 *  uses `runtimeImports`, which fails closed. */
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
    const load = boundLoad(node.init);
    if (!load) return;
    const names = node.id.properties.map((property) => property.type === 'ObjectProperty' ? keyName(property.key) ?? '' : '...');
    found.push({ ...load, names });
  });
  return found;
}
