import '../core/register-all-runners.testkit.ts';
import { describe, expect, it } from 'vitest';
import { inputDeliveryOf, RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { exemptionFor } from './harness-parity-core.testkit.ts';
import { createRunner, runnerDefinition } from './runner-registry.ts';
import { RUNNER_FACTS, runnersWhere } from './runner-facts.ts';


describe('declared runner facts (hearsay-tools/cezarion#2991)', () => {
  it('reads the facts of each runner from its registered definition', () => {
    for (const id of RUNNER_IDS) expect(RUNNER_FACTS[id], id).toBe(runnerDefinition(id).facts);
  });

  it('gives every runner createRunner builds the table row for its id', async () => {
    for (const id of RUNNER_IDS) expect((await createRunner(id)).facts, id).toBe(RUNNER_FACTS[id]);
    // The legacy id builds Claude's runner, so it carries Claude's row.
    expect((await createRunner('claude-cli')).facts).toBe(RUNNER_FACTS.claude);
  });

  // Tests that must not load the runner classes read the turn-path facts from the table, so each
  // runner instance must carry exactly its row's values.
  it('gives every runner instance the input delivery and resume prompt of its table row', async () => {
    for (const id of RUNNER_IDS) {
      const runner = await createRunner(id);
      expect(inputDeliveryOf(runner), id).toEqual(RUNNER_FACTS[id].inputDelivery);
      expect(runner.inputDelivery, id).toBe(RUNNER_FACTS[id].inputDelivery);
      expect(runner.systemPromptOnResume, id).toBe(RUNNER_FACTS[id].systemPromptOnResume);
    }
  });

  it('selects runners by fact in RUNNER_IDS order', () => {
    expect(runnersWhere(facts => facts.nativeSubagents === 'reported')).toEqual(['claude', 'codex']);
    expect(runnersWhere(facts => facts.nativeTimerTool !== null)).toEqual(['claude']);
    expect(runnersWhere(facts => facts.sessionIdSource === 'launch')).toEqual(['claude', 'pi']);
    expect(runnersWhere(facts => facts.turnStart === 'on-write')).toEqual(['claude', 'pi', 'omp']);
  });

  // The turn-path facts (inputDelivery, systemPromptOnResume) and the narrow facts, including
  // sessionIdSource (workflows/run/launch-read-resolver.ts), are declared on every row.
  it('declares every fact on every runner row', () => {
    const keys = ['childWork', 'claudeModelAliases', 'costReport', 'hookEvents', 'humanPromptHold', 'inputDelivery', 'nativeAsk', 'nativePermission', 'nativeSubagents', 'nativeTimerTool', 'sessionIdSource', 'skillTriggerMidTurn', 'skillUnknownName', 'skillsSeenBySession', 'systemPromptOnResume', 'transport', 'turnStart'];
    for (const id of RUNNER_IDS) {
      expect(Object.keys(RUNNER_FACTS[id]).sort(), id).toEqual(keys);
      expect(['launch', 'native'], id).toContain(RUNNER_FACTS[id].sessionIdSource);
      expect(['resent', 'in-thread'], id).toContain(RUNNER_FACTS[id].systemPromptOnResume);
      expect(['on-write', 'on-wire'], id).toContain(RUNNER_FACTS[id].turnStart);
    }
  });

  // These rows hold runner ids by hand; this check ties each one to the declared acknowledgement.
  it.each([
    ['U12', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement === 'write'],
    ['U13', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement !== 'response'],
    ['U27', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement !== 'response'],
  ] as const)('exempts a runner from %s exactly when its acknowledgement cannot be delayed or rejected', (criterion, exempt) => {
    expect(RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined)).toEqual(RUNNER_IDS.filter(exempt));
  });
});
