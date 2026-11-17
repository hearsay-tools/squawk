/** Syntax matrices for the old run-reader scanners (hearsay-tools/squawk#3789). */
export interface ReaderProbe { id: string; code: string }

/** Method kinds cross key forms in both method containers. Invalid grammar is not a cell. */
export function historyProbes(): ReaderProbe[] {
  const probes: ReaderProbe[] = [];
  const kinds = ['', 'get ', 'set ', 'async ', '*', 'async *'];
  const classKinds = [...kinds, ...kinds.map(kind => 'static ' + kind), ...kinds.map(kind => 'private ' + kind), ...kinds.map(kind => 'private static ' + kind)];
  for (const name of ['historyPaths', 'eventsPath']) for (const container of ['object', 'class']) {
    const keys = [name, `'${name}'`, `"${name}"`, `['${name}']`, `[${name}]`, `[(${name})]`, '[`' + name + '`]'];
    if (container === 'class') keys.push('#' + name);
    for (const kind of container === 'class' ? classKinds : kinds) for (const key of keys) {
      // TypeScript disallows an accessibility modifier before a private identifier.
      if (kind.startsWith('private ') && key.startsWith('#')) continue;
      const args = kind.endsWith('set ') ? 'value' : '';
      const method = `${kind}${key}(${args}) {}`;
      probes.push({ id: `${name}/${container}/${kind || 'method'}/${key}`, code: container === 'class'
        ? `class Helpers { ${method} }` : `const helpers = { ${method} };` });
    }
  }
  return probes;
}

const wrappers: Record<string, (value: string) => string> = {
  bare: value => value,
  parentheses: value => `(${value})`,
  as: value => `((${value}) as boolean)`,
  satisfies: value => `((${value}) satisfies boolean)`,
  nonnull: value => `(${value})!`,
  angle: value => `(<boolean>(${value}))`,
  unary: value => `!(${value})`,
  call: value => `Boolean(${value})`,
  await: value => `(await (${value}))`,
  nestedCall: value => `outer(Boolean(${value}))`,
};

/** Wrappers cross both join directions, operators, comparison orders and expression positions. */
export function factProbes(): ReaderProbe[] {
  const probes: ReaderProbe[] = [
    { id: 'issue/as-wrapped-negation', code: '!((run.status === "waiting") as boolean) || !run.autoResumeAt;' },
    { id: 'issue/call-argument', code: "Boolean(run.status === 'waiting') && run.autoResumeAt;" },
    ...factOperandProbes(),
  ];
  for (const [comparison, wait] of Object.entries({ forward: "run.status === 'waiting'", reverse: "'waiting' !== run.status" })) {
    for (const [outerName, outer] of Object.entries(wrappers)) for (const [innerName, inner] of Object.entries(wrappers)) {
      for (const operator of ['&&', '||']) for (const direction of ['forward', 'reverse']) {
        const comparisonCode = outer(inner(wait));
        const resume = 'run.autoResumeAt';
        const expression = direction === 'forward' ? `${comparisonCode} ${operator} ${resume}` : `${resume} ${operator} ${comparisonCode}`;
        probes.push({ id: `${comparison}/${outerName}/${innerName}/${operator}/${direction}`, code: `const hold = ${expression};` });
      }
    }
  }
  for (const [name, wrap] of Object.entries(wrappers)) for (const position of ['wait', 'resume', 'whole']) {
    for (const context of ['if', 'return', 'argument', 'callback', 'default', 'field']) {
      const wait = "run.status === 'waiting'", resume = 'run.autoResumeAt';
      const expression = position === 'whole' ? wrap(`${wait} && ${resume}`)
        : `${position === 'wait' ? wrap(wait) : wait} && ${position === 'resume' ? wrap(resume) : resume}`;
      const code = {
        if: `if (${expression}) go();`,
        return: `function hold() { return ${expression}; }`,
        argument: `consume(${expression});`,
        callback: `consume(() => ${expression});`,
        default: `function hold(value = ${expression}) {}`,
        field: `class Hold { value = ${expression}; }`,
      }[context]!;
      probes.push({ id: `${name}/${position}/${context}`, code });
    }
  }
  return probes;
}

/** Operand spelling matters to the historical lexical scanner even when ESTree erases it. */
export function factOperandProbes(): ReaderProbe[] {
  const probes: ReaderProbe[] = [];
  const statuses = [
    'run.status', '(run.status)', '((run.status))', '(run.status as string)', 'run.status!',
    '(run).status', '(run as Run).status', 'run?.status', 'owner.run.status', 'runs[0].status',
    "run['status']", 'run. status', 'run./* gap */status',
  ];
  const literals = ["'waiting'", '"waiting"', '`waiting`', "('waiting')", "('waiting' as string)", "'waiting'!", "'wa\\u0069ting'"];
  const containers: Record<string, (value: string) => string> = {
    bare: value => value,
    call: value => `Boolean(${value})`,
    arrow: value => `(() => ${value})`,
    calledArrow: value => `(() => ${value})()`,
    arrowArgument: value => `consume(() => ${value})`,
    blockArrow: value => `(() => { return ${value}; })`,
    calledBlockArrow: value => `(() => { return ${value}; })()`,
    function: value => `(function () { return ${value}; })`,
    calledFunction: value => `(function () { return ${value}; })()`,
  };
  for (const status of statuses) for (const literal of literals) for (const order of ['forward', 'reverse']) {
    const comparison = order === 'forward' ? `${status} === ${literal}` : `${literal} !== ${status}`;
    for (const [container, wrap] of Object.entries(containers)) for (const direction of ['forward', 'reverse']) {
      const value = wrap(comparison);
      const expression = direction === 'forward' ? `${value} && run.autoResumeAt` : `run.autoResumeAt || ${value}`;
      probes.push({ id: `operand/${status}/${literal}/${order}/${container}/${direction}`, code: `const hold = ${expression};` });
    }
  }
  return probes;
}
