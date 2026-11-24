import '../built-in-run-slots.testkit.ts';
import './every-runner.testkit.ts';

/** `worker-parity-core.testkit.ts` with every production adapter as the test file's runners. A
 *  test that drives one runner imports `worker-parity-core.testkit.ts` instead
 *  (hearsay-tools/squawk#4176). */
export * from './worker-parity-core.testkit.ts';
