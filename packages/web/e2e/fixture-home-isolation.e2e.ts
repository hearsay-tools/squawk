import { type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootProjectId, squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'
// fixture-server starts: 1
// hearsay-tools/cezarion#1699: a fixture server must not see the invoking HOME's skills.

it('excludes invoking HOME skills from a real fixture server while keeping project skills', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-e2e-home-isolation-'))
  const invokingHome = join(root, 'invoking-home'), repo = join(root, 'repo')
  let server: ChildProcess | undefined
  const previousHome = process.env.HOME
  try {
    for (const [dir, name] of [['.agents/skills', 'host-agents-sentinel'], ['.claude/skills', 'host-claude-sentinel']] as const) {
      const skillDir = join(invokingHome, dir, name)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '# Host-only skill\nMust never reach this server.\n')
    }
    mkdirSync(repo, { recursive: true })
    // Simulate the invoking account, then restore it before any browser or tool runs.
    process.env.HOME = invokingHome
    const env = fixtureServeEnv(repo, { USERPROFILE: invokingHome })
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    delete env.VITEST // Exercise production discovery, including the global directory walk.
    server = spawnFixtureServer([squawkCli, 'serve', '--repo', repo, '--port', '0', '--no-open'], { env })
    const origin = await waitForFixtureServer(server)
    const project = await bootProjectId(origin)
    const response = await fetch(`${origin}/api/v1/p/${project}/runner-skills?runner=codex`)
    expect(response.ok).toBe(true)
    const { skills } = await response.json() as { skills: Array<{ id: string; name: string; path?: string }> }
    const names = skills.map(skill => skill.name)
    expect(names).toContain('probe-project')
    expect(skills.find(skill => skill.id === 'probe-project')?.path).toBe('.agents/skills/probe-project/SKILL.md')
    expect(skills.find(skill => skill.id === 'capture')?.path).toContain(join(repo, '.server-home'))
    expect(skills.every(skill => !skill.path?.startsWith(invokingHome))).toBe(true)
    expect(names).not.toContain('host-agents-sentinel')
    expect(names).not.toContain('host-claude-sentinel')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await stopFixtureServer(server)
    rmSync(root, { recursive: true, force: true })
  }
})
