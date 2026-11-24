import type { RunnerDisplay } from '@hearsay-tools/squawk/plugin';
export const ANTIGRAVITY_DISPLAY = {
  displayName: 'Antigravity', modelListName: 'Antigravity', modelIdScope: 'own',
  pickerLabel: 'Antigravity', pickerDescription: 'Google Antigravity CLI over ACP', icon: 'bot',
  installHint: 'Settings > Agents > Install CLI', loginCommand: 'Set GEMINI_API_KEY or GOOGLE_API_KEY, or connect a personal Google account in Settings > Agents',
  accountFolderExample: '~/.gemini',
} as const satisfies RunnerDisplay;
