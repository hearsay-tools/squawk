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
import { oxlintRule, type SourceRule } from './source-rule.ts';
import { oxlintAstRule, type AstRule } from './ast-rule.ts';
import { childKilledRead } from './child-killed-read.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';

/** The rules that visit oxlint's syntax tree (hearsay-tools/squawk#3774). */
export const AST_RULES: AstRule[] = [childKilledRead, runStoreTestkitImport, parityRunnerSubset];

/** The rules that scan a file's text. New rules are AST rules. */
export const TEXT_RULES: SourceRule[] = [productEnvRead, homeBoundary, testHomeWrite, card2Contrast, contractRootImport, designGuardian, layerImport, mockLifecycleBoundary, mockScenarioBoundary, nativeMockSource, rawQuerySetter, runFactReader, runHistoryReader, runnerFactCombination, runnerIdBranch, runnerRosterLiteral, testWaitDiscipline, undocumentedEnvName, unitWaitDiscipline];

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: (AstRule | SourceRule)[] = [...TEXT_RULES, ...AST_RULES];

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries([
    ...TEXT_RULES.map((rule) => [rule.name, oxlintRule(rule)] as const),
    ...AST_RULES.map((rule) => [rule.name, oxlintAstRule(rule)] as const),
  ]),
};
