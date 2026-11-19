// The test files that read a changed file directly (hearsay-tools/squawk#3940). `npm run prepr`
// waits for these and fails without their verdict; it reports the rest of Squeal's selection,
// which reaches a changed file only through other modules or a declared input, as pending.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLiteral, stringLiterals } from './e2e-affected.mjs';

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/**
 * The paths in `testFiles` that are changed themselves, or whose own string literals (import
 * specifiers, or paths the test resolves against its directory) name a changed file or a directory
 * that holds one. A file reached only through a re-export, an `index.ts` or a declared
 * `squeal.config.json` input is not direct.
 */
export function directImporters(root, testFiles, changed) {
  const changedSet = new Set(changed);
  const names = target => changedSet.has(target) || (target.endsWith('/') && changed.some(path => path.startsWith(target)));
  return testFiles.filter(file => {
    if (changedSet.has(file)) return true;
    if (!CODE.test(file) || !existsSync(join(root, file))) return false;
    return stringLiterals(readFileSync(join(root, file), 'utf8')).some(literal => {
      const target = resolveLiteral(root, file, literal);
      return target !== null && names(target);
    });
  });
}
