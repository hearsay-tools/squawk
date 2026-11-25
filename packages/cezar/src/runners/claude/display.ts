import type { RunnerDisplay } from '@hearsay-tools/squawk/plugin';

/** How the cockpit and server messages name the Claude runner (its `display` part). */
export const CLAUDE_DISPLAY = {
  displayName: 'Claude Code',
  modelListName: 'Claude',
  modelIdScope: 'own',
  pickerLabel: 'claude',
  pickerDescription: 'Claude Code CLI',
  icon: 'bot',
  installHint: 'npm i -g @anthropic-ai/claude-code',
  loginCommand: 'claude auth login',
  accountFolderExample: '~/.claude-second',
} as const satisfies RunnerDisplay;
