import { child, children, nameOf, type AstRule, type EsNode } from './ast-rule.ts';
import { propertyName, unwrap, walk } from './ast-syntax.ts';

const isFunction = (node: EsNode): boolean => /^(?:ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/.test(node.type);

/** Promise and socket callbacks belong to their enclosing helper. Other functions do not. */
function helper(node: EsNode): EsNode {
  let scope = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    scope = parent;
    if (!isFunction(parent)) continue;
    const call = parent.parent;
    const callee = call ? child(call, 'callee') : undefined;
    if (call?.type === 'NewExpression' && nameOf(callee) === 'Promise') continue;
    if (call?.type === 'CallExpression' && ['listen', 'close', 'once'].includes(propertyName(callee) ?? '')) continue;
    return parent;
  }
  return scope;
}

function binding(node: EsNode | undefined): string | undefined {
  if (node?.type !== 'ObjectPattern') return nameOf(node);
  const port = children(node, 'properties').find(property => propertyName(child(property, 'key')) === 'port');
  return port && nameOf(child(port, 'value'));
}

function declaration(node: EsNode): EsNode | undefined {
  for (let parent = node.parent; parent && !isFunction(parent); parent = parent.parent) {
    if (parent.type === 'VariableDeclarator') return parent;
  }
  return undefined;
}

interface Listener { nodes: EsNode[]; closed: boolean; names: Set<string> }
interface Helper {
  listeners: Map<string, Listener>;
  aliases: Array<{ name: string; from: string }>;
  returns: Set<string>;
  calls: Array<{ callee: string; argument: string }>;
  resolvers: Set<string>;
}

const message = 'Bind port 0 in the listening process and report its bound port; do not release a probe port for another listener (hearsay-tools/squawk#3665).';

/** Static syntax: local listener names, address/port captures, return and Promise resolution.
 * No imports, aliases across helpers or dynamically computed property names are followed. */
export const probeReleasePort: AstRule = {
  name: 'probe-release-port',
  description: 'A listener must own its ephemeral port (hearsay-tools/squawk#3665).',
  applies: file => /^(?:packages|scripts|\.github\/scripts|\.ai\/scripts)\//.test(file),
  create(report) {
    const scopes = new Map<EsNode, Helper>();
    const facts = (node: EsNode): Helper => {
      const owner = helper(node);
      let state = scopes.get(owner);
      if (!state) {
        state = { listeners: new Map(), aliases: [], returns: new Set(), calls: [], resolvers: new Set() };
        scopes.set(owner, state);
      }
      return state;
    };
    const listener = (state: Helper, name: string): Listener => {
      let found = state.listeners.get(name);
      if (!found) { found = { nodes: [], closed: false, names: new Set() }; state.listeners.set(name, found); }
      return found;
    };
    return {
      NewExpression(node) {
        if (nameOf(child(node, 'callee')) !== 'Promise') return;
        const executor = children(node, 'arguments')[0];
        const resolver = executor && nameOf(children(executor, 'params')[0]);
        if (resolver) facts(node).resolvers.add(resolver);
      },
      CallExpression(node) {
        const state = facts(node);
        const callee = unwrap(child(node, 'callee'));
        const argument = nameOf(unwrap(children(node, 'arguments')[0]));
        const called = nameOf(callee);
        if (called && argument) state.calls.push({ callee: called, argument });
        if (callee?.type !== 'MemberExpression') return;
        const object = unwrap(child(callee, 'object'));
        const receiver = nameOf(object) ?? (object?.type === 'CallExpression' ? binding(child(declaration(node) ?? node, 'id')) : undefined);
        if (!receiver) return;
        const found = listener(state, receiver);
        switch (propertyName(callee)) {
          case 'listen':
            if (unwrap(children(node, 'arguments')[0])?.value === 0) found.nodes.push(node);
            break;
          case 'close': found.closed = true; break;
          case 'address': {
            const name = binding(child(declaration(node) ?? node, 'id'));
            if (name) found.names.add(name);
            break;
          }
        }
      },
      VariableDeclarator(node) {
        const name = binding(child(node, 'id'));
        const init = child(node, 'init');
        if (!name || !init) return;
        walk(init, part => {
          if (part.type !== 'MemberExpression' || propertyName(part) !== 'port') return;
          const from = nameOf(unwrap(child(part, 'object')));
          if (from) facts(node).aliases.push({ name, from });
        });
      },
      ReturnStatement(node) {
        const name = nameOf(unwrap(child(node, 'argument')));
        if (name) facts(node).returns.add(name);
      },
      'Program:exit'() {
        for (const state of scopes.values()) {
          for (const found of state.listeners.values()) {
            if (!found.closed || found.nodes.length === 0) continue;
            for (const alias of state.aliases) if (found.names.has(alias.from)) found.names.add(alias.name);
            const escaped = [...found.names].some(name => state.returns.has(name)
              || state.calls.some(call => call.argument === name && state.resolvers.has(call.callee)));
            if (escaped) for (const node of found.nodes) report(node, message);
          }
        }
      },
    };
  },
};
