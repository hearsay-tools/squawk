// The test files that read a changed file directly (hearsay-tools/squawk#3940). `npm run prepr`
// waits for these and fails without their verdict; it reports the rest of Squeal's selection,
// which reaches a changed file only through other modules or a declared input, as pending.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const ALIASES = [
  ['@open-mercato/cezar-api-client', 'packages/api-client/src'],
  ['@open-mercato/cezar-contract', 'packages/contract/src'],
];

function aliasBase(from, literal) {
  if (literal.startsWith('@/')) return from.startsWith('packages/web/src/') ? posix.join('packages/web/src', literal.slice(2)) : null;
  for (const [name, dir] of ALIASES) {
    if (literal === name) return `${dir}/index`;
    if (literal.startsWith(`${name}/`)) return posix.join(dir, literal.slice(name.length + 1));
  }
  return null;
}

/** The repository paths a string literal in `from` may name, in resolution order, whether they exist or not. */
export function literalCandidates(from, literal) {
  if (!/^[\w@.~/-]+$/.test(literal) || !/[\w~-]/.test(literal) || literal.startsWith('/')) return [];
  const base = aliasBase(from, literal) ?? posix.join(posix.dirname(from), literal);
  if (base.startsWith('../') || base.split('/').includes('node_modules')) return [];
  const stem = base.replace(/\.(?:m?js|jsx)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}

/** String literals in a code file, after its comments are removed. */
export function stringLiterals(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  return [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n$])+)\1/g)].map(match => match[2]);
}

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
