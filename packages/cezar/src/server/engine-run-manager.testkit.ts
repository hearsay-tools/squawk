import { RunManager } from '../workflows/run.ts';
import type { RunManagerFactory } from './project-context.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';

/** The manager factory `serve` passes, for tests that need the real run engine in a non-boot project context:
 *  `fake-run-manager.testkit.ts` serves every other test. Its managers get the inert CI supervisor; a test that
 *  waits on a PR builds its own factory with the real one. */
export const createRunManager: RunManagerFactory = (store, root, options) => new RunManager(store, root, { ...options, acquireCiResources: acquireInertCiResources });
