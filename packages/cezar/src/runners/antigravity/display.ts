import type { RunnerDisplay } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_DISPLAY = {
  displayName: 'Antigravity', modelListName: 'Antigravity', modelIdScope: 'own',
  pickerLabel: 'Antigravity', pickerDescription: 'Google Antigravity CLI over ACP', icon: 'bot',
  installHint: 'Settings > Accounts > Install CLI', loginCommand: 'Set GEMINI_API_KEY or GOOGLE_API_KEY, or connect a personal Google account in Settings > Accounts',
  accountFolderExample: '~/.gemini',
} as const satisfies RunnerDisplay;
