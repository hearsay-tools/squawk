import type { CallExpression, Node, ObjectExpression } from '@babel/types';
import { calleeOf, declaredHere, definition, heldBy, keyName, mathFunctions, numberOf, optionObjects, placeFor, ownNames, rootsOf, smallest, unwrap, type Place, type Read, type Use, type View } from './unit-wait-values.ts';
import { isPath } from './unit-wait-deadlines.ts';
import { unescaped } from './test-wait-discipline.ts';

/** The server scanner has always recognized the zero-argument bigint clock too. */
export function serverClock(node: Node): boolean {
  if (node.type !== 'CallExpression' || node.arguments.length !== 0 || node.callee.type !== 'MemberExpression' || node.callee.computed) return false;
  const { object, property } = node.callee;
  if (property.type !== 'Identifier') return false;
  if (object.type === 'Identifier') return property.name === 'now' ? object.name === 'Date' || object.name === 'performance' : property.name === 'hrtime' && object.name === 'process';
  return property.name === 'bigint' && object.type === 'MemberExpression' && !object.computed && object.object.type === 'Identifier' && object.object.name === 'process' && object.property.type === 'Identifier' && object.property.name === 'hrtime';
}

/** The server's numeric evaluator, now fed AST nodes (hearsay-tools/squawk#3774). */
export function serverNumber(node: Node | null | undefined, read: Read): number | undefined {
  if (!node) return undefined;
  const inner = unwrap(node);
  if (inner.type === 'CallExpression') {
    const callee = calleeOf(inner.callee);
    const fn = callee?.object === 'Math' ? mathFunctions.get(callee.name) : undefined;
    const args = inner.arguments.map(argument => serverNumber(argument, read));
    return fn && args.length > 0 && args.every((value): value is number => typeof value === 'number') ? fn(...args) : undefined;
  }
  if (inner.type === 'UnaryExpression' && (inner.operator === '+' || inner.operator === '-')) {
    const value = serverNumber(inner.argument, read);
    return value === undefined ? undefined : inner.operator === '-' ? -value : value;
  }
  if (inner.type === 'BinaryExpression') {
    const left = serverNumber(inner.left, read);
    const right = serverNumber(inner.right, read);
    if (left === undefined || right === undefined) return undefined;
    const operations: Record<string, number> = { '+': left + right, '-': left - right, '*': left * right, '/': left / right, '%': left % right, '**': left ** right };
    return operations[inner.operator];
  }
  return numberOf(inner, read);
}

/** A helper parameter's default belongs to its definition, never to each call in its body. */
export function serverRead(place: Place, depth = 0): Read {
  return name => {
    if (depth > 3 || definition(place.view, place.use, name)?.kind === 'param') return undefined;
    return smallest(heldBy(place.view, place.use, name, true).map(held => serverNumber(held.value, serverRead(placeFor(place.view, held.use), depth + 1))));
  };
}

/** Server aliases pass through paths, never a clock expression used as an ordinary value. */
function sizedOutside(node: Node, view: View, use: Use, depth = 0): boolean {
  return rootsOf(node).some(name => {
    if (ownNames.has(name)) return false;
    if (!declaredHere(view, use, name)) return true;
    const held = depth < 3 ? heldBy(view, use, name) : [];
    return held.length > 0 && held.every(each => isPath(each.value)) && held.some(each => sizedOutside(each.value, view, each.use, depth + 1));
  });
}

function milliseconds(node: Node, place: Place): number | undefined {
  if (node.type === 'Identifier' && node.name === 'undefined') return 1_000;
  if (node.type === 'NullLiteral') return 0;
  return serverNumber(node, place.read) ?? (sizedOutside(node, place.view, place.use) ? undefined : NaN);
}

function serverKey(key: Node, computed: boolean, place: Place, text: (node: Node) => string): string | undefined {
  const inner = unwrap(key);
  if (inner.type === 'StringLiteral' && unescaped(text(inner).slice(1, -1)) === undefined) return undefined;
  return keyName(key, computed, place);
}

/** Preserve the server's conservative handling of non-Unicode/hex escapes in quoted keys. */
function optionsBound(object: ObjectExpression, place: Place, text: (node: Node) => string): number | undefined {
  let bound: number | undefined = 1_000;
  for (const property of object.properties) {
    const name = property.type === 'SpreadElement' ? undefined : serverKey(property.key, property.computed, place, text);
    if (name === 'timeout' && property.type === 'ObjectProperty') bound = milliseconds(property.value, place);
    else if (name === undefined) bound = sizedOutside(property.type === 'SpreadElement' ? property.argument : property.key, place.view, place.use) ? undefined : NaN;
  }
  return bound;
}

/** The server also recognizes a computed Vitest member held in a constant. */
export function serverVitestBound(call: CallExpression, place: Place, text: (node: Node) => string): number | undefined {
  const callee = call.callee;
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return undefined;
  const name = serverKey(callee.property, callee.computed, place, text);
  const wait = callee.object.name === 'vi' ? name === 'waitFor' || name === 'waitUntil' : callee.object.name === 'expect' && name === 'poll';
  if (!wait) return undefined;
  const argument = call.arguments[1];
  if (!argument) return 1_000;
  const objects = optionObjects(argument, place);
  if (objects.length === 0) return milliseconds(argument, place);
  return smallest(objects.map(({ object, place: at }) => optionsBound(object, { ...at, read: serverRead(at) }, text)));
}
