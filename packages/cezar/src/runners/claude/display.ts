import type { RunnerDisplay } from '../../core/runner-definition.ts';

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
