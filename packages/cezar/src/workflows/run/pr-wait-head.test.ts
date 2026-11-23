import { expect, it } from 'vitest';
import type { SquawkWaitRequest } from '@open-mercato/cezar-contract';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { squawkWaitRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { ciWatchRequest } from '../waits.ts';
import { identicalWait, prWaitEntry } from './wait-kinds.ts';

/** hearsay-tools/squawk#3972: a PR wait registered right after the caller's own push. */
const github = 'a'.repeat(40);
const pushed = 'C'.repeat(40);
const identity = {prUrl: 'https://github.com/org/repo/pull/12', repository: 'org/repo', prNumber: 12, headSha: github};
const request = (extra: Record<string, unknown> = {}) =>
  squawkWaitRequestSchema.parse({kind: WAIT_KIND.pr, pr: identity.prUrl, ...extra}) as Extract<SquawkWaitRequest, {kind: typeof WAIT_KIND.pr}>;
const entry = (extra: Record<string, unknown> = {}) => prWaitEntry(identity, request(extra), WAIT_VIA.cezar_wait, 'generation', 'turn', Date.parse('2026-11-20T10:00:00Z'));

it('watches the pushed head while GitHub still shows the previous one, and the supervisor learns it', () => {
  const wait = entry({head_sha: pushed});
  expect(wait).toMatchObject({headSha: pushed.toLowerCase(), callerHead: true});
  expect(ciWatchRequest(wait)).toMatchObject({headSha: pushed.toLowerCase(), callerHead: true});
});

it('needs no catch-up when GitHub already shows the pushed head, or when the caller names none', () => {
  for (const wait of [entry({head_sha: github.toUpperCase()}), entry()]) {
    expect(wait.headSha).toBe(github);
    expect(wait).not.toHaveProperty('callerHead');
    expect(ciWatchRequest(wait)).not.toHaveProperty('callerHead');
  }
});

it('repeats an open wait only for the same head', () => {
  const open = {...entry({head_sha: pushed}), phase: WAIT_PHASE.open};
  expect(identicalWait([open], {kind: WAIT_KIND.pr, pr: identity.prUrl, head_sha: pushed.toLowerCase()}, 'turn')).toBe(open);
  expect(identicalWait([open], {kind: WAIT_KIND.pr, pr: identity.prUrl}, 'turn')).toBe(open);
  expect(identicalWait([open], {kind: WAIT_KIND.pr, pr: identity.prUrl, head_sha: 'd'.repeat(40)}, 'turn')).toBeUndefined();
});

it.each(['abc', 'g'.repeat(40), 'a'.repeat(41)])('refuses a head_sha that is not a full commit SHA: %s', head_sha => {
  expect(squawkWaitRequestSchema.safeParse({kind: WAIT_KIND.pr, pr: identity.prUrl, head_sha}).success).toBe(false);
});
