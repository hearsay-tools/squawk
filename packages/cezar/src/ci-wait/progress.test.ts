import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activityPrProgressSchema } from '@open-mercato/cezar-contract/activity';
import type { GithubCheck } from './github.ts';
import { checkProgress, CiProgressRegistry } from './progress.ts';

const row = (name: string, bucket: GithubCheck['bucket']): GithubCheck => ({ name, state: bucket.toUpperCase(), link: '', bucket });

/** The activity view's check progress (spec 2026-11-05-live-activity-view, CI check progress). */
describe('the bucket count', () => {
  it('counts all five buckets and lists the checks in name order', () => {
    const progress = checkProgress([row('test', 'pending'), row('build', 'pass'), row('lint', 'fail'), row('docs', 'skipping'), row('e2e', 'cancel'), row('audit', 'pass')]);
    expect(activityPrProgressSchema.parse(progress)).toEqual({
      checks: [{ name: 'audit', bucket: 'pass' }, { name: 'build', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }, { name: 'e2e', bucket: 'cancel' },
        { name: 'lint', bucket: 'fail' }, { name: 'test', bucket: 'pending' }],
      counts: { pass: 2, fail: 1, pending: 1, skipping: 1, cancel: 1 },
    });
  });

  it('counts every check before it cuts the list: 101 checks with the last one pending say 100 of 101', () => {
    const rows = Array.from({ length: 101 }, (_, index) => row(`check-${String(index).padStart(3, '0')}`, index === 100 ? 'pending' : 'pass'));
    const progress = activityPrProgressSchema.parse(checkProgress(rows));
    expect(progress.counts).toEqual({ pass: 100, fail: 0, pending: 1, skipping: 0, cancel: 0 });
    expect(progress.checks).toHaveLength(100);
    expect(progress.checks.every((check) => check.bucket === 'pass')).toBe(true);
    expect(progress.truncated).toBe(true);
  });

  it('cleans terminal escapes out of a name and clamps it to 100 characters', () => {
    const [check] = checkProgress([row(`\x1b[31mred\x1b[0m ${'x'.repeat(200)}`, 'fail')]).checks;
    expect(check!.name).toBe(`red ${'x'.repeat(96)}`);
  });

  it('reads no checks yet as empty counts', () => {
    expect(checkProgress([])).toEqual({ checks: [], counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 } });
  });
});

describe('the progress registry', () => {
  it('holds the latest read: a check moves from pending to pass between two snapshots', () => {
    const registry = new CiProgressRegistry();
    const waitId = randomUUID();
    registry.publish(waitId, [row('build', 'pending')]);
    expect(registry.read(waitId)?.checks).toEqual([{ name: 'build', bucket: 'pending' }]);
    registry.publish(waitId, [row('build', 'pass')]);
    expect(registry.read(waitId)).toEqual({ checks: [{ name: 'build', bucket: 'pass' }], counts: { pass: 1, fail: 0, pending: 0, skipping: 0, cancel: 0 } });
  });

  it('records nothing for a wait this process does not watch', () => {
    expect(new CiProgressRegistry().read(randomUUID())).toBeUndefined();
  });

  it('forgets a removed wait; a new registry starts empty', () => {
    const registry = new CiProgressRegistry();
    const waitId = randomUUID();
    registry.publish(waitId, [row('build', 'pass')]);
    registry.remove(waitId);
    expect(registry.read(waitId)).toBeUndefined();
    expect(new CiProgressRegistry().read(waitId)).toBeUndefined();
  });
});

describe('the progress registry change signal', () => {
  it('signals a changed progress and a removed entry, and nothing else', () => {
    const registry = new CiProgressRegistry();
    let changes = 0;
    const release = registry.onChange(() => { changes++; });
    const pending: GithubCheck = { name: 'build', state: 'PENDING', link: '', bucket: 'pending' };
    registry.publish('wait', [pending]);
    registry.publish('wait', [pending]); // the same read again changes nothing
    registry.publish('wait', [{ ...pending, state: 'SUCCESS', bucket: 'pass' }]);
    registry.remove('wait');
    registry.remove('wait');
    expect(changes).toBe(3);
    release();
    registry.publish('wait', [pending]);
    expect(changes).toBe(3);
  });
});
