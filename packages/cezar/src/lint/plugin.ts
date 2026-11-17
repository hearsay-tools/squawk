import { productEnvRead } from './product-env-read.ts';
import { testHomeWrite } from './test-home-write.ts';
import { homeBoundary } from './home-boundary.ts';
import { layerImport } from './layer-import.ts';
import { card2Contrast } from './card-2-contrast.ts';
import { contractRootImport } from './contract-root-import.ts';
import { designGuardian } from './design-guardian.ts';
import { mockLifecycleBoundary } from './mock-lifecycle-boundary.ts';
import { mockScenarioBoundary } from './mock-scenario-boundary.ts';
import { nativeMockSource } from './native-mock-source.ts';
import { rawQuerySetter } from './raw-query-setter.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { runnerFactCombination } from './runner-fact-combination.ts';
import { runnerIdBranch } from './runner-id-branch.ts';
import { runnerRosterLiteral } from './runner-roster-literal.ts';
import { parityRunnerSubset } from './parity-runner-subset.ts';
import { oxlintAstRule, type AstRule } from './ast-rule.ts';
import { childKilledRead } from './child-killed-read.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';

/** Every repository rule visits oxlint's syntax tree (hearsay-tools/squawk#3774). */
export const AST_RULES: AstRule[] = [
  productEnvRead, homeBoundary, testHomeWrite, card2Contrast, contractRootImport,
  designGuardian, layerImport, mockLifecycleBoundary, mockScenarioBoundary, nativeMockSource,
  parityRunnerSubset, rawQuerySetter, runFactReader, runHistoryReader, runnerFactCombination,
  runnerIdBranch, runnerRosterLiteral, testWaitDiscipline, undocumentedEnvName, unitWaitDiscipline,
  childKilledRead, runStoreTestkitImport,
];

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: AstRule[] = AST_RULES;

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries(AST_RULES.map(rule => [rule.name, oxlintAstRule(rule)])),
};
