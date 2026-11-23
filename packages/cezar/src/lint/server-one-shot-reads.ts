import { childrenOf, walkAll, type N, type WaitTree } from './server-wait-tree.ts';
import type { Found } from './test-wait-discipline.ts';

/** Reads of mutable external state. A wait on one observation does not stop its writer. */
const READ = /^(?:get\w*|read\w*|list\w*|inspect|existsSync|statSync|readdirSync|query\w*)$/;
const WRITER = /^(?:setTimeout|setInterval|watch\w*|retry\w*|arm\w*|destroy|start\w*)$/;
const WAIT = /^(?:waitFor\w*|waitUntil|until|eventually|poll)$/;

function callName(node: N): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name;
  return callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : undefined;
}

/** A statement's own calls; callbacks have their own lifetime and are not one-shot reads. */
function ownCalls(node: N): N[] {
  const calls: N[] = [];
  const visit = (at: N): void => {
    if (at !== node && /Function/.test(at.type)) return;
    if (at.type === 'CallExpression') calls.push(at);
    for (const child of childrenOf(at)) visit(child);
  };
  visit(node);
  return calls;
}

/**
 * Conservative adjacency rule for a timer, watcher, retry or started background service: a snapshot immediately after a condition wait is a second,
 * independent observation. Retry that read itself, or await the writer's completion promise.
 * This does not try to infer whether an imported service still has a timer or watcher running.
 */
export function oneShotReadSites(tree: WaitTree): Found[] {
  const found: Found[] = [];
  walkAll(tree.root, block => {
    if (block.type !== 'BlockStatement') return;
    const statements = block.body as N[];
    for (let i = 0; i + 1 < statements.length; i += 1) {
      const statement = statements[i]!;
      const awaited = statement.type === 'ExpressionStatement' ? statement.expression
        : statement.type === 'VariableDeclaration' ? statement.declarations[0]?.init : undefined;
      if (awaited?.type !== 'AwaitExpression' || !ownCalls(awaited.argument).some(call => WAIT.test(callName(call) ?? ''))) continue;
      const frame = tree.chainOf(statement).at(-1);
      const context = frame?.body ?? block;
      let writer = false;
      const written = new Set<string>();
      walkAll(context, node => {
        if (node.start >= awaited.start || !WRITER.test(callName(node) ?? '')) return;
        writer = true;
        const callback = node.arguments[0] as N | undefined;
        if (callback) walkAll(callback, child => {
          const target = child.type === 'AssignmentExpression' ? child.left : child.type === 'UpdateExpression' ? child.argument : undefined;
          if (target?.type === 'Identifier') written.add(target.name);
        });
      });
      const predicate = tree.text.slice(awaited.start, awaited.end);
      if (!writer && !/retry|attempt|watcher/i.test(predicate)) continue;
      const next = statements[i + 1]!;
      // A second wait retries its own read. A plain await on the writer's done signal also ends adjacency.
      if (next.type !== 'VariableDeclaration' && next.type !== 'ExpressionStatement') continue;
      const reads = ownCalls(next);
      if (reads.some(call => WAIT.test(callName(call) ?? ''))) continue;
      const read = reads.find(call => READ.test(callName(call) ?? ''));
      const sampled = [...written].some(name => tree.identifiers(name).some(id => id.start >= next.start && id.end <= next.end));
      if (read || sampled) found.push({ rule: 'one-shot-read', offset: next.start });
    }
  });
  return found;
}
