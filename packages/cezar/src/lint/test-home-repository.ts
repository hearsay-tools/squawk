import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeBoundaryMessage, scanHomeBoundary } from './home-boundary.ts';
import { lineAt, repoRoot } from './source-rule.ts';
import { testHomeWrite, testHomeWriteMessage, unsafeHomeWrites } from './test-home-write.ts';
import { gitSync } from '../git-command.ts';

/** Oxlint owns packages; use the same two scanners for test files elsewhere. */
export function externalTestHomeProblems(root = repoRoot, files?: string[]): string[] {
  const listed = files ?? gitSync(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: 16 << 20,
  }).split('\0').filter(Boolean);
  return [...new Set(listed)].filter(file => !file.startsWith('packages/') && testHomeWrite.applies(file) && existsSync(join(root, file))).flatMap(file => {
    const source = readFileSync(join(root, file), 'utf8');
    return [
      ...scanHomeBoundary(file, source).map(site => `${file}:${lineAt(source, site.offset)}:0 cez/home-boundary: ${homeBoundaryMessage(site.kind)}`),
      ...unsafeHomeWrites(source, file).map(offset => `${file}:${lineAt(source, offset)}:0 cez/test-home-write: ${testHomeWriteMessage}`),
    ];
  });
}
