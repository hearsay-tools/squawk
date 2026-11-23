import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { stepKindSchema } from '@open-mercato/cezar-contract/run-status';
import { waitSchema, waitViaSchema } from '@open-mercato/cezar-contract/waits';
import { BUILT_IN_WAIT_KINDS, BUILT_IN_WAIT_VIAS, CONTRACT_WAIT_KINDS, LEGACY_WAIT_KINDS } from './wait-kind-ids.ts';
import { BUILT_IN_STEP_KINDS, CONTRACT_STEP_KINDS } from './step-kind-ids.ts';

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('plain extension id data modules', () => {
  it('stay aligned with built-in wait-kind registrations and wait contract schemas', async () => {
    vi.resetModules();
    const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('../built-in-wait-kinds.ts');
    const { registeredWaitKinds } = await import('./run/wait-kind-registry.ts');
    registerBuiltInWaitKinds();
    sealBuiltInWaitKinds();
    expect(sorted(registeredWaitKinds().map(row => row.kind))).toEqual(sorted(BUILT_IN_WAIT_KINDS));
    expect(sorted(waitSchema.options.map(entry => entry.shape.kind.value))).toEqual(sorted(CONTRACT_WAIT_KINDS));
    expect([...waitViaSchema.options]).toEqual([...BUILT_IN_WAIT_VIAS]);
    expect(LEGACY_WAIT_KINDS.filter(kind => (CONTRACT_WAIT_KINDS as readonly string[]).includes(kind))).toEqual([]);
  });

  it('stay aligned with built-in step-kind registrations and step contract schemas', async () => {
    vi.resetModules();
    const { registerBuiltInStepKinds, registeredStepKinds, sealBuiltInStepKinds } = await import('./step-kind-registry.ts');
    registerBuiltInStepKinds();
    sealBuiltInStepKinds();
    expect(registeredStepKinds().map(definition => definition.kind)).toEqual([...BUILT_IN_STEP_KINDS]);
    expect([...stepKindSchema.options]).toEqual([...CONTRACT_STEP_KINDS]);
  });

  it.each(['wait-kind-ids.ts', 'step-kind-ids.ts'])('%s has an empty import closure (zero runtime or feature modules)', async file => {
    const dir = import.meta.dirname;
    const result = await build({
      entryPoints: [join(dir, file)], absWorkingDir: dir, bundle: true, write: false, metafile: true,
      platform: 'node', format: 'esm', packages: 'external', outdir: join(dir, '.closure'), logLevel: 'silent',
    });
    const output = Object.values(result.metafile.outputs).find(entry => entry.entryPoint);
    const inputs = Object.keys(output?.inputs ?? {}).map(input => relative(dir, join(dir, input)));
    expect(inputs).toEqual([file]);
    expect(output?.imports ?? []).toEqual([]);
  });
});
