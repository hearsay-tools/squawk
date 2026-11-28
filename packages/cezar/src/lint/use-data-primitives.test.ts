import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { useDataPrimitives } from './use-data-primitives.ts';

describe('cez/use-data-primitives', () => {
  ruleCases(useDataPrimitives, {
    file: 'packages/web/src/routes/example.tsx',
    valid: [
      `import { Sha, RelativeTime } from '@/components/data-primitives';
       export function Row({ sha, at }: { sha: string; at: string }) {
         return <div><Sha sha={sha} /><RelativeTime iso={at} /></div>;
       }`,
      `export function WorkerLabel({ runId }: { runId: string }) {
         return <span>{runId.slice(0, 8)}</span>;
       }`,
      `export function Tooltip({ at }: { at: string }) {
         return <span title={shortAge(at)}>meta</span>;
       }`,
      `export function Text({ text }: { text: string }) {
         return <span>{text.slice(0, 8)}</span>;
       }`,
    ],
    invalid: [
      `export function Row({ sha }: { sha: string }) { return <span>{sha.slice(0, 8)}</span>; }`,
      `export function Row({ commit }: { commit: { sha: string } }) { return <span>{commit.sha.slice(0, 7)}</span>; }`,
      `export function Row({ headSha }: { headSha: string }) { return <span>{(headSha ?? '').slice(0, 8)}</span>; }`,
      `export function Row({ at }: { at: string }) { return <span>{shortAge(at)}</span>; }`,
      `export function Row({ at }: { at: string }) { return <span>{at ? \`Synced \${shortAge(at)}\` : 'Never'}</span>; }`,
    ],
  });

  it('skips data-primitives.tsx and test files', () => {
    expect(useDataPrimitives.applies('packages/web/src/components/data-primitives.tsx')).toBe(false);
    expect(useDataPrimitives.applies('packages/web/src/routes/example.test.tsx')).toBe(false);
    expect(useDataPrimitives.applies('packages/web/src/routes/example.tsx')).toBe(true);
  });
});
