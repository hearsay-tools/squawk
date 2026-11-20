#!/usr/bin/env node
// Decides whether auto-merge may be armed on a pull request's current head. Prints
// ARM <head sha> or DO NOT ARM, then one line per reason. Exit 0 only for ARM; an
// error exits 2, which counts as do not arm.
//
// Usage: node .ai/skills/auto-merge/arm-check.mjs --pr <number> [--repo <owner/name>]
// The repository defaults to the one `gh repo view` resolves.
//
// The review apps (docs/sdlc/ci.md § Review apps) post threads after CI and the local
// review round settle. The `Protect main` ruleset requires every thread resolved, so
// queue admission removes a PR armed with an open thread. This check reads the same
// threads as queue admission: every page, outdated threads included, any author.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const { listReviewThreads } = require('../../../.github/scripts/review-threads.cjs')

/**
 * The arming decision for one pull request. `readHead` returns the live head sha;
 * `github.graphql` answers like Octokit's: the `data` object of a GraphQL reply.
 */
export async function decideArm({ github, readHead, owner, repo, pullNumber }) {
  const head = await readHead()
  const threads = await listReviewThreads({ github, owner, repo, pullNumber })
  const after = await readHead()
  const reasons = []
  if (after !== head) reasons.push(`the head moved from ${head} to ${after} during the check`)
  const unresolved = threads.filter((thread) => !thread.isResolved).length
  if (unresolved > 0) reasons.push(`${unresolved} unresolved review thread${unresolved === 1 ? '' : 's'}: answer each one first`)
  return { arm: reasons.length === 0, head: after, reasons }
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`)
  }
  return JSON.parse(gh(...args)).data
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { pr: { type: 'string' }, repo: { type: 'string' } } })
    const pullNumber = Number(values.pr)
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error('pass --pr <number>')
    const fullName = values.repo ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
    const [owner, repo] = fullName.split('/')
    if (!owner || !repo) throw new Error(`not an owner/name repository: ${fullName}`)
    const result = await decideArm({
      github: { graphql: async (query, variables) => ghGraphql(query, variables) },
      readHead: async () => gh('pr', 'view', String(pullNumber), '--repo', fullName, '--json', 'headRefOid', '--jq', '.headRefOid'),
      owner, repo, pullNumber,
    })
    console.log(result.arm ? `ARM ${result.head}` : 'DO NOT ARM')
    for (const reason of result.reasons) console.log(`- ${reason}`)
    process.exit(result.arm ? 0 : 1)
  } catch (error) {
    console.log('DO NOT ARM')
    console.log(`- the check failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
    process.exit(2)
  }
}
