import { defineRunner } from '../../core/runner-definition.ts';
import { CODEX_FACTS } from './facts.ts';

/** The Codex runner. */
export const codexRunner = defineRunner({
  id: 'codex',
  facts: CODEX_FACTS,
  loadAdapter: async () => new (await import('../../core/codex-app-server-runner.ts')).CodexAppServerRunner(),
});
