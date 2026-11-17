import { isNullLiteral, isNumberLiteral, isStringLiteral, type N, type WaitTree } from './server-wait-tree.ts';
import { placeOf, UNREAD } from './server-wait-names.ts';
import { type Scope, type WaitFile, VITEST_DEFAULT_MS, isNumber, literalBound, rawOf, sizedOutside, wordOf } from './server-wait-values.ts';

/**
 * The bound a server wait is given (hearsay-tools/squawk#3774): a Vitest wait's second argument or
 * options object, and a wait helper's arguments. A key is read the way the language reads it, as
 * far as the rule can spell it: a name, a string, or a name that every value the file gives it
 * spells as one string.
 */

/** Where a wait bound written at `node` is read: the function around it, as a wait (a parameter's default is not its bound). */
export function waitScope(file: WaitFile, node: N, at = node.start): Scope {
  const place = placeOf(file.tree, node, true);
  return { ...place, from: place.bounds.at(-1) ?? 0, to: at + 1 };
}

/** Whether parentheses open right before a node: the text then starts with `(`, and reads as no name or object. */
const parenBefore = (tree: WaitTree, node: N): boolean => tree.text[tree.source.before(node.start)] === '(';

/** The object literal a value's text starts with: the value itself, or the one its text opens with (`{ … } as const`). */
export function leadingObject(file: WaitFile, value: N): N | undefined {
  if (parenBefore(file.tree, value)) return undefined;
  let at: N | undefined = value;
  while (at && at.type !== 'ObjectExpression') at = leftChild(at);
  return at?.start === value.start ? at : undefined;
}

function leftChild(node: N): N | undefined {
  switch (node.type) {
    case 'MemberExpression': return node.object;
    case 'CallExpression': return node.callee;
    case 'ChainExpression': return node.expression;
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': return node.expression;
    case 'BinaryExpression': case 'LogicalExpression': return node.left;
    case 'ConditionalExpression': return node.test;
    case 'SequenceExpression': return node.expressions[0];
    case 'TaggedTemplateExpression': return node.tag;
    default: return undefined;
  }
}

/**
 * What a wait bound written as `node` stands for: a number, with a name read through the scopes around it.
 * `undefined` is Vitest's default and `null` is none. `undefined` for a value from outside the file, which the
 * caller sizes. With `vitest`, the position is a Vitest timeout: a name held an options object is read as one,
 * and an expression made only of what the file declares, which the rule cannot evaluate, is `NaN`.
 */
export function waitMs(file: WaitFile, at: N, node: N, vitest: boolean, depth = 0): number | undefined {
  const { tree } = file;
  const tight = !parenBefore(tree, node);
  if (tight && node.type === 'Identifier' && node.name === 'undefined' && !node.typeAnnotation && !node.optional) return VITEST_DEFAULT_MS;
  if (tight && isNullLiteral(node)) return 0;
  const place = waitScope(file, at);
  if (node.type === 'Identifier' && (node.typeAnnotation || node.optional)) return undefined;
  const word = tight ? wordOf(node) : undefined;
  if (vitest && depth < 3 && word !== undefined) {
    const objects = file.names.held(place, word, at.start).flatMap(each => (each.value === UNREAD ? [] : [leadingObject(file, each.value)].filter(Boolean) as N[]));
    const held = objects.map(object => optionsBound(file, object, depth + 1));
    if (held.length > 0) return held.includes(undefined) ? undefined : Math.min(...held.filter(isNumber));
  }
  const bound = literalBound(file, place, node, at.start, tight);
  if (bound !== undefined) return isNumber(bound) ? bound : undefined;
  return vitest && !sizedOutside(file, place, node, at.start) ? NaN : undefined;
}

/**
 * The bound an options object literal gives a Vitest wait, read from its own properties in order: Vitest's 1 s
 * default until a `timeout` names one. A spread or a key the rule cannot spell may carry any bound, so after one
 * the bound is the caller's (`undefined`) when it reads a name from outside the file and `NaN` when it reads only
 * what the file declares, until a later explicit `timeout`.
 */
export function optionsBound(file: WaitFile, object: N, depth = 0): number | undefined {
  let bound: number | undefined = VITEST_DEFAULT_MS;
  for (const property of object.properties as N[]) {
    const key = propertyKey(file, property);
    if (key === undefined) bound = entryBound(file, property);
    else if (key.name === 'timeout') bound = waitMs(file, property, key.value, true, depth);
  }
  return bound;
}

/** What an entry that may set any key leaves of the bound: the caller's, or `NaN` when it reads only what the file declares. */
function entryBound(file: WaitFile, property: N): number | undefined {
  const expression = property.type === 'SpreadElement' ? property.argument : property.computed ? property.key : property;
  return sizedOutside(file, waitScope(file, property), expression, property.start) ? undefined : NaN;
}

/** A property's key and value: `undefined` for a spread or a key the rule cannot spell; an empty name for a method or a number. */
function propertyKey(file: WaitFile, property: N): { name: string; value: N } | undefined {
  if (property.type === 'SpreadElement') return undefined;
  const method = property.method || property.kind !== 'init';
  const value: N = property.value;
  if (property.computed) {
    const name = keyText(file, property.key, property.start);
    if (name === undefined) return undefined;
    return method ? { name: '', value } : { name, value };
  }
  if (method) return { name: '', value };
  const key = property.key;
  if (isStringLiteral(key)) {
    const name = unescaped(rawOf(file.tree, key).slice(1, -1));
    return name === undefined ? undefined : { name, value };
  }
  return key.type === 'Identifier' ? { name: key.name, value: property.shorthand ? key : value } : { name: '', value };
}

/** A quoted key with its `\uXXXX`, `\u{X}` and `\xXX` escapes decoded: `"timeout"` is `timeout`. `undefined` when another escape is left. */
export function unescaped(key: string): string | undefined {
  const decoded = key.replace(/\\u\{([\da-fA-F]+)\}|\\u([\da-fA-F]{4})|\\x([\da-fA-F]{2})/g, (_, braced?: string, four?: string, two?: string) => {
    const code = Number.parseInt(braced ?? four ?? two ?? '0', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\\';
  });
  return decoded.includes('\\') ? undefined : decoded;
}

/** A node without the wrappers that change its type and not its value: `as X`, `satisfies X`, `!` and `<X>`. */
function unwrapped(tree: WaitTree, node: N): N {
  if ((node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') && /^[\w$.]+(?:<[^<>]*>)?$/.test(rawOf(tree, node.typeAnnotation))) return unwrapped(tree, node.expression);
  if (node.type === 'TSNonNullExpression') return unwrapped(tree, node.expression);
  if (node.type === 'TSTypeAssertion' && /^<[\w$.|\s]+>$/.test(tree.text.slice(node.start, tree.source.before(node.expression.start) + 1))) return unwrapped(tree, node.expression);
  return node;
}

/** The value of a string literal, or of a template without substitutions; `undefined` for anything else, or an escape other than `\u` and `\x`. */
function stringValue(tree: WaitTree, node: N): string | undefined {
  const raw = rawOf(tree, node);
  if (isStringLiteral(node) && !raw.includes('\n')) return unescaped(raw.slice(1, -1));
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return unescaped(raw.slice(1, -1));
  return undefined;
}

/**
 * The name a bracketed key spells (`{ [key]: 1 }`, `vi[key](…)`): a string, a template without substitutions, a
 * number as it is written, or a name that every value the file gives it spells as one string. Anything else is
 * `undefined`: the rule cannot say which key it is.
 */
export function keyText(file: WaitFile, node: N, at: number, depth = 0): string | undefined {
  const { tree } = file;
  const inner = unwrapped(tree, node);
  const literal = stringValue(tree, inner);
  if (literal !== undefined) return literal;
  if (isNumberLiteral(inner)) return rawOf(tree, inner);
  const word = wordOf(inner);
  if (depth > 3 || word === undefined) return undefined;
  const names = file.names.held(waitScope(file, node, at), word, at)
    .map(held => (held.value === UNREAD ? undefined : keyText(file, held.value, held.at, depth + 1)));
  return names.length > 0 && names.every(name => name !== undefined && name === names[0]) ? names[0] : undefined;
}
