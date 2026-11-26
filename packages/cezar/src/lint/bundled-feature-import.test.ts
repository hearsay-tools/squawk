import { describe, expect, it } from 'vitest';
import { checkRule, ruleCases } from './ast-rule.testkit.ts';
import { bundledFeatureImport, featureFolder, featureTarget } from './bundled-feature-import.ts';

const core = 'packages/cezar/src/workflows/run/run-settlement.ts';
const shell = 'packages/cezar/src/built-in-run-slots.ts';
const feature = 'packages/cezar/src/features/jobs/removal-slot.ts';

describe('bundled-feature-import (hearsay-tools/squawk#4314)', () => {
  it('finds the feature folder of a path, but not of the features root or a path outside it', () => {
    expect(featureFolder('packages/cezar/src/features/jobs/job.ts')).toBe('packages/cezar/src/features/jobs/');
    expect(featureFolder('packages/cezar/src/features/jobs/deep/x.ts')).toBe('packages/cezar/src/features/jobs/');
    expect(featureFolder('packages/cezar/src/features/jobs/')).toBe('packages/cezar/src/features/jobs/');
    expect(featureFolder('packages/cezar/src/features/index.ts')).toBeUndefined();
    expect(featureFolder('packages/cezar/src/jobs/job.ts')).toBeUndefined();
    expect(featureFolder('packages/cezar/src/plugin/bundled-features.ts')).toBeUndefined();
  });

  it('maps a specifier to the file it names inside another feature folder', () => {
    expect(featureTarget(core, '../../features/jobs/job.ts')).toBe('packages/cezar/src/features/jobs/job.ts');
    expect(featureTarget(core, '../../features/jobs/job.js')).toBe('packages/cezar/src/features/jobs/job.ts');
    expect(featureTarget(shell, './features/jobs')).toBe('packages/cezar/src/features/jobs');
    expect(featureTarget(shell, './features/jobs/')).toBe('packages/cezar/src/features/jobs/');
    expect(featureTarget(shell, '@hearsay-tools/squawk/features/jobs/index.js')).toBe('packages/cezar/src/features/jobs/index.ts');
    expect(featureTarget(shell, '@hearsay-tools/squawk/dist/features/jobs/index.js')).toBe('packages/cezar/src/features/jobs/index.ts');
    expect(featureTarget(shell, '@wjarka/cezarion/src/features/jobs/index.ts')).toBe('packages/cezar/src/features/jobs/index.ts');
    expect(featureTarget('packages/cezar/src/features/other/index.ts', '../jobs/job.ts')).toBe('packages/cezar/src/features/jobs/job.ts');
    expect(featureTarget(feature, './job.ts')).toBeUndefined();
    expect(featureTarget(feature, '../jobs/job.ts')).toBeUndefined();
    expect(featureTarget(feature, '../../runs/removal-slots.ts')).toBeUndefined();
    expect(featureTarget(shell, './plugin/bundled-features.ts')).toBeUndefined();
    expect(featureTarget(shell, './features')).toBeUndefined();
    expect(featureTarget(shell, '@hearsay-tools/squawk/plugin')).toBeUndefined();
    expect(featureTarget(shell, 'features/jobs/job.ts')).toBeUndefined();
    expect(featureTarget(shell, undefined)).toBeUndefined();
  });

  ruleCases(bundledFeatureImport, {
    file: core,
    valid: [
      "import { deletionRefusal } from '../../runs/removal-slots.ts';",
      "import type { SquawkPluginApi } from '@hearsay-tools/squawk/plugin';",
      "import { spawn } from 'node:child_process';",
      'const load = (id: string) => import(`../../features/${id}/index.ts`);',
    ],
    invalid: [
      "import { jobRunsIn } from '../../features/jobs/job.ts';",
      "import type { DeletionGate } from '../../features/jobs/removal-slot.js';",
      "import { type JobError } from '../../features/jobs/job.ts';",
      "export { jobRunsIn } from '../../features/jobs/job.ts';",
      "export * from '../../features/jobs/job.ts';",
      "import '../../features/jobs/index.ts';",
      "const load = () => import('../../features/jobs/cli.ts');",
      "type Job = import('../../features/jobs/job.ts').StoppedJob;",
      "import job = require('../../features/jobs/job.ts');",
      "import setup from '@hearsay-tools/squawk/dist/features/jobs/index.js';",
      "const load = () => import('@hearsay-tools/squawk/features/jobs/index.js');",
    ],
  });

  ruleCases(bundledFeatureImport, {
    file: 'packages/cezar/src/features/other/index.ts',
    valid: [
      "import { helper } from './helper.ts';",
      "import { deletionRefusal } from '../../runs/removal-slots.ts';",
    ],
    invalid: [
      "import { jobRunsIn } from '../jobs/job.ts';",
    ],
  });

  it('lets a feature import its own folder and core code', () => {
    expect(checkRule(bundledFeatureImport, feature, "import { jobRunsIn } from './job.ts';\nimport { agentTmpDirLocations } from '../../runs/agent-tmpdir.ts';\n")).toEqual([]);
  });

  it('names the target and its folder in the finding', () => {
    const [finding] = checkRule(bundledFeatureImport, shell, "import { jobsDeletionGate } from './features/jobs/removal-slot.ts';\n");
    expect(finding?.message).toContain('packages/cezar/src/features/jobs/removal-slot.ts is inside packages/cezar/src/features/jobs/');
  });

  it('stays out of tests, testkits, specs, type declarations and fixtures', () => {
    expect(bundledFeatureImport.applies(core)).toBe(true);
    expect(bundledFeatureImport.applies('packages/cezar/scripts/tool.mjs')).toBe(true);
    for (const path of [
      'packages/cezar/src/runs/store.test.ts',
      'packages/cezar/src/built-in-run-slots.testkit.ts',
      'packages/web/e2e/jobs.spec.ts',
      'packages/cezar/src/types.d.ts',
      'packages/cezar/src/lint/__fixtures__/reach.ts',
      'packages/cezar/src/features/jobs/README.md',
    ]) expect(bundledFeatureImport.applies(path)).toBe(false);
  });
});
