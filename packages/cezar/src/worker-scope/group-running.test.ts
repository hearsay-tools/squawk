import { describe, expect, it } from 'vitest';
import { processGroupRunning } from '../core/session-process.ts';
import { hasLinuxPython, singleThreadZombie, threadHoldingPort } from '../linux-zombie.testkit.ts';

// After a kill, a stop waits while a group of the worker's still has a running member
// (worker-scope/groups.ts `groupsStillStopping`).
describe('processGroupRunning', () => {
  it.runIf(hasLinuxPython)('counts a zombie whose other thread still holds a socket as running', async () => {
    const held = await threadHoldingPort();
    try { expect(processGroupRunning(held.pid)).toBe(true); } finally { await held.stop(); }
  });

  it.runIf(process.platform === 'linux')('does not count a single-thread zombie', async () => {
    const zombie = await singleThreadZombie();
    try { expect(processGroupRunning(zombie.pid)).toBe(false); } finally { await zombie.stop(); }
  });

  it('refuses the numbers that address every process or its own group', () => {
    expect(processGroupRunning(0)).toBe(false);
    expect(processGroupRunning(1)).toBe(false);
  });
});
