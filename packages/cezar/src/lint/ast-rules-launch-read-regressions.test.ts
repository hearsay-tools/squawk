import { ruleCases } from './ast-rule.testkit.ts';
import { launchReadOutsideResolver } from './launch-read-outside-resolver.ts';

const defaultBodies = [
  (parameter: string, body: string) => `function choose(${parameter}) { ${body} }`,
  (parameter: string, body: string) => `const choose = function(${parameter}) { ${body} };`,
  (parameter: string, body: string) => `const choose = (${parameter}) => { ${body} };`,
  (parameter: string, body: string) => `const view = { choose(${parameter}) { ${body} } };`,
  (parameter: string, body: string) => `class View { choose(${parameter}) { ${body} } }`,
];
ruleCases(launchReadOutsideResolver, {
  file: 'packages/cezar/src/workflows/run/defaults.ts',
  valid: defaultBodies.flatMap(enclose => [
    enclose('source: Display = read()', 'void source.model;'),
    enclose('{ model }: Display = read()', 'void model;'),
  ]),
  invalid: [
    ...defaultBodies.flatMap(enclose => [
      enclose('source: StartRunInput = read()', 'void source.model;'),
      enclose('source: CezConfig = read()', 'void Object.entries(source);'),
      enclose('{ model }: StartRunInput = read()', 'void model;'),
      enclose('{ model: selected = fallback }: StartRunInput = read()', 'void selected;'),
      enclose('{ ...source }: StartRunInput = read()', 'void source;'),
    ]),
    ...['private', 'protected', 'public', 'readonly', 'private readonly'].map(modifier =>
      `class Holder { constructor(${modifier} source: StartRunInput = read()) {} choose() { return this.source.model; } }`),
    'class Holder { constructor(private source: StartRunInput = read()) { void source.model; } }',
    'function choose(holder: { source: StartRunInput } = read()) { return holder.source.model; }',
  ],
});

const signatures = (type: string) => [
  `const noop: <${type}>() => void = () => {};`,
  `const build: new <${type}>() => Display = Factory;`,
  `interface View { choose<${type}>(): void; }`,
  `interface View { <${type}>(): void; }`,
  `interface View { new <${type}>(): View; }`,
  `declare function noop<${type}>(): void;`,
];
ruleCases(launchReadOutsideResolver, {
  file: 'packages/cezar/src/workflows/run/signatures.ts',
  valid: signatures('StartRunInput').map(signature => `${signature} function choose(source: Display) { return source.model; }`),
  invalid: [
    ...signatures('StartRunInput').map(signature => `${signature} function choose(source: StartRunInput) { return source.model; }`),
    ...signatures('Raw').map(signature => `import type { StartRunInput as Raw } from './types.ts'; ${signature} function choose(source: Raw) { return source.model; }`),
    ...signatures('LaunchConfig').map(signature => `${signature} function choose(source: LaunchConfig) { return Object.entries(source); }`),
  ],
});

const nestedReturns = [
  'return () => { return source; };',
  'return () => () => { return source; };',
  'return function() { return source; };',
  'function inner() { return source; } return inner;',
  'return () => function() { return source; };',
  'return function() { return () => { return source; }; };',
];
ruleCases(launchReadOutsideResolver, {
  file: 'packages/cezar/src/workflows/run/returns.ts',
  valid: [
    ...nestedReturns.map(body => `class Holder { choose(source: Display) { ${body} } }`),
    'class Holder { choose(source: StartRunInput) { return (source: Display) => { return source; }; } }',
    'function choose(source: StartRunInput) { return () => { return source; }; }',
  ],
  invalid: nestedReturns.flatMap(body => [
    `class Holder { choose(source: StartRunInput) { ${body} } }`,
    `const holder = { choose(source: StartRunInput) { ${body} } };`,
    `function choose(source: StartRunInput) { return { get selected() { ${body} } }; }`,
  ]),
});
