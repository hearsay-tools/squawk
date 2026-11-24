/**
 * Runtime runner-kit helpers for adapter, catalog, mapper and login modules
 * (`@hearsay-tools/squawk/plugin/runtime`). Kept separate from `@hearsay-tools/squawk/plugin` so
 * `bootRuntime()` and runner `definition.ts` modules do not eagerly load `node:child_process` or
 * adapter runtime modules before an adapter is requested.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

export {
  SessionEndedBeforeAcknowledgement, isAbortError, isSignalTerminationExit, prependSystemPrompt,
  trackChildExit, unknownToolGrant,
} from '../core/agent-runner-values.ts';
export { codexToolGrantFields, ompRequestedTools, opencodeToolGrantFields } from '../core/runner-tool-grants.ts';
export { buildChildEnv } from '../core/agent-env.ts';
export { profileEnv } from '../core/agent-profiles.ts';
export { shellQuote } from '../core/shell-env.ts';
export { probeLeaderState, signalSession, spawnSessionLeader, waitForEofExit } from '../core/session-process.ts';
export { SessionDescendants } from '../core/session-descendants.ts';
export {
  AUTO_END_DELAY_MS, DEFAULT_RUNNER_TIMINGS, afterExitDrain, boundOutputDrainAfterExit, exitDrainBudget,
} from '../core/runner-runtime.ts';
export { summarizeRunnerStderr } from '../core/runner-stderr.ts';
export { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
export { readNdjson } from '../core/ndjson.ts';
export { InputSubmissions } from '../core/input-submissions.ts';
export { V1TextCoalescer } from '../core/v1-text-coalescer.ts';
export { ownLookup } from '../core/own-lookup.ts';
export { hookEventName, isVisibleHookItem } from '../core/hook-items.ts';
export { parseAskRequest, uiAskQuestions } from '../core/ask.ts';
export { editWriteKey } from '../core/edit-write-key.ts';
export { costWeightedTokens } from '../core/usage.ts';
export { squawkToolEnvNames, squawkToolNames } from '../ci-wait/tool-names.ts';
export { claudeSkillContent, openingContent, openingInput, skillOf, slashSkillPrompt, validSkillMessage } from '../core/skill-trigger.ts';
export { skillLines, skillOutput, skillProbe } from '../core/skill-probe.ts';
export { skillPathPlugin, skillPathScope } from '../core/skill-path-scope.ts';
export { formatModelIdentity, parseModelIdentity } from '../core/model-identity.ts';
export { spawnModelProbe } from '../core/model-probe-spawn.ts';
export { modelProbeTeardown } from '../core/model-probe-teardown.ts';
export { normalizedLines } from '../core/login-output.ts';
export { BrowserSignInStartError, redactBrowserSignInDetails } from '../core/browser-sign-in-error.ts';
export { effortLevelSchema, parseEffort } from '@open-mercato/cezar-contract/effort';
export { toolDisplay } from '@open-mercato/cezar-contract/tool-display';
