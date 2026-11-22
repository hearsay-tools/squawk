import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every non-test source file under `dir`, testkits included; the guard tests scan these. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every test file under `dir`. */
export function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' || entry.name === 'node_modules' ? [] : testFiles(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
