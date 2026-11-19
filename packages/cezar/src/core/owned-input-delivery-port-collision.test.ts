import { createServer } from 'node:net';

import { expect, it, vi } from 'vitest';

import { driveSeam, waitFor } from './harness-parity.testkit.ts';


it('opencode session reaches its first turn end when the requested runner port is occupied', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  // Force the runner's candidate port to collide with a real listening socket.
  const random = vi.spyOn(Math, 'random').mockReturnValue((address.port - 40_000 + 0.5) / 20_000);
  try {
    const observed = await driveSeam('opencode', 'baseline', {
      whileOpen: async (session, { v1 }) => {
        let settled = false;
        void session.result.finally(() => { settled = true; }).catch(() => undefined);
        await waitFor(() => v1.some(e => e.type === 'turn-end' || e.type === 'error'));
        expect(v1.some(e => e.type === 'error')).toBe(false);
        expect(settled).toBe(false);
      },
    });
    expect(observed.failure).toBeUndefined();
  } finally {
    random.mockRestore();
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  }
}, 60_000);
