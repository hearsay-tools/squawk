import type { AgentRunner, RunnerFactory } from './agent-runner.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { registerRunner } from './runner-registry.ts';

/** The runner factory a test file drives. Each test file is its own module graph, so this is per
 *  file (hearsay-tools/cezarion#2939).
 *
 *  Two kinds of call choose it. `useRunners` is explicit: it always replaces the factory, so the
 *  last explicit call wins. `core/every-runner.testkit.ts` makes one at import, and a test body
 *  that calls it after its imports still wins. `offerRunners` is a default: it replaces only a
 *  weaker offer, and never an explicit choice. `runners/claude/claude-runner.testkit.ts` offers
 *  `RUNNER_OFFER.claude` and `core/no-runner.testkit.ts` offers `RUNNER_OFFER.none`. So when one
 *  test file's closure holds several of these kits, every-runner beats claude, and claude beats
 *  none, whatever the import order (hearsay-tools/cezarion#3242). */
let current: RunnerFactory | undefined;
let currentRank = 0;

/** The rank of each default offer. A higher rank replaces a lower one. */
export const RUNNER_OFFER = { none: 1, claude: 2 } as const;

/** Choose the runners this test file's fixtures build. */
export function useRunners(factory: RunnerFactory): void {
  current = factory;
  currentRank = Number.POSITIVE_INFINITY;
}

/** Whether `workflows/runner-hook.testkit.ts` made the explicit choice. */
let hookedFactory = false;

/**
 * The runner hook's choice (`workflows/runner-hook.testkit.ts`): an explicit factory that wraps the
 * registry's `createRunner` to inject `runnerHook.runner` and capture each session's UI channel.
 */
export function useRunnerHook(factory: RunnerFactory): void {
  useRunners(factory);
  hookedFactory = true;
}

/**
 * The import-time choice of the production factory (`core/created-runners.testkit.ts`). It refuses to
 * run after the runner hook chose, because it would replace the hook and bypass `runnerHook.runner`
 * and the UI capture without a failure: import `created-runners.testkit.ts` (or `every-runner.testkit.ts`)
 * before `run-fixture.testkit.ts`, `runner-hook.testkit.ts` and the kits that import them. A test body
 * that calls `useRunners` after its imports still replaces either choice on purpose.
 */
export function useCreatedRunners(factory: RunnerFactory): void {
  if (hookedFactory) {
    throw new Error('created-runners.testkit.ts loaded after runner-hook.testkit.ts, so it would replace the hook\'s factory: '
      + 'import created-runners.testkit.ts (or every-runner.testkit.ts) before run-fixture.testkit.ts and runner-hook.testkit.ts.');
  }
  useRunners(factory);
}

/** Offer a default factory: it applies only when no explicit choice and no stronger offer exists. */
export function offerRunners(factory: RunnerFactory, rank: number): void {
  if (rank <= currentRank) return;
  current = factory;
  currentRank = rank;
}

/** The factory `useRunners` chose. A fixture asks for it only when a run starts a runner. */
export function runnersUnderTest(): RunnerFactory {
  if (!current) {
    throw new Error('No runner factory for this test file: call useRunners() with the runner it drives, '
      + 'or import runners/claude/claude-runner.testkit.ts, core/no-runner.testkit.ts or core/every-runner.testkit.ts.');
  }
  return current;
}

type RunnerMaker = () => AgentRunner;

/** A factory that builds the named runners and refuses every other backend, so a per-runner test
 *  loads and starts only the adapters it names. It registers each runner's definition, so the
 *  engine reads that runner's data from the registry; registering the same definition again does
 *  nothing. */
export function onlyRunners(runners: ReadonlyArray<readonly [RunnerDefinition, RunnerMaker]>): RunnerFactory {
  for (const [definition] of runners) registerRunner(definition);
  const makers = new Map<string, RunnerMaker>(runners.map(([definition, make]) => [definition.id, make]));
  return async (backend) => {
    const requested = backend === undefined || backend === 'claude-cli' ? 'claude' : backend;
    const make = makers.get(requested);
    if (!make) throw new Error(`This test drives only the ${[...makers.keys()].join(' and ')} runner; it was asked for ${String(backend)}.`);
    return make();
  };
}

/** `onlyRunners` for one runner. */
export function onlyRunner(definition: RunnerDefinition, make: RunnerMaker): RunnerFactory {
  return onlyRunners([[definition, make]]);
}

/** For a run module test that starts no runner: building one fails the test at once. */
export const noRunners: RunnerFactory = async (backend) => {
  throw new Error(`This test starts no runner; it was asked for ${String(backend)}.`);
};
