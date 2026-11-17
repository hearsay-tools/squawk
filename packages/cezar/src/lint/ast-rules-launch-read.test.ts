import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { curated, detectionRule, documentedLimits, generated } from '../launch-read-matrix.testkit.ts';
import { launchReadOutsideResolver } from './launch-read-outside-resolver.ts';

const unionConflict = "type Doc = import('../config.ts').CezConfig;";
// The selectors-only valid case is invalid under capture-typed-patterns. Keep the old scan's
// union verdict (coordinator-approved): the original text stays in cases.json.
// Each former YAML case stays attributed to its original rule. A snippet can trigger several
// of the merged guards; parity means at least one finding, just as the old family-union scan did.
for (const cases of curated) describe(cases.id, () => {
  ruleCases(detectionRule, { file: 'packages/cezar/src/workflows/run/cases.ts', valid: [...new Set(cases.valid)].filter(code => code !== unionConflict), invalid: [...new Set([...cases.invalid, ...cases.valid.filter(code => code === unionConflict)])] });
});

it('retains every generated family and all 3456 documented-limit cells', () => {
  expect(documentedLimits).toHaveLength(3456);
  expect(Object.keys(generated).sort()).toEqual(['capture', 'fields', 'selectors']);
});
it.each([
  ['packages/cezar/src/workflows/run.ts', true],
  ['packages/cezar/src/workflows/run/reader.ts', true],
  ['packages/cezar/src/workflows/run/launch-read-resolver.ts', false],
  ['packages/cezar/src/workflows/run/reader.test.ts', false],
  ['packages/cezar/src/workflows/run/reader.testkit.ts', false],
  ['packages/cezar/src/workflows/other.ts', false],
])('preserves file scope: %s', (file, applies) => {
  expect(launchReadOutsideResolver.applies(file)).toBe(applies);
});

// Direct rule checks pin one diagnostic per ordinary violation, without matrix projection.
ruleCases(launchReadOutsideResolver, {
  file: 'packages/cezar/src/workflows/run/direct.ts',
  valid: [
    'async function choose() { const config = await atTaskHead.config(root); return { config }; }',
    'function choose(source: Display) { return source.model; }',
    'function choose(loadWorkflows: DisplayFn) { return loadWorkflows(root); }',
    'function choose(source: Display) { return Object.entries(source); }',
  ],
  invalid: [
    'input.model;',
    'function choose(source: LaunchConfig) { return Object.entries(source); }',
    'loadWorkflows(root);',
    'class Outer { source!: StartRunInput; choose() { return class Inner { [this.source.model]() {} }; } }',
    'function choose(config: CezConfig) { return { config }; }',
  ],
});
