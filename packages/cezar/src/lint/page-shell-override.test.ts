import { describe, expect, it } from 'vitest';
import { scanSource } from './ast-tree.ts';
import { pageShellStyleProblems } from './design-guardian-css.ts';
import { pageShellOverride } from './page-shell-override.ts';

function scan(file: string, source: string): string[] {
  if (!pageShellOverride.applies(file)) return [];
  const messages: string[] = [];
  scanSource(file, source, (sourceCode) =>
    pageShellOverride.create((_node, message) => {
      messages.push(message);
    }, { file, sourceCode }),
  );
  return messages;
}

describe('cez/page-shell-override', () => {
  it('blocks raw <h1> elements in route files', () => {
    const messages = scan('packages/web/src/routes/demo.tsx', 'export function Demo() { return <h1>Demo</h1> }');
    expect(messages).toEqual([expect.stringContaining('raw <h1>')]);
  });

  it('blocks raw data-route root elements outside PageShell', () => {
    const messages = scan('packages/web/src/routes/demo.tsx', 'export function Demo() { return <div data-route="demo">hi</div> }');
    expect(messages).toEqual([expect.stringContaining('setting data-route on a raw <div>')]);
  });

  it('blocks ad-hoc page header markup in route files', () => {
    const messages = scan(
      'packages/web/src/routes/demo.tsx',
      'export function Demo() { return <header data-slot="page-header">header</header> }',
    );
    expect(messages).toEqual([expect.stringContaining('ad-hoc <header data-slot="page-header">')]);
  });

  it('blocks width, horizontal padding, and centering overrides on PageShell templates', () => {
    expect(
      scan('packages/web/src/routes/demo.tsx', 'export function Demo() { return <TablePage route="demo" density="full" className="mx-auto max-w-4xl">x</TablePage> }'),
    ).toEqual([expect.stringContaining('mx-auto')]);

    expect(
      scan('packages/web/src/routes/demo.tsx', 'export function Demo() { return <FormPage route="demo" density="full" bodyClassName="md:px-9">x</FormPage> }'),
    ).toEqual([expect.stringContaining('md:px-9')]);

    expect(
      scan('packages/web/src/routes/demo.tsx', 'export function Demo() { return <SplitPage route="demo" density="full" className={cn("min-h-0", flag && "max-w-[900px]")}>x</SplitPage> }'),
    ).toEqual([expect.stringContaining('max-w-[900px]')]);
  });

  it('allows named PageShell templates without width/gutter overrides and exempt sticky headers', () => {
    expect(
      scan(
        'packages/web/src/routes/demo.tsx',
        'export function Demo() { return <TablePage route="demo" density="full" className="@container pb-8" bodyClassName="min-h-0 flex-1"><header data-slot="dialog-header">ok</header></TablePage> }',
      ),
    ).toEqual([]);

    expect(
      scan('packages/web/src/routes/task-thread/run-header.tsx', 'export function RunHeader() { return <header><h1>Task</h1></header> }'),
    ).toEqual([]);

    expect(
      scan('packages/web/src/routes/demo.test.tsx', 'export function Demo() { return <div data-route="demo"><h1>Test</h1></div> }'),
    ).toEqual([]);
  });
});

describe('pageShellStyleProblems', () => {
  it('blocks route CSS overrides on PageShell slots and route root width/padding', () => {
    expect(
      pageShellStyleProblems(
        'packages/web/src/routes/demo.css',
        `[data-slot='page-shell-frame'] { max-width: 900px; }`,
      ),
    ).toEqual([expect.stringContaining('page-shell-style')]);

    expect(
      pageShellStyleProblems(
        'packages/web/src/routes/demo.css',
        `[data-slot="page-shell-header-actions"] button { height: 32px; }`,
      ),
    ).toEqual([expect.stringContaining('page-shell-style')]);

    expect(
      pageShellStyleProblems(
        'packages/web/src/routes/demo.css',
        `[data-route="demo"] { max-width: 1100px; padding-inline: 24px; }`,
      ),
    ).toEqual([expect.stringContaining('page-shell-style')]);
  });

  it('allows PageShell own stylesheet and body-scoped route rules', () => {
    expect(
      pageShellStyleProblems(
        'packages/web/src/components/page-shell/page-shell.css',
        `[data-slot='page-shell-frame'] { max-width: 84rem; }`,
      ),
    ).toEqual([]);

    expect(
      pageShellStyleProblems(
        'packages/web/src/routes/demo.css',
        `[data-route="demo"] { width: 100%; padding-block-end: 32px; }
         [data-route="demo"] [data-slot="card"] { max-width: 680px; }`,
      ),
    ).toEqual([]);
  });
});
