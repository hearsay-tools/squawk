import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { traverse, type Node } from '@babel/types';
import { describe, expect, it } from 'vitest';
import { runtimeImports } from './core/module-imports.testkit.ts';
import { blank } from './lint/blank.ts';

/**
 * Run search has one home in `packages/contract/src/run-search.ts` (hearsay-tools/cezarion#1807).
 * The oxlint AST rule `run-search-field-list-outside-contract` refuses a second field list; this
 * pins the other half: every reader still asks the contract. A reader that swapped the call for its
 * own text test would pass the rule if it listed the fields some other way.
 */
const repo = join(import.meta.dirname, '../../..');
const HOME = 'packages/contract/src/run-search.ts';
const SUBPATHS = ['@open-mercato/cezar-contract/run-search', '@open-mercato/cezar-api-client/contract/run-search'];

/** Each reader, and what it must call. The prefilter belongs to the two that read SQL rows. */
const READERS: Record<string, readonly string[]> = {
  'packages/cezar/src/artifacts/reports-index.ts': ['matchesRunSearch'],
  'packages/cezar/src/runs/run-queries.ts': ['matchesRunSearch', 'sqlPrefilterTokens'],
  'packages/cezar/src/runs/run-index.ts': ['matchesRunSearch', 'sqlPrefilterTokens'],
  'packages/web/src/lib/tasks-table.ts': ['matchesRunSearch'],
  'packages/web/src/lib/global-tasks.ts': ['matchesRunSearch'],
};

const read = (file: string) => readFileSync(join(repo, file), 'utf8');

describe('run search readers', () => {
  for (const [file, calls] of Object.entries(READERS)) {
    it(`${file} calls ${calls.join(' and ')} from the contract module`, () => {
      const source = read(file);
      expect(runtimeImports(source, file).some((specifier) => SUBPATHS.includes(specifier)), 'imports the contract module by its subpath').toBe(true);
      for (const call of calls) expect(blank(source), call).toMatch(new RegExp(`\\b${call}\\(`));
    });
  }

  it('the Reports shelf uses stored source-task search', () => {
    expect(read('packages/cezar/src/artifacts/reports-index.ts')).toContain("matchesRunSearch(summary, q, { scope: 'stored' })");
  });

  it('the contract module imports only types, so the cold reader that loads it stays cheap', () => {
    const imports: Node[] = [];
    traverse(parse(read(HOME), { sourceType: 'module', plugins: ['typescript'] }), (node) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' || node.type === 'TSImportEqualsDeclaration') imports.push(node);
    });
    expect(imports.length).toBeGreaterThan(0);
    for (const node of imports) expect(node.type === 'ImportDeclaration' && node.importKind === 'type', `line ${node.loc?.start.line} is \`import type\``).toBe(true);
  });
});
