import type { RunnerCli } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_CLI = {
  interactive: false,
  terminalExecutable: { kind: 'path-name', name: 'agy' },
  // The server has no interactive terminal or session-resume command.
  resumeArgs: () => '',
  installSource: { managed: {
    manifestUrl: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{target}.json',
    downloadUrlPrefix: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/',
    executable: 'antigravity', windowsExecutable: 'agy.exe',
  } },
  openTarget: { label: 'Antigravity ACP server', icon: 'bot' },
} as const satisfies RunnerCli;
