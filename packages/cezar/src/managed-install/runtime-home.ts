import type { Home } from '../home/home.ts';

let bound: Home | undefined;

/**
 * The operator entry's Home, for managed CLI reads and leases. `cli-dispatch` binds it once, when it
 * resolves the Home for a command; the first binding wins and later calls change nothing. A process
 * with no bound Home (a test, a library caller) has no managed CLI and falls back to PATH.
 */
export function bindManagedCliHome(home: Home): Home {
  bound ??= home;
  return home;
}

export function managedCliHome(): Home | undefined {
  return bound;
}
