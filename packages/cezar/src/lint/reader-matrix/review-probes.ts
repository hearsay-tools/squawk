import type { ReaderProbe } from './probes.ts';

/** Exact extra probes from review round 3 (hearsay-tools/squawk#3789). */
const W = "run.status === 'waiting'", R = 'run.autoResumeAt';
const cases = {
  // Nullish operators around nested logical text.
  qqOuterAndInnerR: `const h = ${R} ?? (x && ${W});`,
  qqOuterOrInnerL: `const h = (${W} || x) ?? ${R};`,
  qqOuterAndInnerResume: `const h = ${W} ?? (x && ${R});`,
  qqOuterResumeOrL: `const h = (${R} || x) ?? ${W};`,
  qqCallArgAnd: `const h = ${R} ?? f(a && b, ${W});`,
  qqPure: `const h = ${R} ?? ${W};`,
  qqNestedInOr: `const h = (${R} ?? x) || ${W};`,
  qqNestedInAnd: `const h = ${W} && (y ?? ${R});`,
  // assignment operators
  orAssign: `${R} ||= ${W};`,
  andAssign: `h &&= ${W} && ${R};`,
  qqAssign: `${R} ??= ${W};`,
  // non-logical LCA with && / || text between
  arrayAnd: `const h = [${R}, a && b, ${W}];`,
  callArgsAnd: `f(${R}, a && ${W});`,
  ternary: `const h = ${W} ? a || b : ${R};`,
  commaSeq: `const h = (${W}, a || b, ${R});`,
  // escaped resume name
  escResume: `const h = ${W} && run.autoResum\\u0065At;`,
  escResumeAlone: `const h = run.autoResum\\u0065At;`,
  // Additional operand spellings.
  optionalStatusMember: `const h = run.status?.x === 'waiting' && ${R};`,
  revOptional: `const h = 'waiting' === run.status?.x && ${R};`,
  revDoubleStatus: `const h = 'waiting' === a.status.b.status && ${R};`,
  fwdDoubleStatus: `const h = a.status.b.status === 'waiting' && ${R};`,
  statusIndex: `const h = run.status[0] === 'waiting' && ${R};`,
  revIndex: `const h = 'waiting' === run.status[0] && ${R};`,
  asNoParens: `const h = run.status as string === 'waiting' && ${R};`,
  looseEq: `const h = run.status == 'waiting' && ${R};`,
  revLoose: `const h = 'waiting' != run.status && ${R};`,
  computedStatus: `const h = run['status'] === 'waiting' && ${R};`,
  privateStatus: `class A { #status; f(){ return this.#status === 'waiting' && this.autoResumeAt; } }`,
  tmplLiteral: "const h = run.status === `waiting` && " + R + ";",
  newStatus: `const h = new run.status() === 'waiting' && ${R};`,
  awaitStatus: `const h = (await run.status) === 'waiting' && ${R};`,
  voidStatus: `const h = void run.status === 'waiting' && ${R};`,
  minusStatus: `const h = -run.status === 'waiting' && ${R};`,
  spreadRev: `const h = 'waiting' === run.status.x.y && ${R};`,
  revCallChain: `const h = 'waiting' === run.status.a().b && ${R};`,
  // comments in gaps
  cmtFwd: `const h = run.status /* c */ === 'waiting' && ${R};`,
  lineCmt: `const h = run.status // c\n === 'waiting' && ${R};`,
  revCmt: `const h = 'waiting' /*x*/ === /*y*/ run.status && ${R};`,
  revCmtInPath: `const h = 'waiting' === run/*y*/.status && ${R};`,
  regexBetween: `const h = run.status === 'waiting' && /&&/.test(s) && ${R};`,
  stringBetween: `const h = run.status === 'waiting' && f(';') && ${R};`,
  // window with ?? / ||
  winOr: `const h = ${W} || ${'x'.repeat(134)} || ${R};`,
  winOr2: `const h = ${W} || ${'x'.repeat(135)} || ${R};`,
  winQQ: `const h = ${W} ?? ${'x'.repeat(130)} && ${R};`,
  // arrow/object boundaries
  objBoundary: `const h = ${W} && { a: ${R} };`,
  arrowExpr: `const h = ${W} && (() => ${R});`,
  jsx: `const h = ${W} && <A b={${R}} />;`,
};

export function factReviewProbes(): ReaderProbe[] {
  // Mixing ?? with && without parentheses is invalid grammar; there is no oxlint AST to compare.
  return Object.entries(cases).filter(([name]) => name !== 'winQQ').map(([name, code]) => ({
    id: `review-3/${name}`, code,
    ...(name === 'jsx' ? { file: 'packages/cezar/src/reader-matrix-probe.tsx' } : {}),
  }));
}
