import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { visit } from './babel-walk.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync } from '../git-command.ts';
import { blankOnce, lineAt, repoRoot } from './source-rule.ts';

/** A syntax guard for the usual probe helpers, not whole-program socket ownership analysis. */
function scanHelper(code: string): number[] {
  const findings: number[] = [];
  const listeners = [
    ...code.matchAll(/\b(\w+)\s*\.\s*listen\s*\(\s*0\b/g),
    ...code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*createServer\([^;\n]*?\)\s*\.\s*listen\s*\(\s*0\b/g),
  ];
  for (const match of listeners) {
    const server = match[1]!;
    // The port must escape a listener that is then closed. Keeping and using the
    // listener (including a test which closes it at teardown) is permitted.
    const close = new RegExp(`\\b${server}\\s*\\.\\s*close\\s*\\(`).exec(code);
    if (!close) continue;
    const address = new RegExp(`\\b${server}\\s*\\.\\s*address\\s*\\(`);
    const names = new Set<string>();
    const capture = /(?:const|let)\s+(?:\{\s*port(?:\s*:\s*(\w+))?\s*\}|(\w+))\s*=([^;\n]+)/g;
    for (const binding of code.matchAll(capture)) {
      const rhs = binding[3]!;
      if (address.test(rhs) || [...names].some(name => new RegExp(`\\b${name}\\s*\\.\\s*port\\b`).test(rhs))) {
        names.add(binding[1] ?? binding[2] ?? 'port');
      }
    }
    const tail = code.slice(close.index);
    if ([...names].some(name => new RegExp(`\\breturn\\s+${name}\\b|\\b(?:resolve|done|resolvePort)\\s*\\(\\s*${name}\\s*\\)`).test(tail))) {
      findings.push(match.index);
    }
  }
  return findings;
}

const functionNode = (node: Node): boolean => /^(?:ArrowFunctionExpression|FunctionExpression|FunctionDeclaration|ObjectMethod|ClassMethod)$/.test(node.type);

function helperCallback(parent: Node | undefined): boolean {
  const callee = parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') ? parent.callee : undefined;
  return !!callee && ((callee.type === 'Identifier' && callee.name === 'Promise')
    || (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && ['listen', 'close', 'once'].includes(callee.property.name)));
}

/** Analyze each helper separately. Promise and listener callbacks belong to the helper;
 * unrelated functions and test callbacks do not lend it their returns or closes. */
export function probeReleasePorts(source: string, file = 'fixture.ts'): number[] {
  const code = blankOnce(source);
  if (!/\.\s*listen\s*\(\s*0\b/.test(code)) return [];
  const ast = parse(source, { sourceType: 'unambiguous', plugins: /\.[jt]sx$/.test(file) ? ['typescript', 'jsx'] : ['typescript'] });
  const parents = new WeakMap<Node, Node>();
  const functions: Node[] = [];
  visit(ast, node => {
    if (functionNode(node)) functions.push(node);
    for (const value of Object.values(node)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry && typeof entry === 'object' && typeof entry.type === 'string') parents.set(entry as Node, node);
      }
    }
  });
  const findings = new Set<number>();
  for (const scope of [ast.program, ...functions]) {
    const start = scope.start ?? 0, end = scope.end ?? source.length;
    let local = code.slice(start, end);
    for (const nested of functions) {
      if (nested === scope || nested.start! < start || nested.end! > end) continue;
      if (helperCallback(parents.get(nested))) continue;
      const from = nested.start! - start, to = nested.end! - start;
      local = local.slice(0, from) + local.slice(from, to).replace(/[^\n]/g, ' ') + local.slice(to);
    }
    for (const offset of scanHelper(local)) findings.add(lineAt(source, start + offset));
  }
  return [...findings].sort((a, b) => a - b);
}

export function probeReleasePortProblems(root = repoRoot): string[] {
  const files = gitSync(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages', 'scripts', '.github/scripts', '.ai/scripts'], {
    cwd: root, maxBuffer: 16 << 20,
  }).split('\0');
  return [...new Set(files)].filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(join(root, file))).flatMap(file => {
    const source = readFileSync(join(root, file), 'utf8');
    if (!source.includes('listen') || !source.includes('address') || !source.includes('close')) return [];
    return probeReleasePorts(source, file).map(line => `${file}:${line}:0 cez/probe-release-port: bind port 0 in the listening process and report its bound port; do not release a probe port for another listener`);
  });
}
