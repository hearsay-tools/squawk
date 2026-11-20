import './register-all-runners.testkit.ts';
import './created-runners.testkit.ts';

// Importing this module registers every built-in runner and makes every production adapter the test
// file's runners. `createRunner` is read at call time, so a test's `vi.mock` or `vi.spyOn` of
// `runner-registry.ts` still reaches it.
// A test that drives one runner never imports this module (hearsay-tools/cezarion#2939). It
// registers that runner's definition and imports `created-runners.testkit.ts`; a test that starts no
// runner imports `no-runner.testkit.ts`, and one that runs only Claude imports
// `claude-runner.testkit.ts`. This kit's choice is explicit, so it beats both of them when one test
// file loads them together (hearsay-tools/cezarion#3242).
