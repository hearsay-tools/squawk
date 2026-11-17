/** Generated syntax probes for the twin-rule port (hearsay-tools/squawk#3774).
 * Old counts live as data beside this generator; tests never invoke ast-grep. */
export interface TwinProbe { ext: 'ts' | 'tsx'; code: string }
const wrappers = [
  (x: string) => x,
  (x: string) => '(' + x + ')',
  (x: string) => x + '!',
  (x: string) => x + ' as any',
  (x: string) => x + ' satisfies any',
  (x: string) => '<string>' + x,
  (x: string) => 'await ' + x,
];
const members = ['attention.bucket', 'attention?.bucket', 'attention!.bucket', 'attention.bucket?.bucket', '(attention).bucket', 'attention?.bucket!.bucket', '(attention!).bucket', '((attention!)).bucket'];

/** Parser-accepted cast types, including JSDoc modifiers that TypeScript rejects. */
function enumCastTypes(): string[] {
  const modifiers = [
    (x: string) => '!' + x,
    (x: string) => '?' + x,
    (x: string) => x + '!',
    (x: string) => x + '?',
  ];
  const types = new Set(['any', '(any)', '((any))']);
  let level = ['any', '(any)'];
  for (let depth = 0; depth < 2; depth++) {
    const next = new Set<string>();
    for (const type of level) for (const modify of modifiers) {
      const modified = modify(type);
      next.add(modified);
      next.add('(' + modified + ')');
    }
    for (const type of next) types.add(type);
    level = [...next];
  }
  types.add('((any))!');
  return [...types];
}

/** Reviewer matrix plus parenthesized non-null receivers: 2,720 probes; no TSX angles. */
export function attentionProbes(): TwinProbe[] {
  const cases: TwinProbe[] = [];
  for (const ext of ['ts', 'tsx'] as const) for (const member of members)
    for (let i = 0; i < wrappers.length; i++) for (let j = 0; j < wrappers.length; j++) {
      if (ext === 'tsx' && (i === 5 || j === 5)) continue;
      for (const side of [0, 1]) for (const target of ['member', 'literal']) {
        const wrap = (x: string) => wrappers[i]!(wrappers[j]!(x));
        const m = target === 'member' ? wrap(member) : member;
        const literal = target === 'literal' ? wrap("'waiting'") : "'waiting'";
        cases.push({ ext, code: 'const x = ' + (side === 0 ? m + ' === ' + literal : literal + ' !== ' + m) });
      }
    }
  return cases;
}

/** Pairwise wrappers over each rule's receiver/value forms, plus the same wrappers over calls. */
export function otherTwinProbes(name: string): TwinProbe[] {
  const cases: TwinProbe[] = [];
  for (const ext of ['ts', 'tsx'] as const) for (let i = 0; i < wrappers.length; i++) for (let j = 0; j < wrappers.length; j++) {
    if (ext === 'tsx' && (i === 5 || j === 5)) continue;
    const wrap = (x: string) => wrappers[i]!(wrappers[j]!(x));
    if (name === 'automations-capability-read-outside-owner') {
      for (const receiver of ['capabilities', 'health.capabilities', 'health?.capabilities', 'health!.capabilities', '(health).capabilities', 'health?.capabilities!.capabilities']) {
        cases.push({ ext, code: `const x = ${wrap(receiver)}.automations` });
        cases.push({ ext, code: `const x = ${wrap(receiver + '.automations')}` });
      }
    } else if (name === 'subagent-children-outside-dock') {
      for (const callee of ['subagentChildren', 'dock.subagentChildren', 'dock?.subagentChildren']) {
        cases.push({ ext, code: `const x = ${wrap(callee)}()` });
        cases.push({ ext, code: `const x = ${wrap(callee + '()')}` });
        cases.push({ ext, code: `const x = ${wrap(callee + '<T>()')}` });
      }
    } else if (name === 'test-enum-literal') {
      for (const key of ['status', "'status'", 'phase', "'phase'", "['status']", "['phase']"]) {
        const value = key.includes('phase') ? "'open'" : "'done'";
        cases.push({ ext, code: `const x = { ${key}: ${wrap(value)} }` });
        cases.push({ ext, code: `const x = ${wrap(`{ ${key}: ${value} }`)}` });
      }
    }
  }
  if (name === 'test-enum-literal') for (const ext of ['ts', 'tsx'] as const) {
    for (const type of ['!any', '(any!)', '((any!))', '(!any)', '(!any)!']) {
      cases.push({ ext, code: `const x = { status: 'done' as ${type} }` });
    }
    for (const type of enumCastTypes()) {
      cases.push({ ext, code: `const x = { status: 'done' as ${type} }` });
      cases.push({ ext, code: `const status = 'done' as ${type}` });
    }
  }
  return cases;
}
