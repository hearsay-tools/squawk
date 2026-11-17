import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { OWNER_POLICIES } from './owner-policies.ts';
import { dotted, fragment, functionNamed, inside, key, member, methodNamed, objectProperty, ownerRule, staticMember, unwrap, unwrapAccess, walk } from './owner-rule.ts';

const outcomeFields = /^(deliveredAt|consumedAt|cancelledAt|automaticWakes|waitDeliveryFailures|lastWaits)$/;
const runFacts = /^(workflowCursor|continuesStepId|parkReason|doneAccepted)$/;

/** Schema declarations are syntax exceptions, not writes of stored facts. */
function schemaValue(node: EsNode, broad: boolean): boolean {
  const value = child(node, 'value');
  if (!value) return false;
  let base = value;
  while (base.type === 'CallExpression' || base.type === 'MemberExpression') {
    const next = child(base, base.type === 'CallExpression' ? 'callee' : 'object');
    if (!next) break;
    base = next;
  }
  let found = nameOf(base) === 'z' && value.type !== 'Identifier';
  walk(value, part => {
    const path = dotted(part);
    if (path && /Schema\./.test(path)) found = true;
    if (broad && /Schema\b/.test(nameOf(part) ?? fragment(part) ?? '')) found = true;
  });
  return found;
}
function fieldWrite(node: EsNode, fields: RegExp): boolean {
  if (objectProperty(node)) return fields.test(key(node) ?? '');
  return node.type === 'AssignmentExpression' && node.operator === '=' && fields.test(member(child(node, 'left')) ?? '');
}
function kindProperty(node: EsNode, value: RegExp): boolean {
  return objectProperty(node) && key(node) === 'kind' && value.test(stringOf(child(node, 'value')) ?? '');
}
function chargedObject(node: EsNode): boolean {
  const object = node.parent;
  return object?.type === 'ObjectExpression' && children(object, 'properties').some(property => {
    if (key(property) !== 'kind') return false;
    const value = unwrap(child(property, 'value'));
    return value?.type === 'Literal' && /^(charged|counted)$/.test(stringOf(value) ?? '');
  });
}

export const nudgeFactWrite = ownerRule(OWNER_POLICIES['nudge-fact-write-outside-owner']!, report => ({
  Property(node) { if (kindProperty(node, /^nudge-fact$/)) report(node); },
}));

export const outcomeWrite = ownerRule(OWNER_POLICIES['outcome-write-outside-commit-outcome']!, report => {
  const check = (node: EsNode) => {
    const phase = objectProperty(node) && key(node) === 'phase' && /^(delivered|cancelled)$/.test(stringOf(child(node, 'value')) ?? '');
    if (!fieldWrite(node, outcomeFields) && !phase) return;
    if (chargedObject(node) || schemaValue(node, false)) return;
    if (!inside(node, at => functionNamed(at, /^(ciWaitEntry|workerWaitEntry|upgradeLegacyWaits|settleLegacyAgentWait)$/))) report(node);
  };
  return { Property: check, AssignmentExpression: check };
});

function doneOwner(node: EsNode): boolean {
  if (functionNamed(node, /^(recordDoneAccepted|retireDoneAccepted|spendDoneFreeTurn|upgradeLegacyWorkflowCursor|upgradeLegacyDoneAccepted)$/)) return true;
  if (node.type === 'Property' && node.method === true) return /^done-(accepted|retired|free-turn)$/.test(stringOf(child(node, 'key')) ?? '');
  return node.type === 'TSTypeAliasDeclaration';
}
export const runFactWrite = ownerRule(OWNER_POLICIES['run-fact-write-outside-owner']!, report => {
  const check = (node: EsNode) => {
    if (!fieldWrite(node, runFacts) && !kindProperty(node, /^done-(accepted|retired|free-turn)$/)) return;
    if (!schemaValue(node, true) && !inside(node, doneOwner)) report(node);
  };
  return { Property: check, AssignmentExpression: check };
});

export const runMemoryField = ownerRule(OWNER_POLICIES['run-memory-field-outside-owner']!, report => ({
  PropertyDefinition(node) {
    const value = child(node, 'value');
    if (value?.type === 'NewExpression' && /^(Map|Set|WeakMap)$/.test(nameOf(child(value, 'callee')) ?? '')) report(node);
  },
}));

function activeRun(node: EsNode | undefined): boolean {
  node = unwrapAccess(node);
  if (!node) return false;
  if (/^(state|active)$/.test(nameOf(node) ?? '') || member(node) === 'state') return true;
  if (node.type !== 'CallExpression') return false;
  return dotted(child(node, 'callee')) === 'this.active.get';
}
function skillsGroup(node: EsNode | undefined): boolean {
  node = unwrapAccess(node);
  return staticMember(node, 'skills') && activeRun(node && child(node, 'object'));
}
function catalog(node: EsNode): boolean {
  return staticMember(node, 'catalog') && skillsGroup(child(node, 'object'));
}
/** A ChainExpression wraps optional members before their assignment or enclosing access. */
function plainWrite(node: EsNode): boolean {
  let at = node;
  while (at.parent?.type === 'ChainExpression') at = at.parent;
  return at.parent?.type === 'AssignmentExpression' && at.parent.operator === '=' && child(at.parent, 'left') === at;
}
export const skillsRead = ownerRule(OWNER_POLICIES['skills-read-outside-enabled-skills']!, report => {
  const check = (node: EsNode) => {
    if (!inside(node, at => methodNamed(at, 'enabledSkills'))) report(node);
  };
  return {
    MemberExpression(node) { if (catalog(node) && !plainWrite(node)) check(node); },
    VariableDeclarator(node) {
      const pattern = child(node, 'id');
      if (!skillsGroup(child(node, 'init')) || pattern?.type !== 'ObjectPattern') return;
      if (children(pattern, 'properties').some(property => property.shorthand === true && key(property) === 'catalog' && child(property, 'value')?.type === 'Identifier')) check(node);
    },
  };
});
export const skillsWrite = ownerRule(OWNER_POLICIES['skills-write-outside-load-run-skills']!, report => {
  const check = (node: EsNode) => {
    if (!inside(node, at => methodNamed(at, 'loadRunSkills'))) report(node);
  };
  return {
    AssignmentExpression(node) {
      const left = unwrapAccess(child(node, 'left'));
      if (left && catalog(left)) check(left);
    },
    CallExpression(node) { if (dotted(child(node, 'callee')) === 'skillsWrites.catalog') check(node); },
  };
});

export const STATE_OWNER_RULES: AstRule[] = [nudgeFactWrite, outcomeWrite, runFactWrite, runMemoryField, skillsRead, skillsWrite];
