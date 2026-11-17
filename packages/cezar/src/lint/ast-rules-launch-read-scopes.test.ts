import { describe } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { launchReadOutsideResolver } from './launch-read-outside-resolver.ts';

// Read inside a scope with another binding; read inside a same-name shadow; read after it.
// The imported spelling exercises both the value index and the type index.
const valueScopes: Record<string, (name: string, body: string) => string> = {
  block: (name, body) => `{ const ${name}: Display = display(); ${body} }`,
  static_const: (name, body) => `class View { static { const ${name}: Display = display(); ${body} } }`,
  static_let: (name, body) => `class View { static { let ${name}: Display = display(); ${body} } }`,
  static_var: (name, body) => `class View { static { var ${name}: Display = display(); ${body} } }`,
  catch: (name, body) => `try {} catch (${name}) { ${body} }`,
  for: (name, body) => `for (let ${name}: Display = display(); more();) { ${body} }`,
  for_of: (name, body) => `for (const ${name} of displays) { ${body} }`,
  for_in: (name, body) => `for (const ${name} in displays) { ${body} }`,
  switch: (name, body) => `switch (choice) { case 1: const ${name}: Display = display(); ${body} break; }`,
  namespace_const: (name, body) => `namespace View { const ${name}: Display = display(); ${body} }`,
  namespace_var: (name, body) => `namespace View { var ${name}: Display = display(); ${body} }`,
  declaration: (name, body) => `function choose(${name}: Display) { ${body} }`,
  expression: (name, body) => `const choose = function(${name}: Display) { ${body} };`,
  arrow: (name, body) => `const choose = (${name}: Display) => { ${body} };`,
  generator: (name, body) => `function* choose(${name}: Display) { ${body} }`,
  generator_expression: (name, body) => `const choose = function*(${name}: Display) { ${body} };`,
  method: (name, body) => `const holder = { choose(${name}: Display) { ${body} } };`,
  class_method: (name, body) => `class Holder { choose(${name}: Display) { ${body} } }`,
  class_expression: (name, body) => `const View = class ${name} { choose() { ${body} } };`,
  class_declaration: (name, body) => `{ class ${name} { choose() { ${body} } } }`,
  named_function: (name, body) => `const choose = function ${name}() { ${body} };`,
};
for (const [kind, surround] of Object.entries(valueScopes)) describe(kind, () => {
  for (const type of ['StartRunInput', 'Raw']) {
    const prefix = `${type === 'Raw' ? "import type { StartRunInput as Raw } from './types.ts';" : ''} const source: ${type} = read();`;
    ruleCases(launchReadOutsideResolver, {
      file: 'packages/cezar/src/workflows/run/value-scopes.ts',
      valid: [prefix + surround('source', 'void source.model;')],
      invalid: [prefix + surround('view', 'void source.model;'), prefix + surround('source', '') + 'void source.model;'],
    });
  }
});

// Every declaration with TSTypeParameterDeclaration owns those parameters. Empty-body
// class methods have their own ESTree function node, unlike interface TSMethodSignature.
const genericScopes: Record<string, (name: string) => string> = {
  function_type: name => `const noop: <${name}>(value: ${name}) => ${name} = identity;`,
  constructor_type: name => `const build: new <${name}>(value: ${name}) => Display = Factory;`,
  method_signature: name => `interface View { noop<${name}>(value: ${name}): ${name}; }`,
  call_signature: name => `interface View { <${name}>(value: ${name}): ${name}; }`,
  construct_signature: name => `interface View { new <${name}>(value: ${name}): View; }`,
  declare_function: name => `declare function noop<${name}>(value: ${name}): ${name};`,
  abstract_method: name => `abstract class View { abstract noop<${name}>(value: ${name}): ${name}; }`,
  overload_method: name => `class View { noop<${name}>(value: ${name}): void; noop() {} }`,
  function: name => `function noop<${name}>(value: ${name}) { return value.model; }`,
  expression: name => `const noop = function<${name}>(value: ${name}) { return value.model; };`,
  arrow: name => `const noop = <${name}>(value: ${name}) => value.model;`,
  class: name => `class View<${name}> { noop(value: ${name}) { return value.model; } }`,
  class_expression: name => `const view = class View<${name}> { noop(value: ${name}) { return value.model; } };`,
  interface: name => `interface View<${name}> { value: ${name}; }`,
  alias: name => `type View<${name}> = ${name};`,
  mapped: name => `type View = { [${name} in keyof Display]: ${name} };`,
  inferred: name => `type View<T> = T extends infer ${name} ? ${name} : never;`,
};
for (const [kind, declare] of Object.entries(genericScopes)) describe(kind, () => {
  for (const type of ['StartRunInput', 'Raw']) {
    const prefix = type === 'Raw' ? "import type { StartRunInput as Raw } from './types.ts';" : '';
    ruleCases(launchReadOutsideResolver, {
      file: 'packages/cezar/src/workflows/run/generic-scopes.ts',
      valid: [prefix + declare(type)],
      invalid: [prefix + declare(type) + `function choose(source: ${type}) { return source.model; }`],
    });
  }
});

ruleCases(launchReadOutsideResolver, {
  file: 'packages/cezar/src/workflows/run/static-scopes.ts',
  valid: ['const source: StartRunInput = read(); class View { static { const source: Display = display(); void source.model; } }'],
  invalid: ['const source: StartRunInput = read(); class View { static { const source: Display = display(); } choose() { return source.model; } }'],
});
