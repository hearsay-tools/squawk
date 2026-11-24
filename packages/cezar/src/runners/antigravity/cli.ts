import type { ManagedCliManifest } from '../../core/managed-cli-source.ts';
import type { RunnerCli } from '../../core/runner-definition.ts';

export function parseAntigravityManifest(raw: unknown): ManagedCliManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The Antigravity CLI manifest is invalid.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.version !== 'string' || typeof record.url !== 'string' || typeof record.sha512 !== 'string') {
    throw new Error('The Antigravity CLI manifest is missing version, url, or sha512.');
  }
  if (!/^[a-fA-F0-9]{128}$/.test(record.sha512)) {
    throw new Error('The Antigravity CLI manifest sha512 is invalid.');
  }
  return {
    version: record.version,
    url: record.url,
    digest: { algorithm: 'sha512', value: record.sha512 },
  };
}

export const ANTIGRAVITY_CLI = {
  interactive: false,
  terminalExecutable: { kind: 'path-name', name: 'agy' },
  // The server has no interactive terminal or session-resume command.
  resumeArgs: () => '',
  installSource: { managed: {
    manifestUrl: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{target}.json',
    downloadUrlPrefix: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/',
    executable: 'antigravity', windowsExecutable: 'agy.exe',
    parseManifest: parseAntigravityManifest,
  } },
  openTarget: { label: 'Antigravity ACP server', icon: 'bot' },
} as const satisfies RunnerCli;
