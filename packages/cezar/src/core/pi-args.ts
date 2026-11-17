import { fileURLToPath } from 'node:url';

/** Base RPC flags shared by sessions and the no-model skill-list probe. */
export function piBaseArgs(): string[] {
  return ['--mode', 'rpc',
    '--extension', fileURLToPath(new URL('../../scripts/pi-retry-degraded-service.mjs', import.meta.url)),
    '--extension', fileURLToPath(new URL('../../scripts/pi-project-skills.mjs', import.meta.url))];
}
