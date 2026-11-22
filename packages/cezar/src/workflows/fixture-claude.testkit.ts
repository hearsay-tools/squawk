// Its fixtures delete, reclaim or archive runs, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';

/** `fixture-manager.testkit.ts` with the Claude CLI runner as the test file's only runner
 *  (hearsay-tools/cezarion#3242). */
export * from './fixture-manager.testkit.ts';
