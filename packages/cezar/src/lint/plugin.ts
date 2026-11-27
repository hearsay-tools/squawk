import { probeReleasePort } from './probe-release-port.ts';
import { attentionBucketCompareOutsideOwner } from './attention-bucket-compare-outside-owner.ts';
import { automationsCapabilityReadOutsideOwner } from './automations-capability-read-outside-owner.ts';
import { subagentChildrenOutsideDock } from './subagent-children-outside-dock.ts';
import { testEnumLiteral } from './test-enum-literal.ts';
import { PROCESS_OWNER_RULES } from './owner-process-rules.ts';
import { STATE_OWNER_RULES } from './owner-state-rules.ts';
import { READER_OWNER_RULES } from './owner-reader-rules.ts';
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
import { pageShellOverride } from './page-shell-override.ts';
import { rawQuerySetter } from './raw-query-setter.ts';
import { regexModuleSyntax } from './regex-module-syntax.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { runnerFactCombination } from './runner-fact-combination.ts';
import { runnerIdBranch } from './runner-id-branch.ts';
import { runnerRosterLiteral } from './runner-roster-literal.ts';
import { parityRunnerSubset } from './parity-runner-subset.ts';
import { oxlintAstRule, type AstRule } from './ast-rule.ts';
import { activeRunWriteRules } from './active-run-write.ts';
import { activeRunLiteral, activeRunMapWrite } from './active-run.ts';
import { launchReadOutsideResolver } from './launch-read-outside-resolver.ts';
import { childKilledRead } from './child-killed-read.ts';
import { runStoreTestkitImport } from './run-store-testkit-import.ts';
import { runnerCoreImport } from './runner-core-import.ts';
import { runnerFolderEscape } from './runner-folder-escape.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';
import { stubbornTestChild } from './stubborn-test-child.ts';
import { testUnpinnedClockDate } from './test-unpinned-clock-date.ts';
import { bundledFeatureImport } from './bundled-feature-import.ts';

/** The rules that visit oxlint's syntax tree (hearsay-tools/squawk#3774). */
export const AST_RULES: AstRule[] = [
  probeReleasePort, productEnvRead, homeBoundary, testHomeWrite, card2Contrast, contractRootImport,
  designGuardian, layerImport, mockLifecycleBoundary, mockScenarioBoundary, nativeMockSource, pageShellOverride,
  parityRunnerSubset, rawQuerySetter, regexModuleSyntax, runFactReader, runHistoryReader, runnerFactCombination,
  runnerIdBranch, runnerRosterLiteral, undocumentedEnvName,
  childKilledRead, runStoreTestkitImport, runnerCoreImport, runnerFolderEscape, bundledFeatureImport, launchReadOutsideResolver,
  attentionBucketCompareOutsideOwner, automationsCapabilityReadOutsideOwner,
  subagentChildrenOutsideDock, testEnumLiteral, stubbornTestChild, testUnpinnedClockDate,
  activeRunLiteral, activeRunMapWrite, ...activeRunWriteRules, testWaitDiscipline, unitWaitDiscipline,
  ...PROCESS_OWNER_RULES, ...STATE_OWNER_RULES, ...READER_OWNER_RULES,
];

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: AstRule[] = AST_RULES;

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries(AST_RULES.map((rule) => [rule.name, oxlintAstRule(rule)] as const)),
};
