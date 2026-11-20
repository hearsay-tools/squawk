import type { RunnerDisplay } from '../../core/runner-definition.ts';

/** How the cockpit and server messages name the OpenCode runner (its `display` part). */
export const OPENCODE_DISPLAY = {
  displayName: 'OpenCode',
  modelListName: 'OpenCode',
  modelIdScope: 'provider-spanning',
  pickerLabel: 'opencode',
  pickerDescription: 'OpenCode (serve)',
  icon: 'bot',
  installHint: 'https://opencode.ai',
  loginCommand: 'opencode auth login',
} as const satisfies RunnerDisplay;
