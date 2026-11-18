import { defineRunner } from '../../core/runner-definition.ts';
import { OPENCODE_FACTS } from './facts.ts';

/** The OpenCode runner. */
export const opencodeRunner = defineRunner({
  id: 'opencode',
  facts: OPENCODE_FACTS,
  loadAdapter: async () => new (await import('../../core/opencode-server-runner.ts')).OpencodeServerRunner(),
});
