/**
 * Managed CLI storage helpers (`@hearsay-tools/squawk/plugin/managed-cli`). Kept separate from
 * `@hearsay-tools/squawk/plugin` so runners that do not lease managed CLIs do not load storage
 * code.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

export { leaseManagedCli, managedCliExecutable } from '../managed-install/cli-storage.ts';
export { managedCliHome } from '../managed-install/runtime-home.ts';
