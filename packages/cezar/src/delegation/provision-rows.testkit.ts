import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';

/** The provision matrix rows and the files that register them. Apart from the provision fixture,
 *  so the registration guard reads them without loading the run engine. */
export const PROVISION_ROWS = {
  governedIntent: BUILT_IN_RUNNER_IDS.flatMap(backend => ['start', 'continue', 'recovery', 'noninteractive', 'off'].map(mode => ({ backend, mode }))),
  catalogMutation: ['queued', 'restart', 'continue'] as const,
  mixedBackend: ['queued', 'restart', 'continue'] as const,
  mixedChain: ['queued', 'restart', 'continue'] as const,
  legacyIdentity: ['queued', 'restart', 'continue'] as const,
  inputRecipes: ['queued', 'restart', 'continue'] as const,
  contextArtifacts: ['queued', 'restart', 'continue'].flatMap(mode => ['original-deleted', 'copy-missing', 'both-changed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  workflowGrants: ['restart', 'continue'].flatMap(mode => ['missing', 'malformed', 'missing-step'].flatMap(damage => [[], ['Read']].map(allowedTools => ({ mode: mode as 'restart' | 'continue', damage, allowedTools })))),
  privateGrants: ['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  claudeLayout: ['queued', 'restart', 'continue'].flatMap(mode => ['native', 'override', 'named'].map(layout => ({ mode: mode as 'queued' | 'restart' | 'continue', layout: layout as 'native' | 'override' | 'named' }))),
  claudeEnvironment: ['queued', 'restart', 'continue'].flatMap(mode => ['same-dir-override', 'other-override', 'home'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))),
  privateLayout: ['queued', 'restart', 'continue'] as const,
  accountRegistry: ['queued', 'restart', 'continue'].flatMap(mode => ['delete', 'repoint'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))),
  modelLock: ['queued', 'restart', 'continue'].flatMap(mode => [{ model: 'haiku' }, { effort: 'high' }].map(settings => ({ mode: mode as 'queued' | 'restart' | 'continue', settings }))),
  privateIdentity: ['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  supportedHomes: ['codex', 'opencode', 'pi', 'omp'] as const,
  authorityRevocation: ['cancel', 'failed', 'done'] as const,
} as const;

export const PROVISION_TEST_FILES = [
  'provision-intent-catalog.test.ts',
  'provision-step-identity.test.ts',
  'provision-accepted-grants.test.ts',
  'provision-input-recipes.test.ts',
  'provision-claude-layouts.test.ts',
  'provision-accounts-lifecycle.test.ts',
] as const;

export function provisionMatrixCounts(sources: readonly string[], files: readonly string[] = PROVISION_TEST_FILES): Record<string, number> {
  const counts = Object.fromEntries(Object.keys(PROVISION_ROWS).map(name => { return [name, 0]; }));
  for (const [index, source] of sources.entries()) {
    for (const name of registrationGroups(source, files[index] ?? `provision-source-${index}.test.ts`, 'it.each', 'PROVISION_ROWS', Object.keys(PROVISION_ROWS))) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}
