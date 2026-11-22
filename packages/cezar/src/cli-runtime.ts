/** Install process services before loading commands that read runner or removal registries. */
export async function prepareCommandRuntime(command: string): Promise<void> {
  const { installWindowsIdentityStore } = await import('./delegation/windows-identity-store.ts');
  installWindowsIdentityStore();
  if (!['serve', 'run', 'init', 'projects', 'server-install', 'server-deploy', 'server-uninstall',
    'migrate', 'server-migrate', 'migrate-project', 'discover', 'task'].includes(command)) return;
  const { registerBuiltInRunners } = await import('./runners/built-in.ts');
  registerBuiltInRunners();
  const { registerBuiltInRunSlots } = await import('./built-in-run-slots.ts');
  registerBuiltInRunSlots();
}
