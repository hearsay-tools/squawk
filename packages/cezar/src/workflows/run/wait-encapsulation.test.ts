import { expect, it } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import { createWaitGroup } from './wait-registry.ts';

const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });
const define = (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value });
const set = (target: object, key: string, value: unknown) => Reflect.set(target, key, value);
const remove = (target: object, key: string) => Reflect.deleteProperty(target, key);
const prototype = (target: object, value: object | null) => Reflect.setPrototypeOf(target, value);

it.each([
  ['waitIdentity', 'ciTurnId'],
  ['autosave', 'autosaveTimer'],
  ['boundary', 'doneAtBoundary'],
  ['liveSession', 'session'],
  ['inputState', 'agentInputError'],
  ['usage', 'usageInvocation'],
] as const)('locks the %s slot, getter surface and prototype', (slot, getter) => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state[slot];
  expect(Object.isFrozen(state)).toBe(true);
  expect(set(state, 'forged', 1)).toBe(false);
  expect(Object.getOwnPropertyDescriptor(state, slot)).toMatchObject({ writable: false, configurable: false });
  expect(Object.isFrozen(group)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(group))).toBe(true);
  expect(() => replace(state, slot, {})).toThrow(TypeError);
  expect(() => replace(group, getter, 'forged')).toThrow(TypeError);
  expect(define(group, getter, 'forged')).toBe(false);
  expect(set(group, getter, 'forged')).toBe(false);
  expect(remove(state, slot)).toBe(false);
  expect(prototype(group, null)).toBe(false);
  expect(state[slot]).toBe(group);
});

it('keeps wait identity live through owner commands', () => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.waitIdentity;
  expect(group.ciTurnId).toBeUndefined();
  const first = group.ensureCiTurn();
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(group.ciTurnId).toBe(first);
  expect(group.ensureCiTurn()).toBe(first);
  group.rotateCiTurn('next-turn');
  expect(group.ciTurnId).toBe('next-turn');
  expect(group.ensureCiTurn()).toBe('next-turn');
  expect(state.waitIdentity).toBe(group);
  expect(createWaitGroup().ciTurnId).toBeUndefined();
});
