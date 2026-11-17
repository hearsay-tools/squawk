import { ruleCases } from './ast-rule.testkit.ts';
import { activeRunLiteral, activeRunMapWrite } from './active-run.ts';

/** Former ast-grep cases and AST probes (hearsay-tools/squawk#3774). */

ruleCases(activeRunLiteral, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const state = this.makeActiveRun()",
    "const other: Other = { a: 1 }",
    "const run = state as ActiveRun",
    "const run = { a: 1 } as Other",
    "const state: ActiveRun = this.build()"
  ],
  "invalid": [
    "const state: ActiveRun = { a: 1 }",
    "let state: ActiveRun = { a: 1 }",
    "const state = { a: 1 } as ActiveRun",
    "const state = { a: 1 } as unknown as ActiveRun",
    "const state = { a: 1 } satisfies ActiveRun",
    "const state = { ...base, a: 1 } as ActiveRun"
  ]
});

ruleCases(activeRunMapWrite, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "class RunManager { activate(id, state) { this.active.set(id, state); } }",
    "class RunManager { dropActive(id) { this.active.delete(id); } }",
    "class RunManager { execute(id, state) { this.activate(id, state); this.dropActive(id); } }",
    "class RunManager { execute(id) { this.active.get(id); this.waiting.delete(id); } }",
    "function inspect(host, id) { host.active.get(id); host.active.has(id); }"
  ],
  "invalid": [
    "class RunManager { execute(id, state) { this.active.set(id, state); } }",
    "class RunManager { execute(id) { this.active.delete(id); } }",
    "class RunManager { activate(id) { this.active.delete(id); } }",
    "class RunManager { dropActive(id, state) { this.active.set(id, state); } }",
    "class RunManager {\nexecute(id, state) {\nif (state) {\nthis.active.set(id, state);\n}\n}\n}\n",
    "class RunManager { activate() { class Other { execute(id, state) { this.active.set(id, state); } } } }",
    "class RunManager { dropActive() { class Other { execute(id) { this.active.delete(id); } } } }",
    "class Part { execute(id, state) { this.host.active.set(id, state); } }",
    "class Part { execute(id) { this.host.active.delete(id); } }",
    "function release(host, id) { host.active.delete(id); }",
    "class Part { activate(id, state) { this.host.active.set(id, state); } }",
    "class Part { dropActive(id) { this.host.active.delete(id); } }",
    "class Part { activate(id, state) { this.active.set(id, state); } }",
    "class Part { dropActive(id) { this.active.delete(id); } }",
    "class RunManager { activate(id, state) { this.host.active.set(id, state); } }",
    "class RunManager { dropActive(id) { host.active.delete(id); } }",
    "class RunManager { other() { const nested = { activate(id, state) { this.active.set(id, state); } }; } }",
    "class RunManager { other() { const nested = { dropActive(id) { this.active.delete(id); } }; } }",
    "class RunManager { activate() { const nested = { activate(id, state) { this.active.set(id, state); } }; } }",
    "class RunManager { dropActive() { const nested = { dropActive(id) { this.active.delete(id); } }; } }"
  ]
});

ruleCases(activeRunLiteral, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'function build(): ActiveRun { return {}; }',
    'const state: ActiveRun | undefined = {};',
    'var state: ActiveRun = {};',
    'const other = 1, state: ActiveRun = {};',
    'const state = {} as Other as ActiveRun;',
    'const state = {} satisfies Other;',
  ],
  invalid: [
    '({ ...base }) as ActiveRun;',
    '({}) satisfies ActiveRun;',
    'const state: ActiveRun = ({});',
    'const state: ActiveRun = {}, other = 1;',
    'const state: ActiveRun<X> = {};',
    'const state = {} as ActiveRun<X>;',
    'const state = {} satisfies ActiveRun<X>;',
  ],
});

ruleCases(activeRunMapWrite, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'host["active"].set(id, state);',
    'host.active["set"](id, state);',
    'const active = host.active; active.set(id, state);',
    'class RunManager { activate() { const write = () => this.active.set(id, state); } }',
  ],
  invalid: ['class RunManager { activate() { return { dropActive() { this.active.delete(id); } }; } }'],
});
