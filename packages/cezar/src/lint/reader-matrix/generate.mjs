/** One-shot oracle capture, not a test or a repository scan (hearsay-tools/squawk#3789).
 * Run: node packages/cezar/src/lint/reader-matrix/generate.mjs
 * Imports the old scanners in memory from a temporary directory, then deletes it. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { factProbes, historyProbes } from './probes.ts';

const revision = '9f43ee092';
const lint = 'packages/cezar/src/lint/';
const directory = mkdtempSync(join(tmpdir(), 'reader-scanner-oracle-'));
try {
  // Bundle the historical import graph. Every local module comes from the same commit.
  for (const [name, probes] of [['run-history-reader', historyProbes], ['run-fact-reader', factProbes]]) {
    // Materialize the transitive local imports without copying current scanner helpers.
    const pending = [name + '.ts'];
    const seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = execFileSync('git', ['show', `${revision}:${lint}${file}`], { encoding: 'utf8' });
      const imports = [...source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map(match => match[1]);
      pending.push(...imports);
      // Native Node TypeScript loading resolves packages from this repository via absolute imports.
      const resolved = source.replace(/from (['"])(@[^'"]+|\.\/[^'"]+)\1/g, (_match, _quote, specifier) =>
        `from ${JSON.stringify(specifier.startsWith('./') ? specifier.replace(/\.ts$/, '.mjs') : import.meta.resolve(specifier))}`);
      writeFileSync(join(directory, file.replace(/\.ts$/, '.mjs')), transformSync(
        resolved, { loader: 'ts', format: 'esm' }).code);
    }
    // Readers are supplied explicitly; source-rule's historical repoRoot is never used for data.
    const scanner = await import(pathToFileURL(join(directory, name + '.mjs')).href);
    const file = 'packages/cezar/src/reader-matrix-probe.ts';
    const cells = probes().map(probe => ({ ...probe, findings: name === 'run-history-reader'
      ? scanner.scanHistoryReaders(file, probe.code, []).map(site => site.kind).sort()
      : scanner.scanRunFacts(file, probe.code, {}).map(site => site.rule).sort() }));
    writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify({ revision, cells }, null, 2) + '\n');
    process.stdout.write(`${name}: captured ${cells.length} cells from ${revision}\n`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
