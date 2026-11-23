import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture, waitForOwnedWork } from './service-engine.testkit.ts';
import { removeAfterOwnedWork } from './service.testkit.ts';

sealTestRunners();

it('refuses directory removal when worker termination returns false', async () => {
  const f = fixture();

  await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
  // Only the termination boundary is replaced: false is its timeout result,
  // not a resolved proof that deletion is safe. Acceptance and Stop are real.
  const termination = vi.spyOn(f.manager, 'awaitRunTermination').mockResolvedValue(false);
  try {
    await expect(removeAfterOwnedWork(f.root, waitForOwnedWork(f.manager, f.store))).rejects.toThrow('Worker did not terminate');
    expect(existsSync(f.root)).toBe(true);
  } finally {
    termination.mockRestore();
    await f.close();
    vi.unstubAllEnvs();
  }
});
