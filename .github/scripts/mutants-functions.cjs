'use strict';
// Shared AST function identities for the PR report and whole-file mutation command.
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { parse } = require('@babel/parser');

const position = p => p.line * 1e7 + p.column;
const contains = (range, point) => position(range.start) <= position(point) && position(point) < position(range.end);

/** The parser supplies syntax ranges; only names are read from each matched node's header. */
function namedRanges(nodes) {
  const classes = nodes.filter(n => /^class\s/.test(n.text)).map(n => ({ ...n, name: /^class\s+([\w$]+)/.exec(n.text)?.[1] }));
  return nodes.flatMap(n => {
    if (/^class\s/.test(n.text)) return [];
    const declaration = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(n.text);
    const variable = /^([\w$]+)\s*(?::[^=]+)?=/.exec(n.text);
    const method = /^(?:(?:public|private|protected|static|async|override|abstract|get|set|readonly)\s+)*([\w$]+)\s*(?:<[^>]+>)?\(/.exec(n.text);
    const name = declaration?.[1] ?? variable?.[1] ?? method?.[1];
    if (!name) return [];
    const owner = classes.filter(c => contains(c.range, n.range.start)).sort((a, b) => position(b.range.start) - position(a.range.start))[0];
    return [{ name: method && owner ? `${owner.name}.${name}` : name, range: n.range }];
  });
}

// Keep the former parser's syntax scope, including its excluded wrapped initializers.
function rangeNode(node) {
  if (node.type === 'VariableDeclarator') {
    return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)
      && !node.init.generator && !node.init.extra?.parenthesized;
  }
  return (node.type === 'FunctionDeclaration' && node.id && !node.generator)
    || (node.type === 'ClassDeclaration' && node.id && !node.abstract)
    || ['ClassMethod', 'ClassPrivateMethod', 'ObjectMethod'].includes(node.type);
}

/** Method decorators and decorators before export sit outside the former syntax range. */
function rangeStart(node, tokens) {
  const decorator = node.decorators?.at(-1);
  if (!decorator) return node;
  const after = tokens.find(token => token.start >= decorator.end && typeof token.type === 'object');
  if (node.type.endsWith('Method')) return after;
  if (node.type === 'ClassDeclaration' && after.type.label === 'export') {
    return tokens.find(token => token.start >= after.end && token.type.label === 'class');
  }
  return node;
}

function functionRanges(file, cwd = process.cwd()) {
  const source = readFileSync(path.resolve(cwd, file), 'utf8');
  const ast = parse(source, {
    sourceType: 'unambiguous', tokens: true,
    plugins: ['typescript', 'decorators', ...(file.endsWith('.tsx') ? ['jsx'] : [])],
  });
  const lines = source.split('\n');
  const point = loc => ({ line: loc.line - 1, column: [...lines[loc.line - 1].slice(0, loc.column)].length });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (rangeNode(node)) {
      const start = rangeStart(node, ast.tokens);
      nodes.push({ text: source.slice(start.start, node.end), range: { start: point(start.loc.start), end: point(node.loc.end) } });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(ast.program);
  return namedRanges(nodes);
}

function functionOf(location, ranges) {
  const point = { line: location.start.line - 1, column: location.start.column - 1 };
  return ranges.filter(r => contains(r.range, point)).sort((a, b) => position(b.range.start) - position(a.range.start))[0]?.name ?? '(module)';
}

/** Existing names remain stable; repeated names cannot identify one function safely. */
function duplicateNames(ranges) {
  const seen = new Set();
  const duplicates = new Set();
  for (const { name } of ranges) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

module.exports = { position, contains, namedRanges, functionRanges, functionOf, duplicateNames };
