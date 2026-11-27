import { describe, expect, it } from 'vitest'

import { cliLines } from './cli-lines'

describe('cliLines', () => {
  it('puts each env assignment, the command and each flag on its own continued line', () => {
    const line = `HSQ_COCKPIT_URL='http://127.0.0.1:3695' HSQ_PROJECT_ID='p' hsq automation add --name 'Nightly' --cron '0 4 * * *' --no-autonomous --prompt 'Bump what'\\''s stale --now'`
    expect(cliLines(line)).toBe([
      `HSQ_COCKPIT_URL='http://127.0.0.1:3695' \\`,
      `  HSQ_PROJECT_ID='p' \\`,
      `  hsq automation add \\`,
      `  --name 'Nightly' \\`,
      `  --cron '0 4 * * *' \\`,
      `  --no-autonomous \\`,
      `  --prompt 'Bump what'\\''s stale --now'`,
    ].join('\n'))
  })

  it('keeps a quoted JSON body as one word', () => {
    expect(cliLines(`hsq automation create --json '{"name": "a b"}'`)).toBe(`hsq automation create \\\n  --json '{"name": "a b"}'`)
  })
})
