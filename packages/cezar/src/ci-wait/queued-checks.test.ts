import { afterEach, expect, it, vi } from 'vitest';
import { CI_QUEUED_BOUND_MS, QueuedCheckClock } from './queued-checks.ts';
const queued = {name:'build',link:'https://github.com/org/repo/actions/runs/1/job/2',state:'QUEUED',bucket:'pending'};
afterEach(()=>vi.useRealTimers());
it('starts at first observation and does not reset the clock on another queued snapshot', () => {
 vi.useFakeTimers();const clock=new QueuedCheckClock();const start=Date.now();clock.observe([queued]);
 expect(clock.deadline()).toBe(start+CI_QUEUED_BOUND_MS);expect(clock.diagnostic()).toBeUndefined();
 vi.advanceTimersByTime(CI_QUEUED_BOUND_MS-1);clock.observe([queued]);expect(clock.diagnostic()).toBeUndefined();
 vi.advanceTimersByTime(1);expect(clock.diagnostic()).toContain('queued for at least 15 minutes');
});
it.each([[],[{...queued,state:'IN_PROGRESS'}],[{...queued,state:'PENDING'}],[{...queued,state:'SUCCESS',bucket:'pass'}]].map(rows=>({rows})))('resets the clock when a snapshot no longer shows queued: $rows', ({rows}) => {
 vi.useFakeTimers();const clock=new QueuedCheckClock();clock.observe([queued]);vi.advanceTimersByTime(14*60_000);
 clock.observe(rows);expect(clock.deadline()).toBe(Infinity);clock.observe([queued]);vi.advanceTimersByTime(60_000);
 expect(clock.diagnostic()).toBeUndefined();vi.advanceTimersByTime(14*60_000);expect(clock.diagnostic()).toContain('15 minutes');
});
it('starts a fresh clock for another link with the same name, and for another wait or restart', () => {
 vi.useFakeTimers();const clock=new QueuedCheckClock();clock.observe([queued]);vi.advanceTimersByTime(CI_QUEUED_BOUND_MS);
 clock.observe([{...queued,link:queued.link+'3'}]);expect(clock.diagnostic()).toBeUndefined();
 const restarted=new QueuedCheckClock();restarted.observe([queued]);expect(restarted.diagnostic()).toBeUndefined();
});
