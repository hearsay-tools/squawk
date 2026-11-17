import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { OWNER_POLICIES } from './owner-policies.ts';
import { callee, dotted, fragment, functionNamed, inside, key, member, objectProperty, ownerRule, walk } from './owner-rule.ts';

const writes = /^(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|cp|renameSync|rename)$/;
const removals = /^(rmSync|rm|unlinkSync|unlink)$/;
const seedWrites = /^(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)$/;
const fileLaunchers = /^(execFile|execFileSync|spawn|spawnSync)$/;
const shellLaunchers = /^(exec|execSync)$/;
const isPromisify = (node: EsNode | undefined) => node?.type === 'CallExpression' && nameOf(child(node, 'callee')) === 'promisify';

function hasRunPath(node: EsNode): boolean {
  let found = false;
  walk(node, part => { if (/(^|[/\\])runs\.json$/.test(fragment(part) ?? '')) found = true; });
  return found;
}
function hasHandoff(node: EsNode): boolean {
  let found = false;
  walk(node, part => {
    if (/handoff/i.test(nameOf(part) ?? fragment(part) ?? '')) found = true;
  });
  return found;
}

export const agentSessionSend = ownerRule(OWNER_POLICIES['agent-session-send-outside-handoff']!, report => ({
  CallExpression(node) {
    const fn = child(node, 'callee');
    const method = member(fn);
    const receiver = fn && child(fn, 'object');
    const receiverName = dotted(receiver);
    const exempt = member(receiver) === 'inputDelivery' || (receiverName !== undefined && /^(this|manager|host|this\.host)$/.test(receiverName));
    if (method !== 'sendAgentMessage' && !(method === 'sendMessage' && !exempt)) return;
    if (!inside(node, at => at.type === 'CallExpression' && nameOf(child(at, 'callee')) === 'handToTransport')) report(node);
  },
}));

export const detachedSpawn = ownerRule(OWNER_POLICIES['detached-spawn-outside-helper']!, report => ({
  Property(node) {
    if (objectProperty(node) && !node.computed && (key(node) ?? stringOf(child(node, 'key'))) === 'detached' && child(node, 'value')?.value === true) report(node);
  },
}));

/** Collect local path bindings once before visiting calls, including forward declarations. */
export const e2eRawRunSeed = ownerRule(OWNER_POLICIES['e2e-raw-run-seed']!, report => {
  const paths = new Set<string>();
  return {
    Program(node) {
      walk(node, part => {
        if (part.type !== 'VariableDeclarator') return;
        const name = nameOf(child(part, 'id'));
        const value = child(part, 'init');
        if (name && value && hasRunPath(value)) paths.add(name);
      });
    },
    CallExpression(node) {
      if (!seedWrites.test(callee(node) ?? '')) return;
      const first = children(node, 'arguments')[0];
      if (first && (hasRunPath(first) || paths.has(nameOf(first) ?? ''))) report(node);
    },
  };
});

/** File-level promisify bindings scope the cez/exec* owner rules to one program. */
export const gitSpawn = ownerRule(OWNER_POLICIES['git-spawn-outside-helper']!, report => {
  const launchers = new Set<string>();
  return {
    Program(node) {
      walk(node, part => {
        if (part.type !== 'VariableDeclarator' || !isPromisify(child(part, 'init'))) return;
        const name = nameOf(child(part, 'id'));
        if (name) launchers.add(name);
      });
    },
    CallExpression(node) {
      const fn = child(node, 'callee');
      const name = callee(node) ?? '';
      const first = children(node, 'arguments')[0];
      if ((fileLaunchers.test(name) || isPromisify(fn) || launchers.has(nameOf(fn) ?? '')) && stringOf(first) === 'git') report(node);
      else if (shellLaunchers.test(name)) {
        const prefix = first?.type === 'TemplateLiteral' ? fragment(children(first, 'quasis')[0]!) : stringOf(first);
        if (/^git\s/.test(prefix ?? '')) report(node);
      }
    },
  };
});

export const handoffWrite = ownerRule(OWNER_POLICIES['handoff-write-outside-writers']!, report => ({
  CallExpression(node) {
    const name = callee(node) ?? '';
    if ((writes.test(name) || removals.test(name)) && !inside(node, at => functionNamed(at, /^(seedHandoffFile|writeHandoffRecords|deleteHandoff)$/))) report(node);
  },
}));
export const handoffModule = ownerRule(OWNER_POLICIES['handoff-written-outside-handoff-module']!, report => ({
  CallExpression(node) {
    if (writes.test(callee(node) ?? '') && children(node, 'arguments').some(hasHandoff)) report(node);
  },
}));
export const livenessTimer = ownerRule(OWNER_POLICIES['liveness-timer-outside-owner']!, report => ({
  CallExpression(node) { if (/^(setTimeout|setInterval)$/.test(callee(node) ?? '')) report(node); },
}));

const changingFs = /^(writeFile|appendFile|copyFile|cp|rename|rm|rmdir|unlink|symlink|link|mkdir|mkdtemp|truncate|chmod|chown|lchown|utimes|lutimes|open|write|writev|createWriteStream|promises)(Sync)?$/;
const fsModule = (node: EsNode | undefined) => /^(node:)?fs(\/promises)?$/.test(stringOf(node) ?? '');
export const worktreeWrite = ownerRule(OWNER_POLICIES['worktree-write-outside-manifest']!, report => ({
  ImportDeclaration(node) {
    if (!fsModule(child(node, 'source'))) return;
    for (const specifier of children(node, 'specifiers')) {
      if (specifier.type !== 'ImportSpecifier' || changingFs.test(nameOf(child(specifier, 'imported')) ?? '')) report(specifier);
    }
  },
  ImportExpression(node) { if (fsModule(child(node, 'source'))) report(node); },
}));

export const PROCESS_OWNER_RULES: AstRule[] = [agentSessionSend, detachedSpawn, e2eRawRunSeed, gitSpawn, handoffWrite, handoffModule, livenessTimer, worktreeWrite];
