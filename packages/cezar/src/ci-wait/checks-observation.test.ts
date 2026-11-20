import { expect, it } from 'vitest';
import { parseChecksObservation } from './github.ts';

/** hearsay-tools/squawk#3972: how one checks page becomes the rows a wait decides on. */
const head = 'a'.repeat(40);
type Context = [type: 'c' | 's', id: number, name: string, workflow: string, status: string, conclusion: string, startedAt: string, link: string, required: boolean, event: string];
const page = (...contexts: Context[]) => JSON.stringify({head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', contexts});
const run = (id: number, name: string, status: string, conclusion: string, required = false, workflow = 'CI', event = 'pull_request'): Context =>
  ['c', id, name, workflow, status, conclusion, '2026-11-19T10:00:00Z', `https://github.com/org/repo/runs/${id}`, required, event];

it('keeps only the newest run of a check, so a superseded cancelled run never counts', () => {
  // hearsay-tools/squawk#3948: two Review signal runs; the newer one succeeded.
  const {checks} = parseChecksObservation(page(run(2, 'signal', 'COMPLETED', 'CANCELLED', false, 'Review signal'), run(5, 'signal', 'COMPLETED', 'SUCCESS', false, 'Review signal')));
  expect(checks).toEqual([expect.objectContaining({name: 'signal', state: 'SUCCESS', bucket: 'pass'})]);
});
it('keeps a newer queued run over an older completed one', () => {
  const {checks} = parseChecksObservation(page(run(2, 'build', 'COMPLETED', 'SUCCESS'), ['c', 9, 'build', 'CI', 'QUEUED', '', '', '', false, 'pull_request']));
  expect(checks).toEqual([expect.objectContaining({state: 'QUEUED', bucket: 'pending'})]);
});
it('keeps checks of the same name in different workflows apart', () => {
  expect(parseChecksObservation(page(run(1, 'build', 'COMPLETED', 'SUCCESS'), run(2, 'build', 'COMPLETED', 'FAILURE', false, 'Nightly'))).checks).toHaveLength(2);
});
it('keeps a push run and a pull_request run of one check apart, as gh does', () => {
  // A newer green pull_request run must not hide a red push run of the same workflow and commit.
  const {checks} = parseChecksObservation(page(run(10, 'build', 'COMPLETED', 'FAILURE', false, 'CI', 'push'), run(20, 'build', 'COMPLETED', 'SUCCESS', false, 'CI', 'pull_request')));
  expect(checks.map(c => c.bucket)).toEqual(['fail', 'pass']);
});
it('settles a check by its conclusion when its status stayed in progress, and marks it stale', () => {
  // hearsay-tools/squawk#3904: job 135031341031 reads status in_progress with conclusion success.
  const {checks} = parseChecksObservation(page(run(135031341031, 'Verify exact queue CI evidence', 'IN_PROGRESS', 'SUCCESS')));
  expect(checks).toEqual([expect.objectContaining({state: 'SUCCESS', bucket: 'pass', stale: true})]);
});
it.each([
  ['SUCCESS', 'pass'], ['NEUTRAL', 'skipping'], ['SKIPPED', 'skipping'], ['FAILURE', 'fail'], ['TIMED_OUT', 'fail'],
  ['ACTION_REQUIRED', 'fail'], ['STARTUP_FAILURE', 'fail'], ['CANCELLED', 'cancel'], ['STALE', 'pending'],
] as const)('maps the conclusion %s to the %s bucket', (conclusion, bucket) => {
  expect(parseChecksObservation(page(run(1, 'build', 'COMPLETED', conclusion))).checks[0]).toMatchObject({bucket});
});
it('reads a check with no conclusion as pending under its status', () => {
  expect(parseChecksObservation(page(run(1, 'build', 'IN_PROGRESS', ''))).checks[0]).toMatchObject({state: 'IN_PROGRESS', bucket: 'pending'});
});
it('reads commit statuses and the required flag', () => {
  const {checks} = parseChecksObservation(page(['s', 0, 'CodeRabbit', '', 'ERROR', '', '', 'https://example.com', false, ''], run(1, 'Unit, build, E2E, and package', 'COMPLETED', 'SUCCESS', true)));
  expect(checks).toEqual([
    expect.objectContaining({name: 'CodeRabbit', bucket: 'fail', required: false}),
    expect.objectContaining({name: 'Unit, build, E2E, and package', bucket: 'pass', required: true}),
  ]);
});
it('joins pages and takes the head and mergeability from the first page', () => {
  const second = JSON.stringify({head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', contexts: [run(2, 'lint', 'COMPLETED', 'SUCCESS')]});
  expect(parseChecksObservation(`${page(run(1, 'build', 'COMPLETED', 'SUCCESS'))}\n${second}\n`)).toMatchObject({headSha: head, mergeable: 'MERGEABLE', checks: [{name: 'build'}, {name: 'lint'}]});
});
it.each(['', '{bad', JSON.stringify({head: 'nope', contexts: []}), JSON.stringify({head, contexts: [['x']]})])('rejects malformed check data %j', text => {
  expect(() => parseChecksObservation(text)).toThrow(expect.objectContaining({code: 'malformed_data'}));
});
