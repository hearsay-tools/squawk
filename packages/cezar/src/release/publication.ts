import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ManifestLike } from './manifests.ts';
import { gitSync } from '../git-command.ts';

function sourceManifest(dir: string, manifest: ManifestLike): ManifestLike {
  if (manifest.gitHead) return manifest;
  try {
    // npm normally discovers this from its cwd. The disposable copy is outside Git;
    // retain the source SHA so stable publish retries can verify the existing version.
    const gitHead = gitSync(['rev-parse', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ...manifest, gitHead };
  } catch { return manifest; } // Local package fixtures need not be in a Git repository.
}

/** Publish a renamed manifest from a disposable copy. Never rewrite a source workspace name. */
export function withPublicationPackage<T>(dir: string, manifest: ManifestLike, action: (cwd: string) => T): T {
  const bytes = readFileSync(join(dir, 'package.json'), 'utf8');
  if (JSON.parse(bytes).name === manifest.name) return action(dir);
  const root = mkdtempSync(join(tmpdir(), 'release-package-'));
  const stage = join(root, 'package');
  try {
    cpSync(dir, stage, { recursive: true, filter: source => !['node_modules', '.git'].includes(basename(source)) });
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(sourceManifest(dir, manifest), null, 2)}\n`);
    return action(stage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
