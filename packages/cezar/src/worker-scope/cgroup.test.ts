import { describe, expect, it } from 'vitest';
import { cgroupCommand, cgroupPopulated, ensureCgroup, killCgroup, ownCgroup, probeCgroups, removeCgroup, workerCgroupPath, type CgroupFs } from './cgroup.ts';

/** An in-memory cgroup tree: directories, `cgroup.events`, and what each kill or removal did. */
function fakeFs(opts: { self?: string; mkdir?: (path: string) => void; busy?: number; rmdir?: (path: string) => void } = {}) {
  const dirs = new Set<string>(['/sys/fs/cgroup/app.slice/squawk.service']);
  const populated = new Set<string>();
  const log: string[] = [];
  let busy = opts.busy ?? 0;
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const fs: CgroupFs = {
    readFile: path => {
      if (path === '/proc/self/cgroup') return opts.self ?? '0::/app.slice/squawk.service\n';
      const dir = path.replace(/\/cgroup\.events$/, '');
      if (!dirs.has(dir)) throw enoent(path);
      return `populated ${populated.has(dir) ? 1 : 0}\nfrozen 0\n`;
    },
    writeFile: (path, data) => {
      const dir = path.replace(/\/cgroup\.(kill|procs)$/, '');
      if (!dirs.has(dir)) throw enoent(path);
      log.push(`write ${path} ${data}`);
      if (path.endsWith('cgroup.kill')) populated.delete(dir);
    },
    mkdir: path => { opts.mkdir?.(path); dirs.add(path); log.push(`mkdir ${path}`); },
    rmdir: path => {
      opts.rmdir?.(path);
      if (!dirs.has(path)) throw enoent(path);
      if ([...dirs].some(dir => dir.startsWith(`${path}/`))) throw Object.assign(new Error('EBUSY: has children'), { code: 'EBUSY' });
      // A process that placed itself after the kill: the kernel refuses the removal.
      if (busy > 0) { busy--; populated.add(path); throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
      dirs.delete(path); log.push(`rmdir ${path}`);
    },
    isDir: path => dirs.has(path),
    children: path => [...dirs].filter(dir => dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')),
  };
  return { fs, dirs, populated, log };
}

describe('cgroup backend', () => {
  it('reads its own unified cgroup and refuses a path that leaves the hierarchy', () => {
    expect(ownCgroup(fakeFs().fs)).toBe('/sys/fs/cgroup/app.slice/squawk.service');
    expect(ownCgroup(fakeFs({ self: '0::/\n' }).fs)).toBe('/sys/fs/cgroup');
    expect(ownCgroup(fakeFs({ self: '1:name=systemd:/x\n' }).fs)).toBeUndefined();
    expect(ownCgroup(fakeFs({ self: '0::/a/../b\n' }).fs)).toBeUndefined();
  });

  it('runs the command through a shell that moves itself first, so a failed move runs nothing', () => {
    expect(cgroupCommand('/cg/w', 'claude', ['--print', 'a b'])).toEqual(['/bin/sh', ['-c', 'echo 0 > "$0" && exec "$@"', '/cg/w/cgroup.procs', 'claude', '--print', 'a b']]);
  });

  it('a probe proves create, place and kill, and removes its group whatever happened', () => {
    const ok = fakeFs();
    expect(probeCgroups(ok.fs, () => true)).toEqual({ base: '/sys/fs/cgroup/app.slice/squawk.service' });
    expect([...ok.dirs]).toEqual(['/sys/fs/cgroup/app.slice/squawk.service']);
    const unplaced = fakeFs();
    expect(probeCgroups(unplaced.fs, () => false)).toEqual({ reason: 'cannot move a process into a child cgroup' });
    expect([...unplaced.dirs]).toHaveLength(1);
    const readOnly = fakeFs({ mkdir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    expect(probeCgroups(readOnly.fs, () => true)).toEqual({ reason: 'cannot create a child cgroup (EACCES)' });
    expect(probeCgroups(fakeFs({ self: '' }).fs, () => true)).toEqual({ reason: 'no cgroup v2 entry in /proc/self/cgroup' });
  });

  it('creates the worker cgroup once and reuses it', () => {
    const { fs, log } = fakeFs();
    const base = '/sys/fs/cgroup/app.slice/squawk.service';
    expect(ensureCgroup(base, 'w1', fs)).toBe(workerCgroupPath(base, 'w1'));
    expect(ensureCgroup(base, 'w1', fs)).toBe(workerCgroupPath(base, 'w1'));
    expect(log.filter(line => line.startsWith('mkdir'))).toHaveLength(1);
  });

  it('an absent group is empty and needs no kill', () => {
    const { fs } = fakeFs();
    expect(cgroupPopulated('/sys/fs/cgroup/gone', fs)).toBe(false);
    expect(() => killCgroup('/sys/fs/cgroup/gone', fs)).not.toThrow();
  });

  it('kills, waits until empty, and removes; a process that entered after the kill is killed in turn', async () => {
    const { fs, dirs, populated, log } = fakeFs({ busy: 2 });
    const path = ensureCgroup('/sys/fs/cgroup/app.slice/squawk.service', 'w1', fs);
    populated.add(path);
    expect(await removeCgroup(path, Date.now() + 5_000, fs)).toBe(true);
    expect(dirs.has(path)).toBe(false);
    expect(log.filter(line => line.endsWith('cgroup.kill 1'))).toHaveLength(3);
    expect(await removeCgroup(path, Date.now() + 5_000, fs)).toBe(true);
  });

  it('a probe whose group cannot be removed fails: destroy needs removal', () => {
    const fs = fakeFs({ rmdir: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } });
    expect(probeCgroups(fs.fs, () => true)).toEqual({ reason: 'cannot remove a child cgroup (EBUSY)' });
  });

  it('removes the child cgroups a worker made before its own, killing only through its own', async () => {
    const { fs: base, dirs } = fakeFs();
    const path = ensureCgroup('/sys/fs/cgroup/app.slice/squawk.service', 'w1', base);
    dirs.add(`${path}/nested`); dirs.add(`${path}/nested/deeper`);
    // A threaded child refuses its own cgroup.kill; the worker cgroup's kill covers it.
    const fs = { ...base, writeFile: (file: string, data: string) => {
      if (file.startsWith(`${path}/nested`) && file.endsWith('cgroup.kill')) throw Object.assign(new Error('EOPNOTSUPP'), { code: 'EOPNOTSUPP' });
      base.writeFile(file, data);
    } };
    expect(await removeCgroup(path, Date.now() + 5_000, fs)).toBe(true);
    expect([...dirs].filter(dir => dir.startsWith(path))).toEqual([]);
  });

  it('a lookup that fails for any reason but absence is no success', async () => {
    const { fs } = fakeFs();
    const path = ensureCgroup('/sys/fs/cgroup/app.slice/squawk.service', 'w1', fs);
    const denied = { ...fs, isDir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    expect(await removeCgroup(path, Date.now() + 5_000, denied)).toBe(false);
  });

  it('gives up at the deadline and keeps the group', async () => {
    const { fs, dirs } = fakeFs({ busy: Number.POSITIVE_INFINITY });
    const path = ensureCgroup('/sys/fs/cgroup/app.slice/squawk.service', 'w1', fs);
    expect(await removeCgroup(path, Date.now() + 30, fs)).toBe(false);
    expect(dirs.has(path)).toBe(true);
  });
});
