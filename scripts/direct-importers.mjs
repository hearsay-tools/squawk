// The test files that read a changed file directly (hearsay-tools/squawk#3940). `npm run prepr`
// waits for these and fails without their verdict; it reports the rest of Squeal's selection,
// which reaches a changed file only through other modules or a declared input, as pending.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { literalCandidates, stringLiterals } from './e2e-affected.mjs';

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/**
 * The paths in `testFiles` that are changed themselves, or whose own string literals (import
 * specifiers, or paths the test resolves against its directory) may name a changed file, or a
 * directory below the test's own directory that holds one. Whether the path still exists does not
 * matter, so a deleted file or directory counts too. A file reached only through a re-export, an
 * `index.ts` or a declared `squeal.config.json` input is not direct.
 */
export function directImporters(root, testFiles, changed) {
  const changedSet = new Set(changed);
  const holds = dir => changed.some(path => path.startsWith(`${dir}/`));
  return testFiles.filter(file => {
    if (changedSet.has(file)) return true;
    if (!CODE.test(file) || !existsSync(join(root, file))) return false;
    const own = `${posix.dirname(file)}/`;
    return stringLiterals(readFileSync(join(root, file), 'utf8')).some(literal =>
      literalCandidates(file, literal).map(path => path.replace(/\/+$/, '')).some(path =>
        changedSet.has(path) || (path.startsWith(own) && holds(path))));
  });
}
