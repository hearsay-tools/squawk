import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { harnessAdapter } from '../../core/harness-parity-core.testkit.ts';
import { describeHarnessGroups, vitestRegistration, type HarnessGroup } from '../../core/harness-parity-registrar.testkit.ts';
import { SEAM_CRITERIA, seamRows } from '../../core/harness-parity-seam-tier.testkit.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import { knownRunnerIds, registeredRunners, resolveRunnerId } from '../../core/runner-registry.ts';
import { setupMonitoringFixture, waitForProduct } from '../../workflows/run-fixture.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from '../ids.ts';
import { fixtureRunner } from './definition.testkit.ts';
import { FIXTURE_BIN_ENV } from './data.testkit.ts';

sealTestRunners(fixtureRunner);

/**
 * The fixture runner (hearsay-tools/squawk#3899): a registered runner that no built-in list names, over
 * the small mock `scripts/mock-fixture-runner.mjs`. This file registers it, runs a task on it to the
 * review gate and runs the harness parity kit's baseline seam rows on it. Adding the runner changed no
 * file outside `runners/fixture/` and that script.
 */

describe('the fixture runner in the registry', () => {
  it('resolves to itself and declares its facts, with no built-in list naming it', () => {
    expect(resolveRunnerId('fixture')).toBe('fixture');
    expect(knownRunnerIds()).toContain('fixture');
    expect(registeredRunners().map(({ id }) => id)).toContain('fixture');
    expect(BUILT_IN_RUNNER_IDS).not.toContain('fixture');
    expect(RUNNER_FACTS.fixture!.inputDelivery.mode).toBe('steer');
  });
});

/** The baseline rows of the seam tier: the scenarios the fixture mock answers. */
const FIXTURE_SEAM_ROWS = ['S1', 'S2', 'S3', 'S4', 'S7', 'S10', 'S20'];

const fixtureSeamRows: HarnessGroup = (r) => {
  r.describeRunners('startup', 'harness parity — baseline seam rows on the fixture runner', () => {
    seamRows(r, SEAM_CRITERIA.filter(row => FIXTURE_SEAM_ROWS.includes(row.id)));
  });
};

describeHarnessGroups({ runner: fixtureRunner, part: 'startup' }, { ...vitestRegistration(), allRows: true }, [fixtureSeamRows]);

describe('a task on the fixture runner', () => {
  const f = setupMonitoringFixture();
  afterEach(() => { vi.unstubAllEnvs(); });

  it('runs to the review gate', async () => {
    vi.stubEnv(FIXTURE_BIN_ENV, harnessAdapter(fixtureRunner).mockBin);
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    vi.stubEnv('CEZ_DRY_RUN', '');
    const record = f.manager.startRun(f.SINGLE_STEP, { task: 'inspect the working tree', runner: 'fixture', worktree: true });
    f.currentId = record.id;
    await waitForProduct(f.manager, f.store, () => f.store.getRun(record.id)?.status === RUN_STATUS.waiting);
    const run = f.store.getRun(record.id)!;
    expect(run.runner).toBe('fixture');
    expect(f.store.eventLog.readEvents(record.id).some(event => event.type === 'text' && String(event.text).startsWith('fixture reply to:'))).toBe(true);
    writeFileSync(join(run.worktreePath!, 'fixture.txt'), 'changed by the fixture task\n');
    expect(f.manager.finish(record.id)).toBe(true);
    await waitForProduct(f.manager, f.store, () => f.store.getRun(record.id)?.status === RUN_STATUS.review);
  });
});
