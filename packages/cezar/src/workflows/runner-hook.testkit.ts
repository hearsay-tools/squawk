import { vi } from 'vitest';
import type { UiEvent } from '../core/ui-events.ts';
import type { AgentRunner } from '../core/agent-runner.ts';
import * as runnerFactory from '../core/runner-registry.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { useRunnerHook } from '../core/runners-under-test.testkit.ts';

/** The test file's runner factory: a test sets `runnerHook.runner` to replace the built-in runner,
 *  and `runnerHook.uiEvent` sends an event on the UI channel of the last started session. */
const hoistedRunnerHook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined, ui: undefined as ((event: UiEvent) => void) | undefined }));

const originalStarts = new WeakMap<AgentRunner, AgentRunner['startSession']>();
registerRunner(claudeRunner);
useRunnerHook(async (...args) => {
  const runner = hoistedRunnerHook.runner ?? await runnerFactory.createRunner(...args);
  const start = originalStarts.get(runner) ?? runner.startSession.bind(runner);
  originalStarts.set(runner, start);
  runner.startSession = (spec, ...rest) => {
    hoistedRunnerHook.ui = rest[1]?.onUiEvent;
    return start(spec, ...rest);
  };
  return runner;
});

export const runnerHook = {
  uiEvent(event: UiEvent) { if (!hoistedRunnerHook.ui) throw new Error("No runner UI channel observed"); hoistedRunnerHook.ui(event); },
  get runner(): AgentRunner | undefined { return hoistedRunnerHook.runner; },
  set runner(value: AgentRunner | undefined) { hoistedRunnerHook.runner = value; hoistedRunnerHook.ui = undefined; },
};
