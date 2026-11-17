import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_RULES, designGuardian, guardianFindings as originalGuardianFindings, stripComments } from './design-guardian.ts';
import { guardianCssFiles, guardianCssProblems, statusStyleProblems } from './design-guardian-css.ts';

import { checkRule } from './ast-rule.testkit.ts';

import { DESIGN_SAMPLES } from './design-guardian.testkit.ts';

/** CSS keeps its runner; source fixtures also exercise oxlint nodes. */
function guardianFindings(file: string, source: string) {
  const expected = originalGuardianFindings(file, source);
  if (!file.endsWith('.css')) {
    let code = source;
    // Allowed-path fixtures historically supplied a token rather than a JS statement.
    if (Object.values(DESIGN_SAMPLES).includes(source)) code = JSON.stringify(source);
    if (source === 'CEZ_DRY_RUN CEZ_HOME') code = 'const pair = { CEZ_DRY_RUN, CEZ_HOME };';
    const findings = checkRule(designGuardian, file, code);
    expect(findings).toHaveLength(expected.length);
    for (const [index, finding] of findings.entries()) expect(finding.message).toContain(expected[index]!.message.split(' — ')[0]!);
  }
  return expected;
}

const sampleFile = (name: string) => name === 'fixture-serve-must-pin-cez-home' ? 'packages/web/e2e/sample.e2e.ts' : 'packages/web/src/sample.tsx';

describe('design guardian scanner', () => {
  it.each(Object.entries(DESIGN_SAMPLES))('%s reports its original name and real line', (name, token) => {
    const findings = guardianFindings(sampleFile(name), `// ignored\nconst value = "${token}";`);
    expect(findings).toEqual([expect.objectContaining({ line: 2, message: expect.stringContaining(`${name} —`) })]);
    expect(findings[0]?.message).toContain(name === 'no-dark-variant' ? 'dark:' : token);
  });

  it('finds direct native dialog calls through comments before their arguments', () => {
    for (const source of [
      "confirm /* explain */ ('Delete?');",
      "window.alert /* explain */ ('Saved');",
      "globalThis.prompt /* explain */ ('Name');",
    ]) {
      const findings = guardianFindings('packages/web/src/sample.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('no-native-dialogs —');
    }
    expect(guardianFindings('packages/web/src/sample.tsx', "confirm // explain\n('Delete?');")).toEqual([]);
    expect(guardianFindings('packages/web/src/sample.tsx', "confirm?.('Delete?'); other.confirm('Delete?'); window['confirm']('Delete?'); (confirm)('Delete?'); (window).confirm('Delete?'); confirm<string>('Delete?');"))
      .toEqual([]);
  });

  it('reports tokens on their real lines inside multiline literals', () => {
    const source = 'const classes = `safe\ntext-pending\ntext-pending`;';
    const findings = checkRule(designGuardian, 'packages/web/src/sample.tsx', source);
    expect(findings.map(finding => finding.line)).toEqual([2, 3]);
    expect(findings.every(finding => finding.message.startsWith('no-amber-text —'))).toBe(true);
    const fixture = checkRule(designGuardian, 'packages/web/e2e/sample.e2e.ts', 'const env = `safe\nCEZ_DRY_RUN`;');
    expect(fixture.map(finding => finding.line)).toEqual([2]);
  });

  it('covers every original rule', () => {
    expect(Object.keys(DESIGN_SAMPLES)).toEqual(DESIGN_RULES.map((rule) => rule.name));
  });

  it('keeps strings, URLs and positions while removing comments', () => {
    expect(stripComments('"https://example.test" // #abc\n/* text-pending */ "h-screen"', true))
      .toBe('"https://example.test"        \n                   "h-screen"');
    expect(stripComments('/* #abc */\n// #abc', false)).toBe('          \n// #abc');
  });

  it.each(DESIGN_RULES.filter((rule) => rule.allowed))('%s keeps allowed file predicates', (rule) => {
    const files = ['src/styles/index.css', 'src/components/ui/button.tsx', 'src/routes/tasks-overview.tsx', 'src/routes/task-thread/thread-items.tsx', 'src/routes/task-git/commit-list.tsx', 'src/components/centered-state.tsx', 'src/components/ui/dialog.tsx', 'src/components/zoomable-image.tsx'];
    for (const file of files.filter((file) => rule.allowed!(file))) {
      expect(guardianFindings(`packages/web/${file}`, DESIGN_SAMPLES[rule.name]!).filter((finding) => finding.message.startsWith(rule.name))).toEqual([]);
    }
  });

  it('keeps style, executable, e2e and SELF scope', () => {
    expect(guardianFindings('packages/web/src/sample.test.ts', '"h-screen"')).toEqual([]);
    expect(guardianFindings('packages/web/e2e/sample.e2e.ts', '"h-screen"')).toEqual([]);
    expect(guardianFindings('packages/web/src/design-guardian.test.ts', 'confirm()')).toEqual([]);
    expect(guardianFindings('packages/cezar/src/sample.ts', 'confirm()')).toEqual([]);
    expect(guardianFindings('packages/web/src/sample.test.ts', 'confirm()')).toHaveLength(1);
    expect(guardianFindings('packages/web/e2e/sample.e2e.ts', 'CEZ_DRY_RUN CEZ_HOME')).toEqual([]);
  });

  it('recognizes every direct fill-accent ink spelling the cockpit supports', () => {
    const rule = DESIGN_RULES.find(({ name }) => name === 'no-fill-accent-as-ink')!;
    const pattern = new RegExp(rule.pattern.source);
    for (const source of [
      'text-accent-strong',
      'text-[var(--accent-strong)]',
      '[color:var(--accent-strong)]',
      "style={{ color: 'var(--accent-strong)' }}",
      'color: var(--accent-strong);',
    ]) {
      expect(source, source).toMatch(pattern);
    }
  });
});

describe('design guardian CSS runner', () => {
  it('discovers nested CSS, scans the shared table and keeps allowed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-css-'));
    try {
      for (const [file, text] of Object.entries({
        'src/nested/bad.css': '/* #abc */\na { color: #abc; height: 100vh; }',
        'src/styles/index.css': ':root { --color: #abc; }',
        'e2e/fixture.css': 'a { color: #abc; }',
        'src/skip.ts': '"#abc"',
      })) {
        const target = join(root, 'packages/web', file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      expect(guardianCssFiles(root).sort()).toEqual(['packages/web/e2e/fixture.css', 'packages/web/src/nested/bad.css', 'packages/web/src/styles/index.css']);
      const problems = guardianCssProblems(root);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain('bad.css:2:');
      expect(problems.join('\n')).toContain('no-100vh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    '[data-slot="status-dot"] { display: none; }',
    '[data-slot="status-dot"] { width: 2px; }',
    '[data-status="done"] [data-slot="pill"] { color: red; }',
  ])('refuses a sheet that changes the status key: %s', (css) => {
    expect(statusStyleProblems('packages/web/src/status.css', css)).toHaveLength(1);
  });

  it('allows positioning and ignores commented status overrides', () => {
    expect(statusStyleProblems('packages/web/src/status.css', '/* [data-slot="status-dot"] { display: none; } */\n[data-slot="status-dot"] { margin: 1px; }')).toEqual([]);
  });
});
