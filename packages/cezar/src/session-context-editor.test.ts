import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SESSION_CONTEXT_LIMIT_BYTES, SESSION_CONTEXT_REPORT_STATUSES, parseSessionContextText, previewSessionContext } from './session-context.ts';

const REPORT_STATUS = z.enum(SESSION_CONTEXT_REPORT_STATUSES).enum;

const RULES = `version: 1
rules:
  - id: vision
    on: session_start
    target: both
    template: |
      Vision:
      {{file:docs/vision.md}}
  - id: worker-brief
    on: session_start
    target: worker
    template: You are worker {{run.id}}.
  - id: missing
    on: session_start
    template: "{{file:NOPE.md}}"
`;

describe('parseSessionContextText: problems for the editor', () => {
  it('reports nothing for a valid file, an empty file and a file with no rules', () => {
    expect(parseSessionContextText(RULES).problems).toEqual([]);
    expect(parseSessionContextText('').problems).toEqual([]);
    expect(parseSessionContextText('version: 1\n').problems).toEqual([]);
  });

  it('names the line of malformed YAML', () => {
    const { problems, rules } = parseSessionContextText('version: 1\nrules:\n  - id: a\n   on: [\n');
    expect(rules).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/^Invalid YAML: /);
    expect(problems[0]!.line).toBeGreaterThanOrEqual(3);
  });

  it('reports YAML that parses but cannot be resolved, without throwing', () => {
    const parsed = parseSessionContextText('version: 1\nrules: *missing\n');
    expect(parsed.rules).toEqual([]);
    expect(parsed.reports).toEqual([expect.objectContaining({ id: 'context.yaml', status: REPORT_STATUS.skipped, reason: expect.stringMatching(/^invalid YAML: /) })]);
    expect(parsed.problems).toEqual([{ line: 1, rule: null, message: expect.stringMatching(/^Invalid YAML: /) }]);
  });

  it('reports a self-referencing version without throwing', () => {
    const parsed = parseSessionContextText('version: &v [*v]\nrules: []\n');
    expect(parsed.rules).toEqual([]);
    expect(parsed.problems).toEqual([{ line: 1, rule: null, message: 'version must be 1, not a list' }]);
  });

  it('refuses another version and a non-list rules key, on their lines', () => {
    expect(parseSessionContextText('version: 2\nrules: []\n').problems).toEqual([
      { line: 1, rule: null, message: 'version must be 1, not 2' },
    ]);
    expect(parseSessionContextText('version: 1\nrules: nope\n').problems).toEqual([
      { line: 2, rule: null, message: 'rules must be a list' },
    ]);
    expect(parseSessionContextText('- a\n').problems).toEqual([
      { line: 1, rule: null, message: 'The file must be a mapping with version and rules' },
    ]);
  });

  it('names the line of an invalid field, a reserved id and each duplicate id', () => {
    const text = [
      'version: 1',
      'rules:',
      '  - id: handoff',
      '    on: session_start',
      '    template: x',
      '  - id: dup',
      '    on: session_start',
      '    target: workers',
      '    template: x',
      '  - id: dup',
      '    on: session_start',
      '    template: x',
      '  - id: dup',
      '    on: later',
      '    template: x',
      '',
    ].join('\n');
    const { problems, rules } = parseSessionContextText(text);
    // A launch still keeps the one valid rule; the editor blocks the save on every problem.
    expect(rules.map((r) => r.id)).toEqual(['dup']);
    // Sorted by line. A duplicate id counts every rule that carries it, valid or not.
    expect(problems).toEqual([
      { line: 3, rule: 1, message: 'id "handoff" is reserved for the built-in handoff block' },
      { line: 6, rule: 2, message: 'duplicate id "dup"' },
      { line: 8, rule: 2, message: 'target must be parent, worker or both' },
      { line: 10, rule: 3, message: 'duplicate id "dup"' },
      { line: 13, rule: 4, message: 'duplicate id "dup"' },
      { line: 14, rule: 4, message: 'on must be session_start' },
    ]);
  });

  it('names a missing required field on the rule line and an unknown key on its own line', () => {
    const { problems } = parseSessionContextText('version: 1\nrules:\n  - id: a\n    on: session_start\n    colour: red\n');
    expect(problems).toEqual([
      { line: 3, rule: 1, message: 'template is required' },
      { line: 5, rule: 1, message: 'unknown key "colour"' },
    ]);
  });
});

describe('previewSessionContext', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-session-preview-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/vision.md'), 'Local first.\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('renders the draft for a parent against the project checkout, with a sample handoff first', () => {
    const preview = previewSessionContext({ projectRoot: root, content: RULES, role: 'parent' });
    expect(preview.problems).toEqual([]);
    expect(preview.limitBytes).toBe(SESSION_CONTEXT_LIMIT_BYTES);
    expect(preview.blocks.map((b) => [b.id, b.target, b.status])).toEqual([
      ['handoff', 'built-in', 'applied'],
      ['vision', 'both', 'applied'],
      ['worker-brief', 'worker', 'not-for-role'],
      ['missing', 'both', 'skipped'],
    ]);
    const vision = preview.blocks[1]!;
    expect(vision.text).toBe('Vision:\nLocal first.');
    expect(vision.bytes).toBeGreaterThan(0);
    expect(vision.sources).toEqual(['docs/vision.md']);
    expect(preview.blocks[3]!.reason).toBe('file NOPE.md: not found');
    expect(preview.usedBytes).toBe(preview.blocks.reduce((sum, b) => sum + (b.status === 'applied' ? b.bytes! : 0), 0) + 2 + 7);
  });

  it('uses labelled sample values for task variables when previewing as a worker', () => {
    const preview = previewSessionContext({ projectRoot: root, content: RULES, role: 'worker' });
    const brief = preview.blocks.find((b) => b.id === 'worker-brief')!;
    expect(brief.status).toBe('applied');
    expect(brief.text).toBe('You are worker <run.id>.');
  });

  it('shows the problems and skips every rule when the draft cannot be parsed', () => {
    const preview = previewSessionContext({ projectRoot: root, content: 'version: 3\n', role: 'parent' });
    expect(preview.problems).toHaveLength(1);
    expect(preview.blocks.map((b) => [b.id, b.status])).toEqual([['handoff', 'applied'], ['context.yaml', 'skipped']]);
  });

  it('keeps the built-in handoff applied when a draft rule takes its reserved id, and lists that rule as skipped', () => {
    const content = RULES.replace('id: vision', 'id: handoff');
    const preview = previewSessionContext({ projectRoot: root, content, role: 'parent' });
    expect(preview.blocks[0]).toMatchObject({ id: 'handoff', target: 'built-in', status: 'applied' });
    expect(preview.blocks.slice(1).map((b) => [b.id, b.target, b.status])).toEqual([
      ['worker-brief', 'worker', 'not-for-role'],
      ['missing', 'both', 'skipped'],
      ['handoff', null, 'skipped'],
    ]);
  });

  it('cuts a long block text for the preview but counts its whole size', () => {
    writeFileSync(join(root, 'docs/vision.md'), 'x'.repeat(10_000));
    const preview = previewSessionContext({ projectRoot: root, content: RULES, role: 'parent' });
    const vision = preview.blocks[1]!;
    expect(vision.text!.length).toBeLessThan(10_000);
    expect(vision.truncated).toBe(true);
    expect(vision.bytes).toBeGreaterThan(10_000);
  });
});
