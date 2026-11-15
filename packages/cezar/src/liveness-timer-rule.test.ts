import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { rulesDir, runAstGrep } from './ast-grep-rules.testkit.ts';

/** `liveness-timer-outside-owner` (hearsay-tools/squawk#3662): a timer in `workflows/run/` outside the owner is refused. */
const ruleSchema = z.object({ ignores: z.array(z.string()) }).passthrough();
const matchesSchema = z.array(z.object({ file: z.string() }));
const rule = ruleSchema.parse(parse(readFileSync(join(rulesDir, 'liveness-timer-outside-owner.yml'), 'utf8')));
const allowList = rule.ignores.filter(file => !file.includes('*'));
const scan = async (args: string[], cwd?: string) => {
  const run = await runAstGrep(['scan', '--json=compact', ...args], cwd);
  expect(run.code, run.stderr).toBe(0);
  return new Set(matchesSchema.parse(JSON.parse(run.stdout)).map(match => match.file));
};

it('keeps a timer in every allow-listed file', async () => {
  expect(allowList).toContain('packages/cezar/src/workflows/run/liveness-timers.ts');
  const matched = await scan(['--inline-rules', stringify({ ...rule, ignores: [] }), ...allowList]);
  for (const file of allowList) expect(matched.has(file), `${file} arms no timer: remove its stale allow-list entry`).toBe(true);
// bound: the shared ast-grep process guard is 100 s; leave time for it to report a hang.
}, 120_000);

it('refuses a new timer in workflows/run/ and allows the owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-liveness-rule-'));
  try {
    const owner = 'packages/cezar/src/workflows/run/liveness-timers.ts';
    const refused = ['packages/cezar/src/workflows/run/probe.ts', 'packages/cezar/src/workflows/run/nested/probe.ts', 'packages/cezar/src/workflows/run.ts'];
    const elsewhere = 'packages/cezar/src/workflows/probe.ts';
    for (const file of [owner, ...refused, elsewhere]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'export const timer = setTimeout(() => {}, 1000);\n');
    }
    const matched = await scan(['--inline-rules', stringify(rule), 'packages'], root);
    expect([...matched].sort()).toEqual([...refused].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
// bound: the shared ast-grep process guard is 100 s; leave time for it to report a hang.
}, 120_000);
