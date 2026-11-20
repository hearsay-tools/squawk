#!/usr/bin/env node
// Decides whether auto-merge may be armed on a pull request's current head. Prints
// ARM <head sha>, WAIT or DO NOT ARM, then one line per reason. Exit 0 only for ARM;
// WAIT and DO NOT ARM exit 1; an error exits 2, which counts as do not arm.
//
// Usage: node .ai/skills/auto-merge/arm-check.mjs --pr <number> --head <reviewed sha> [--repo <owner/name>]
// --head is the head the reviewer round and the auto-merge decision covered; a live
// head that differs refuses. The repository defaults to the one `gh repo view` resolves.
//
// The review apps (docs/sdlc/ci.md § Review apps) post threads after CI and the local
// review round settle. The `Protect main` ruleset requires every thread resolved, so
// queue admission removes a PR armed with an open thread. This check reads the same
// threads as queue admission: every page, outdated threads included, any author.
// It also waits while CodeRabbit's check run on the head has not completed: until
// then, CodeRabbit's threads for that head can still arrive.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const { listReviewThreads } = require('../../../.github/scripts/review-threads.cjs')

// The review app whose check run on the head shows that its review is still running.
export const REVIEWING_APP = { slug: 'coderabbitai', checkName: 'CodeRabbit' }

/**
 * The arming decision for one pull request: 'arm', 'wait' or 'refuse'. `reviewedHead`
 * is the head the reviewer round covered. `readHead`
 * returns the live head sha; `readCheckRuns(sha)` returns the head's check runs named
 * REVIEWING_APP.checkName; `github.graphql` answers like Octokit's: the `data` object
 * of a GraphQL reply.
 */
export async function decideArm({ github, reviewedHead, readHead, readCheckRuns, owner, repo, pullNumber }) {
  const head = await readHead()
  if (head !== reviewedHead) {
    return { outcome: 'refuse', head, reasons: [`the head is ${head}, not the reviewed head ${reviewedHead}: decide again for the new head`] }
  }
  // Check runs first: a review that completes after this read posted its threads
  // before the thread read below, so a completed run never hides one of its threads.
  const runs = await readCheckRuns(head)
  const threads = await listReviewThreads({ github, owner, repo, pullNumber })
  const after = await readHead()
  if (after !== head) return { outcome: 'refuse', head: after, reasons: [`the head moved from ${head} to ${after} during the check`] }
  const unresolved = threads.filter((thread) => !thread.isResolved).length
  if (unresolved > 0) {
    return { outcome: 'refuse', head, reasons: [`${unresolved} unresolved review thread${unresolved === 1 ? '' : 's'}: answer each one first`] }
  }
  const reviewing = runs.some((run) => run?.app?.slug === REVIEWING_APP.slug && run.status !== 'completed')
  if (reviewing) return { outcome: 'wait', head, reasons: [`${REVIEWING_APP.checkName} is reviewing ${head}: run the check again when its check run completes`] }
  return { outcome: 'arm', head, reasons: [] }
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
    const { values } = parseArgs({ options: { pr: { type: 'string' }, head: { type: 'string' }, repo: { type: 'string' } } })
    const pullNumber = Number(values.pr)
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error('pass --pr <number>')
    if (!/^[0-9a-f]{40}$/.test(values.head ?? '')) throw new Error('pass --head <the reviewed 40-character sha>')
    const fullName = values.repo ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
    const [owner, repo] = fullName.split('/')
    if (!owner || !repo) throw new Error(`not an owner/name repository: ${fullName}`)
    const result = await decideArm({
      github: { graphql: async (query, variables) => ghGraphql(query, variables) },
      reviewedHead: values.head,
      readHead: async () => gh('pr', 'view', String(pullNumber), '--repo', fullName, '--json', 'headRefOid', '--jq', '.headRefOid'),
      readCheckRuns: async (sha) => {
        const runs = JSON.parse(gh('api', `repos/${fullName}/commits/${sha}/check-runs?check_name=${REVIEWING_APP.checkName}&per_page=100`)).check_runs
        if (!Array.isArray(runs)) throw new Error('Malformed check runs')
        return runs
      },
      owner, repo, pullNumber,
    })
    console.log({ arm: `ARM ${result.head}`, wait: 'WAIT', refuse: 'DO NOT ARM' }[result.outcome])
    for (const reason of result.reasons) console.log(`- ${reason}`)
    process.exit(result.outcome === 'arm' ? 0 : 1)
  } catch (error) {
    console.log('DO NOT ARM')
    console.log(`- the check failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
    process.exit(2)
  }
}
