import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import '../core/register-all-runners.testkit.ts';
import { describe, expect, it } from 'vitest';
import { inputDeliveryOf } from './agent-runner-values.ts';
import { exemptionFor } from './harness-parity-core.testkit.ts';
import { createRunner, runnerDefinition } from './runner-registry.ts';
import { RUNNER_FACTS, runnersWhere, type RunnerFacts } from './runner-facts.ts';


describe('declared runner facts (hearsay-tools/cezarion#2991)', () => {
  it('stays read-only: every mutation of the table refuses, as the frozen table did (review B1)', () => {
    expect(() => Object.defineProperty(RUNNER_FACTS, 'claude', { value: {} })).toThrow(TypeError);
    expect(() => delete (RUNNER_FACTS as Record<string, unknown>).claude).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(RUNNER_FACTS, null)).toThrow(TypeError);
    expect(() => Object.preventExtensions(RUNNER_FACTS)).toThrow(TypeError);
    expect(() => { (RUNNER_FACTS as Record<string, unknown>).claude = {}; }).toThrow(TypeError);
    // Refused mutations leave the reads intact.
    expect(RUNNER_FACTS.claude!.skillUnknownName).toBe(runnerDefinition('claude').facts.skillUnknownName);
  });

  it('reads the facts of each runner from its registered definition', () => {
    for (const id of BUILT_IN_RUNNER_IDS) expect(RUNNER_FACTS[id], id).toBe(runnerDefinition(id).facts);
  });

  it('gives every runner createRunner builds the table row for its id', async () => {
    for (const id of BUILT_IN_RUNNER_IDS) expect((await createRunner(id)).facts, id).toBe(RUNNER_FACTS[id]);
    // The legacy id builds Claude's runner, so it carries Claude's row.
    expect((await createRunner('claude-cli')).facts).toBe(RUNNER_FACTS.claude);
  });

  // Tests that must not load the runner classes read the turn-path facts from the table, so each
  // runner instance must carry exactly its row's values.
  it('gives every runner instance the input delivery and resume prompt of its table row', async () => {
    for (const id of BUILT_IN_RUNNER_IDS) {
      const runner = await createRunner(id);
      expect(inputDeliveryOf(runner), id).toEqual(RUNNER_FACTS[id]!.inputDelivery);
      expect(runner.inputDelivery, id).toBe(RUNNER_FACTS[id]!.inputDelivery);
      expect(runner.systemPromptOnResume, id).toBe(RUNNER_FACTS[id]!.systemPromptOnResume);
    }
  });

  it.each([
    ['nativeSubagents', (facts: RunnerFacts) => facts.nativeSubagents === 'reported'],
    ['nativeTimerTool', (facts: RunnerFacts) => facts.nativeTimerTool !== null],
    ['sessionIdSource', (facts: RunnerFacts) => facts.sessionIdSource === 'launch'],
    ['turnStart', (facts: RunnerFacts) => facts.turnStart === 'on-write'],
  ] as const)('selects runners by %s in BUILT_IN_RUNNER_IDS order, from each registered definition', (_fact, matches) => {
    const selected = BUILT_IN_RUNNER_IDS.filter(id => matches(runnerDefinition(id).facts));
    // A proper subset, or the check could not tell a selection from the whole roster.
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(BUILT_IN_RUNNER_IDS.length);
    expect(runnersWhere(matches)).toEqual(selected);
  });

  // The turn-path facts (inputDelivery, systemPromptOnResume) and the narrow facts, including
  // sessionIdSource (workflows/run/launch-read-resolver.ts), are declared on every row.
  it('declares every fact on every runner row', () => {
    const keys = ['childWork', 'claudeModelAliases', 'costReport', 'hookEvents', 'humanPromptHold', 'inputDelivery', 'nativeAsk', 'nativePermission', 'nativeSubagents', 'nativeTimerTool', 'sessionIdSource', 'shutdownDescendants', 'skillTriggerMidTurn', 'skillUnknownName', 'skillsSeenBySession', 'systemPromptOnResume', 'transport', 'turnStart'];
    for (const id of BUILT_IN_RUNNER_IDS) {
      expect(Object.keys(RUNNER_FACTS[id]!).sort(), id).toEqual(keys);
      expect(['process-group', 'observed-tree'], id).toContain(RUNNER_FACTS[id]!.shutdownDescendants);
      expect(['launch', 'native'], id).toContain(RUNNER_FACTS[id]!.sessionIdSource);
      expect(['resent', 'in-thread'], id).toContain(RUNNER_FACTS[id]!.systemPromptOnResume);
      expect(['on-write', 'on-wire'], id).toContain(RUNNER_FACTS[id]!.turnStart);
    }
  });

  // Each runner declares these rows in its runners/<id>/mock.ts; this check ties them to the declared acknowledgement.
  it.each([
    ['U12', (runner: string) => RUNNER_FACTS[runner]!.inputDelivery.acknowledgement === 'write'],
    ['U13', (runner: string) => RUNNER_FACTS[runner]!.inputDelivery.acknowledgement !== 'response'],
  ] as const)('exempts a runner from %s exactly when its acknowledgement cannot be delayed or rejected', (criterion, exempt) => {
    expect(BUILT_IN_RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined)).toEqual(BUILT_IN_RUNNER_IDS.filter(exempt));
  });
  it('exempts U27 late ACK ordering exactly where the ACK is a write or never follows its turn completion', () => {
    const exempt = (runner: string) => RUNNER_FACTS[runner]!.inputDelivery.acknowledgement !== 'response' ||
      runnerDefinition(runner).mock.promptResponseEndsTurn === true;
    expect(BUILT_IN_RUNNER_IDS.filter(runner => exemptionFor('U27', runner) !== undefined))
      .toEqual(BUILT_IN_RUNNER_IDS.filter(exempt));
  });
  it.each(['R77', 'UI2'] as const)('requires %s to be explicitly declared in mock.ts exactly where hookEvents is none', criterion => {
    expect(BUILT_IN_RUNNER_IDS.filter(runner => runnerDefinition(runner).mock.parityExemptions?.[criterion] !== undefined))
      .toEqual(BUILT_IN_RUNNER_IDS.filter(runner => RUNNER_FACTS[runner]!.hookEvents === 'none'));
  });
});
