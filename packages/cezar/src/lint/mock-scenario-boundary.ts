import type { RunnerId } from '../core/agent-runner.ts';
import { child, stringOf, type AstRule, type EsNode } from './ast-rule.ts';

/** Exhaustive runner keys keep a new backend from bypassing the import guard. */
export const RUNNER_MOCKS = {
  claude: 'mock-claude.mjs',
  codex: 'mock-codex-app-server.mjs',
  opencode: 'mock-opencode-serve.mjs',
  pi: 'mock-pi-rpc.mjs',
  omp: 'mock-omp-rpc.mjs',
} satisfies Record<RunnerId, string>;
const REQUIRED_MOCKS = new Set(Object.values(RUNNER_MOCKS).map(name => `packages/cezar/scripts/${name}`));

const SHARED = ['agent-echo', 'autonomous', 'cezar-ask', 'cezar-done', 'cezar-tool', 'ci-wait',
  'crash-stderr', 'deferred-turn-start', 'hold', 'multi-pr-refs', 'no-progress', 'gate-prompt-ack',
  'silent-tail', 'turn-messages', 'ack-only', 'busy-progress', 'provider-error',
  'resume-cezar-done', 'steer-tool', 'steer-late', 'subagent-after-park', 'cezar-wait'];
const TOKEN = /mock:([a-z0-9-]+)/g;
const NATIVE_TOKENS = new Set([
  'provider-error-early', // OpenCode rejects before creating an assistant message.
  'crash-stderr-pre-ack', // Codex and OpenCode crash before native acknowledgement.
  'no-progress-ack-only', // Codex holds its native acknowledgement without a turn.
]);
const FILE_NATIVE_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // Codex's native requestUserInput reply consumes this flag, outside shared scenarios.
  'packages/cezar/scripts/mock-codex-app-server.mjs': ['resume-cezar-done'],
  // OpenCode's native question reply consumes this flag, outside shared scenarios.
  'packages/cezar/scripts/mock-opencode-serve.mjs': ['resume-cezar-done'],
};
function sharedToken(file: string, token: string): boolean {
  if (NATIVE_TOKENS.has(token) || FILE_NATIVE_TOKENS[file]?.includes(token)) return false;
  return SHARED.some(name => token === name || token.startsWith(`${name}-`));
}

/** Scan one balanced group; escaped characters and classes cannot close it. */
function groupEnd(value: string, start: number): number {
  let depth = 1;
  let inClass = false;
  for (let i = start; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass) {
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) return i;
    }
  }
  return value.length;
}

function groupedShared(file: string, value: string): boolean {
  let start = value.indexOf('mock:(');
  while (start >= 0) {
    const content = start + 'mock:('.length;
    const end = groupEnd(value, content);
    for (const word of value.slice(content, end).match(/[a-z0-9-]+/g) ?? []) {
      if (sharedToken(file, word)) return true;
    }
    start = value.indexOf('mock:(', end + 1);
  }
  return false;
}

function namesShared(file: string, value: string, regex: boolean): boolean {
  for (const match of value.matchAll(TOKEN)) {
    if (sharedToken(file, match[1]!)) return true;
  }
  return regex && groupedShared(file, value);
}

export const mockScenarioBoundary: AstRule = {
  name: 'mock-scenario-boundary',
  description: 'Shared mock scripts belong to mock-scenario.mjs (hearsay-tools/cezarion#2769).',
  applies: file => /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
    && file !== 'packages/cezar/scripts/mock-scenario.mjs',
  create(report, { file, sourceCode }) {
    let imported = false;
    const sites: EsNode[] = [];
    const scenario = (node: EsNode) => {
      const value = stringOf(child(node, 'source'));
      if (value?.endsWith('mock-scenario.mjs')) imported = true;
    };
    return {
      ImportDeclaration: scenario,
      ExportNamedDeclaration: scenario,
      ExportAllDeclaration: scenario,
      ImportExpression: scenario,
      Literal(node) {
        const regex = node.regex as { pattern: string } | undefined;
        const value = regex?.pattern ?? (typeof node.value === 'string' ? sourceCode.getText(node).slice(1, -1) : undefined);
        if (value !== undefined && namesShared(file, value, regex !== undefined)) sites.push(node);
      },
      TemplateElement(node) {
        const value = node.value as { raw: string };
        if (namesShared(file, value.raw, false)) sites.push(node);
      },
      'Program:exit'(node) {
        if (!imported) {
          if (REQUIRED_MOCKS.has(file)) report(node, 'Runner mocks must import mock-scenario.mjs (hearsay-tools/cezarion#2774).');
          return;
        }
        for (const site of sites) report(site, 'Use mock-scenario.mjs for shared scenario selection and scripts (hearsay-tools/cezarion#2769).');
      },
    };
  },
};
