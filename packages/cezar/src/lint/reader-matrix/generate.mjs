/** One-shot oracle capture, not a test or a repository scan (hearsay-tools/squawk#3789).
 * Run: node packages/cezar/src/lint/reader-matrix/generate.mjs
 * Imports the old scanners in memory from a temporary directory, then deletes it. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { traverse } from '@babel/types';
import { transformSync } from 'esbuild';
import { factProbes, historyProbes } from './probes.ts';
import { factDocumentedLimits } from './review-probes.ts';

const revision = '9f43ee092';
const lint = 'packages/cezar/src/lint/';
const directory = mkdtempSync(join(tmpdir(), 'reader-scanner-oracle-'));
try {
  // Load the historical import graph. Every local module comes from the same commit.
  for (const [name, probes] of [['run-history-reader', historyProbes], ['run-fact-reader', factProbes]]) {
    // Materialize the transitive local imports without copying current scanner helpers.
    const pending = [name + '.ts'];
    const seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = execFileSync('git', ['show', `${revision}:${lint}${file}`], { encoding: 'utf8' });
      // The `from` specifiers of import and export declarations, type-only ones too.
      const specifiers = [];
      traverse(parse(source, { sourceType: 'module', plugins: ['typescript'] }), (node) => {
        if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) specifiers.push(node.source);
      });
      pending.push(...specifiers.filter(literal => literal.value.startsWith('./')).map(literal => literal.value.slice(2)));
      // Resolve dependencies here; transpiled modules live outside this repository.
      let resolved = source;
      for (const { value, start, end } of specifiers.reverse()) {
        if (!value.startsWith('./') && !value.startsWith('@')) continue;
        resolved = `${resolved.slice(0, start)}${JSON.stringify(value.startsWith('./') ? value.replace(/\.ts$/, '.mjs') : import.meta.resolve(value))}${resolved.slice(end)}`;
      }
      writeFileSync(join(directory, file.replace(/\.ts$/, '.mjs')), transformSync(
        resolved, { loader: 'ts', format: 'esm' }).code);
    }
    // Readers are supplied explicitly; source-rule's historical repoRoot is never used for data.
    const scanner = await import(pathToFileURL(join(directory, name + '.mjs')).href);
    const file = 'packages/cezar/src/reader-matrix-probe.ts';
    const generated = probes();
    const digest = createHash('sha256').update(JSON.stringify(generated)).digest('hex');
    const findings = generated.map(probe => name === 'run-history-reader'
      ? scanner.scanHistoryReaders(probe.file ?? file, probe.code, []).map(site => site.kind).sort()
      : scanner.scanRunFacts(probe.file ?? file, probe.code, {}).map(site => site.rule).sort());
    const findingSets = [...new Map(findings.map(ids => [JSON.stringify(ids), ids])).values()];
    const outcomes = findings.map(ids => findingSets.findIndex(set => JSON.stringify(set) === JSON.stringify(ids)));
    // Accepted AST scope limits keep both historical findings and the chosen current findings.
    const limits = name === 'run-fact-reader' ? factDocumentedLimits() : [];
    const documentedLimits = limits.map(probe => ({ id: probe.id, expected: probe.expected,
      old: scanner.scanRunFacts(probe.file ?? file, probe.code, {}).map(site => site.rule).sort() }));
    const limitData = limits.length ? {
      limitsDigest: createHash('sha256').update(JSON.stringify({ probes: limits, documentedLimits })).digest('hex'), documentedLimits,
    } : {};
    writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify({ revision, digest, findingSets, outcomes, ...limitData }) + '\n');
    process.stdout.write(`${name}: captured ${generated.length} cells from ${revision}\n`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
