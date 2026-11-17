import type { RunnerSkill as Skill } from '@open-mercato/cezar-api-client/contract/runner-skills'
// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { WorkflowDef } from '@open-mercato/cezar-api-client'

import {
  bumpSkillUsage,
  filterSkills,
  fuzzyMatch,
  isProjectSkill,
  matchScore,
  multiWordFilter,
  orderSkills,
  orderSkillsByUsage,
  partitionSkillsForDisplay,
  queryScore,
  searchSkills,
  searchSkillsForDisplay,
  searchWorkflows,
  skillKeywords,
  skillUsedBy,
} from './skills'

const skill = (over: Partial<Skill> & Pick<Skill, 'name' | 'scope'>): Skill => ({
  id: over.name,
  path: `/skills/${over.name}.md`,
  ...over,
})

describe('isProjectSkill / orderSkills (#377)', () => {
  it('classifies every server source value', () => {
    expect(isProjectSkill(skill({ id: 'a', name: 'a', scope: 'repo' }))).toBe(true)
    expect(isProjectSkill(skill({ id: 'b', name: 'b', scope: 'repo' }))).toBe(true)
    expect(isProjectSkill(skill({ id: 'c', name: 'c', scope: 'repo' }))).toBe(true)
    expect(isProjectSkill(skill({ id: 'd', name: 'd', scope: 'user' }))).toBe(false)
    expect(isProjectSkill(skill({ id: 'e', name: 'e', scope: 'repo' }))).toBe(true)
  })

  it('orders local and team project skills before user-global skills, stably within each tier', () => {
    const ordered = orderSkills([
      skill({ id: 'g1', name: 'g1', scope: 'user' }),
      skill({ id: 'p1', name: 'p1', scope: 'repo' }),
      skill({ id: 'g2', name: 'g2', scope: 'repo' }),
      skill({ id: 'p2', name: 'p2', scope: 'repo' }),
    ])
    expect(ordered.map((s) => s.name)).toEqual(['p1', 'g2', 'p2', 'g1'])
  })
})

describe('partitionSkillsForDisplay / orderSkillsByUsage (#519: most-used → project → global)', () => {
  const skills = [
    skill({ id: 'g1', name: 'g1', scope: 'user' }),
    skill({ id: 'p1', name: 'p1', scope: 'repo' }),
    skill({ id: 'g2', name: 'g2', scope: 'user' }),
    skill({ id: 'p2', name: 'p2', scope: 'repo' }),
  ]

  it('promotes USED skills above locality — a used global outranks an unused project skill', () => {
    const ordered = orderSkillsByUsage(skills, { g2: 5, p2: 9, p1: 1 })
    // Most used first (frequency descending, regardless of locality), then the unused
    // remainder project-first — the #519 contract, replacing the #408 locality-first inversion.
    expect(ordered.map((s) => s.name)).toEqual(['p2', 'g2', 'p1', 'g1'])
  })

  it('splits into the three tiers without repeating a promoted skill in its locality group', () => {
    const tiers = partitionSkillsForDisplay(skills, { g2: 5, p1: 1 })
    expect(tiers.mostUsed.map((s) => s.name)).toEqual(['g2', 'p1'])
    expect(tiers.project.map((s) => s.name)).toEqual(['p2'])
    expect(tiers.global.map((s) => s.name)).toEqual(['g1'])
  })

  it('caps Most used at the limit; overflow falls back into its locality group', () => {
    const usage = { g1: 9, p1: 8, g2: 7, p2: 6 }
    const tiers = partitionSkillsForDisplay(skills, usage, { mostUsedLimit: 2 })
    expect(tiers.mostUsed.map((s) => s.name)).toEqual(['g1', 'p1'])
    // The overflow (g2, p2) is NOT dropped — it rejoins its locality tier in server order.
    expect(tiers.project.map((s) => s.name)).toEqual(['p2'])
    expect(tiers.global.map((s) => s.name)).toEqual(['g2'])
  })

  it('zero usage everywhere → empty mostUsed and the plain #377 project-first split', () => {
    for (const usage of [undefined, {}]) {
      const tiers = partitionSkillsForDisplay(skills, usage)
      expect(tiers.mostUsed).toEqual([])
      expect(tiers.project.map((s) => s.name)).toEqual(['p1', 'p2'])
      expect(tiers.global.map((s) => s.name)).toEqual(['g1', 'g2'])
      expect(orderSkillsByUsage(skills, usage).map((s) => s.name)).toEqual(['p1', 'p2', 'g1', 'g2'])
    }
  })

  it('equal counts inside Most used break locality-first, then server order', () => {
    const ordered = orderSkillsByUsage(skills, { g1: 3, p1: 3, g2: 3, p2: 3 })
    expect(ordered.map((s) => s.name)).toEqual(['p1', 'p2', 'g1', 'g2'])
  })

  it('a skill named after an Object.prototype member counts 0, not the inherited function', () => {
    // `usage` comes from JSON.parse (the ui-state GET), so it carries Object.prototype: a plain
    // `usage[name]` lookup returns the INHERITED function for these names, `??` does not catch a
    // non-nullish function, and the comparator goes NaN — which silently corrupts the order.
    const usage = JSON.parse('{"p1": 5}') as Record<string, number>
    const tiers = partitionSkillsForDisplay(
      [
        skill({ id: 'constructor', name: 'constructor', scope: 'repo' }),
        skill({ id: 'toString', name: 'toString', scope: 'repo' }),
        skill({ id: 'p1', name: 'p1', scope: 'repo' }),
      ],
      usage,
    )
    expect(tiers.mostUsed.map((s) => s.name)).toEqual(['p1'])
    expect(tiers.project.map((s) => s.name)).toEqual(['constructor', 'toString'])
  })
})

describe('bumpSkillUsage (#408: the ui-state skillUsage reducer)', () => {
  it('starts a fresh count at 1 from an undefined map', () => {
    expect(bumpSkillUsage(undefined, 'om-fix')).toEqual({ 'om-fix': 1 })
  })

  it('increments an existing count without touching other entries', () => {
    expect(bumpSkillUsage({ 'om-fix': 2, 'om-review': 7 }, 'om-fix')).toEqual({
      'om-fix': 3,
      'om-review': 7,
    })
  })

  it('adds a new entry alongside existing ones', () => {
    expect(bumpSkillUsage({ 'om-fix': 1 }, 'om-review')).toEqual({ 'om-fix': 1, 'om-review': 1 })
  })

  it('a skill named after an Object.prototype member starts at 1, not string garbage', () => {
    // Same inherited-property trap as the sort: `usage['toString'] ?? 0` would yield the
    // function, and `fn + 1` a string — which the server's bounded schema now rejects with a 400.
    expect(bumpSkillUsage(JSON.parse('{}') as Record<string, number>, 'toString')).toEqual({ toString: 1 })
    expect(bumpSkillUsage(undefined, 'constructor')).toEqual({ constructor: 1 })
  })
})

describe('fuzzyMatch', () => {
  const table: Array<{ candidate: string; query: string; hit: boolean }> = [
    { candidate: 'om-fix-issue', query: '', hit: true },
    { candidate: 'om-fix-issue', query: 'fix', hit: true },
    { candidate: 'om-fix-issue', query: 'omfx', hit: true }, // subsequence
    { candidate: 'om-fix-issue', query: 'OMFX', hit: true }, // case-insensitive
    { candidate: 'om-fix-issue', query: 'xz', hit: false },
    { candidate: 'om-fix-issue', query: 'issuefix', hit: false }, // order matters
    { candidate: 'src/server/server.ts', query: 'srvts', hit: true },
  ]
  for (const { candidate, query, hit } of table) {
    it(`"${query}" ${hit ? 'finds' : 'does not find'} "${candidate}"`, () => {
      expect(fuzzyMatch(candidate, query)).toBe(hit)
    })
  }
})

describe('filterSkills (#380: filter without re-sorting — project-first survives any query)', () => {
  const skills = [
    skill({ id: 'global-deploy', name: 'global-deploy', scope: 'user', description: 'Deploy from anywhere' }),
    skill({ id: 'project-deploy', name: 'project-deploy', scope: 'repo' }),
    skill({ id: 'project-review', name: 'project-review', scope: 'repo', description: 'Review the diff' }),
  ]

  it('empty query keeps everything, project skills first', () => {
    expect(filterSkills(skills, '').map((s) => s.name)).toEqual([
      'project-deploy',
      'project-review',
      'global-deploy',
    ])
  })

  it('a query narrows but never reorders across the project/global split', () => {
    expect(filterSkills(skills, 'deploy').map((s) => s.name)).toEqual([
      'project-deploy',
      'global-deploy',
    ])
  })

  it('matches on the description as a fallback', () => {
    expect(filterSkills(skills, 'anywhere').map((s) => s.name)).toEqual(['global-deploy'])
  })

  it('no match → empty, never a throw', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([])
  })
})

describe('multiWordFilter (#411: multi-keyword search for cmdk)', () => {
  it('empty search matches everything (score 1)', () => {
    expect(multiWordFilter('skill om-auto-review-pr', '')).toBe(1)
    expect(multiWordFilter('skill om-auto-review-pr', '   ')).toBe(1)
  })

  it('"auto review" matches "om-auto-review-pr" in the value', () => {
    expect(multiWordFilter('skill om-auto-review-pr /path', 'auto review')).toBeGreaterThan(0)
  })

  it('"verify ui" matches via keywords (name parts)', () => {
    expect(
      multiWordFilter('skill om-auto-verify-pr-ui', 'verify ui', ['om', 'auto', 'verify', 'pr', 'ui']),
    ).toBeGreaterThan(0)
  })

  it('every word must match — partial hits return 0', () => {
    expect(multiWordFilter('skill om-fix /path', 'fix deploy')).toBe(0)
  })

  it('matching is case-insensitive', () => {
    expect(multiWordFilter('skill Deploy /path', 'DEPLOY')).toBeGreaterThan(0)
  })
})

describe('matchScore (#484: exact > prefix > word-boundary > substring > subsequence)', () => {
  it('ranks a stronger match higher', () => {
    expect(matchScore('review', 'review')).toBeGreaterThan(matchScore('review-prs', 'review')) // exact > prefix
    expect(matchScore('review-prs', 'review')).toBeGreaterThan(matchScore('om-code-review', 'review')) // prefix > boundary
    expect(matchScore('om-code-review', 'review')).toBeGreaterThan(matchScore('previewer', 'review')) // boundary > buried
    expect(matchScore('previewer', 'review')).toBeGreaterThan(matchScore('om-fix-issue', 'omfx')) // buried > subsequence
  })

  it('0 when the query cannot even be found as a subsequence', () => {
    expect(matchScore('om-fix-issue', 'zzz')).toBe(0)
  })

  it('empty query is a neutral match', () => {
    expect(matchScore('anything', '')).toBe(1)
  })
})

describe('#484: an (almost-)exact match sorts to the top', () => {
  it('multiWordFilter scores a whole-word hit above a buried substring, undiluted by value length', () => {
    // The bug: the old coverage ratio divided by the whole "skill <name> <path>" length, so a
    // near-exact match on a skill with a long path scored ~0.5 — same as a weak partial.
    const wholeWord = multiWordFilter('skill om-fix /very/long/path/to/skills/om-fix.md', 'fix', ['om', 'fix'])
    const buried = multiWordFilter('skill affix-tool /p', 'fix', ['affix', 'tool'])
    expect(wholeWord).toBeGreaterThan(buried)
    expect(buried).toBeGreaterThan(0) // still a match, just ranked lower
  })

  it('filterSkills ranks an exact name match above a merely-partial one, reordering input', () => {
    const skills = [
      skill({ id: 'om-code-review', name: 'om-code-review', scope: 'repo' }), // 'review' is a whole word, mid-name
      skill({ id: 'review', name: 'review', scope: 'repo' }), // exact match, but later in input order
    ]
    expect(filterSkills(skills, 'review').map((s) => s.name)).toEqual(['review', 'om-code-review'])
  })

  it('filterSkills ranks a prefix match above a word-boundary match', () => {
    const skills = [
      skill({ id: 'om-auto-deploy', name: 'om-auto-deploy', scope: 'repo' }), // boundary hit
      skill({ id: 'deploy-app', name: 'deploy-app', scope: 'repo' }), // prefix hit
    ]
    expect(filterSkills(skills, 'deploy').map((s) => s.name)).toEqual(['deploy-app', 'om-auto-deploy'])
  })

  it('filterSkills keeps project-first order when matches are equally good', () => {
    const skills = [
      skill({ id: 'global-review', name: 'global-review', scope: 'user' }),
      skill({ id: 'project-review', name: 'project-review', scope: 'repo' }),
    ]
    // Both match 'review' as a word-boundary hit → tie → project (ai) stays first.
    expect(filterSkills(skills, 'review').map((s) => s.name)).toEqual(['project-review', 'global-review'])
  })
})

describe('searchSkills / searchWorkflows (#484: the pickers rank in JS, not via cmdk)', () => {
  it('matches a native id absent from the display text and keeps both paths', () => {
    const copies = [
      skill({ id: 'plugin:check', name: 'Check', description: 'Review changes', path: 'repo/SKILL.md', scope: 'repo' }),
      skill({ id: 'plugin:check', name: 'Check', description: 'Review changes', path: '/user/SKILL.md', scope: 'user' }),
    ]
    expect(searchSkills(copies, 'plugin:check')).toEqual(copies)
    expect(filterSkills(copies, 'plugin:check')).toEqual(copies)
    expect(searchSkillsForDisplay(copies, 'plugin:check').ranked).toEqual(copies)
    expect(searchSkills(copies, 'plugin:check changes')).toEqual(copies)
  })

  it('does not fuzzy-match a query across the id and description boundary', () => {
    expect(searchSkills([skill({ id: 'om-fix', name: 'om-fix', description: 'Leave a review note', scope: 'repo' })], 'om-review')).toEqual([])
  })
  const skills = [
    skill({ id: 'om-auto-fix-issue', name: 'om-auto-fix-issue', scope: 'repo', description: 'Fix an issue; runs om-fix internally' }),
    skill({ id: 'om-fix', name: 'om-fix', scope: 'repo', description: 'Apply the minimal fix' }),
    skill({ id: 'om-open-pr', name: 'om-open-pr', scope: 'user', description: 'Open a PR' }),
  ]

  it('ranks the (almost-)exact name match first, even when it comes later in the input', () => {
    // The picker bug: "om-fix" typed, but "om-auto-fix-issue" (only a description hit) sat on top.
    expect(searchSkills(skills, 'om-fix').map((s) => s.name)).toEqual(['om-fix', 'om-auto-fix-issue'])
  })

  it('keeps the caller-supplied order for an empty query (project-first / recency survives)', () => {
    expect(searchSkills(skills, '').map((s) => s.name)).toEqual([
      'om-auto-fix-issue',
      'om-fix',
      'om-open-pr',
    ])
  })

  it('drops non-matches and never throws on no match', () => {
    expect(searchSkills(skills, 'zzz')).toEqual([])
  })

  it('a name match outranks a description-only match', () => {
    // "issue": om-auto-fix-issue matches on the name (whole word), om-open-pr only via description.
    const s2 = [
      skill({ id: 'om-open-pr', name: 'om-open-pr', scope: 'repo', description: 'Open a PR for an issue' }),
      skill({ id: 'om-auto-fix-issue', name: 'om-auto-fix-issue', scope: 'repo' }),
    ]
    expect(searchSkills(s2, 'issue').map((s) => s.name)).toEqual(['om-auto-fix-issue', 'om-open-pr'])
  })

  it('searchWorkflows ranks workflows by match quality too', () => {
    const workflows: WorkflowDef[] = [
      { name: 'ship-it', source: 'file', description: 'review then deploy', steps: [] },
      { name: 'review', source: 'file', steps: [] },
    ]
    expect(searchWorkflows(workflows, 'review').map((w) => w.name)).toEqual(['review', 'ship-it'])
  })
})

describe('queryScore (#484)', () => {
  it('a name hit always outranks a description-only hit', () => {
    expect(queryScore('deploy', 'unrelated', 'deploy')).toBeGreaterThan(queryScore('other', 'deploy tool', 'deploy'))
  })
  it('0 when neither name nor description matches', () => {
    expect(queryScore('alpha', 'beta', 'zzz')).toBe(0)
  })
})

describe('skillKeywords', () => {
  it('splits hyphenated names into parts', () => {
    expect(skillKeywords('om-auto-review-pr')).toEqual(['om', 'auto', 'review', 'pr'])
  })

  it('includes the description when provided', () => {
    expect(skillKeywords('om-fix', 'Fix an issue')).toEqual(['om', 'fix', 'Fix an issue'])
  })

  it('works with a single-word name', () => {
    expect(skillKeywords('deploy', null)).toEqual(['deploy'])
  })
})

describe('skillUsedBy (the detail pane’s "Used by" breadcrumbs)', () => {
  const workflows: WorkflowDef[] = [
    {
      name: 'fix-and-verify',
      source: 'file',
      steps: [
        { id: 'fix', name: 'Fix', skill: 'om-fix' },
        { id: 'verify', skill: 'om-fix' }, // unnamed step → the id stands in
        { id: 'check', command: 'npm test' },
      ],
    },
    { name: 'ship-it', source: 'file', steps: [{ id: 'review', name: 'Review', skill: 'om-review' }] },
    { name: 'quick-task', source: 'built-in', steps: [] },
  ]

  it('lists every referencing step as "workflow › step", ids standing in for names', () => {
    expect(skillUsedBy(workflows, 'om-fix')).toEqual(['fix-and-verify › Fix', 'fix-and-verify › verify'])
    expect(skillUsedBy(workflows, 'om-review')).toEqual(['ship-it › Review'])
  })

  it('an unreferenced skill answers an empty list', () => {
    expect(skillUsedBy(workflows, 'om-unused')).toEqual([])
  })
})

describe('#519: usage folds into query ranking and the / autocomplete order', () => {
  const skills = [
    skill({ id: 'project-deploy', name: 'project-deploy', scope: 'repo' }),
    skill({ id: 'global-deploy', name: 'global-deploy', scope: 'user', description: 'Deploy from anywhere' }),
  ]

  it('empty query orders the / autocomplete most-used first, across localities', () => {
    expect(filterSkills(skills, '', { 'global-deploy': 3 }).map((s) => s.name)).toEqual([
      'global-deploy',
      'project-deploy',
    ])
    // Without usage, the pre-#519 project-first behavior is unchanged.
    expect(filterSkills(skills, '').map((s) => s.name)).toEqual(['project-deploy', 'global-deploy'])
  })

  it('a typed query lets usage break ties between comparably-scoring matches', () => {
    // Both names hit 'deploy' on a word boundary → equal base score; the usage count decides
    // (defect 4 of #519: before, a typed query discarded frequency entirely).
    expect(filterSkills(skills, 'deploy', { 'global-deploy': 3 }).map((s) => s.name)).toEqual([
      'global-deploy',
      'project-deploy',
    ])
    expect(searchSkills(skills, 'deploy', { 'project-deploy': 2 }).map((s) => s.name)).toEqual([
      'project-deploy',
      'global-deploy',
    ])
  })

  it('the usage bonus is bounded — heavy usage never outranks a clearly better name match', () => {
    const s2 = [
      skill({ id: 'om-fix', name: 'om-fix', scope: 'repo' }),
      skill({ id: 'om-auto-fix-issue', name: 'om-auto-fix-issue', scope: 'repo', description: 'runs om-fix internally' }),
    ]
    expect(searchSkills(s2, 'om-fix', { 'om-auto-fix-issue': 999 }).map((s) => s.name)).toEqual([
      'om-fix',
      'om-auto-fix-issue',
    ])
  })
})

describe('#255: name matches outrank description and weaker name hits', () => {
  it('an exact skill-name query ranks that skill first even when a weaker name hit is heavily used', () => {
    // Usage bonus (max 2.5) is larger than the matchScore gap between exact (6) and
    // word-boundary (4), so folding usage into the same number let `om-code-review` beat
    // the skill actually named `review`.
    const skills = [
      skill({ id: 'om-code-review', name: 'om-code-review', scope: 'repo' }),
      skill({ id: 'review', name: 'review', scope: 'repo' }),
    ]
    const usage = { 'om-code-review': 999 }
    expect(searchSkills(skills, 'review', usage).map((s) => s.name)).toEqual(['review', 'om-code-review'])
    expect(filterSkills(skills, 'review', usage).map((s) => s.name)).toEqual(['review', 'om-code-review'])
  })

  it('description-only hits never outrank any name hit for the same query', () => {
    const skills = [
      skill({ id: 'ship', name: 'ship', scope: 'repo', description: 'How to fix production incidents' }),
      skill({ id: 'om-fix', name: 'om-fix', scope: 'repo' }),
    ]
    expect(searchSkills(skills, 'fix', { ship: 999 }).map((s) => s.name)).toEqual(['om-fix', 'ship'])
    expect(filterSkills(skills, 'fix', { ship: 999 }).map((s) => s.name)).toEqual(['om-fix', 'ship'])
  })

  it('prefix name hits outrank description-only hits for the same query', () => {
    const skills = [
      skill({ id: 'ship', name: 'ship', scope: 'repo', description: 'deploy the build' }),
      skill({ id: 'deploy-app', name: 'deploy-app', scope: 'repo' }),
    ]
    expect(searchSkills(skills, 'deploy').map((s) => s.name)).toEqual(['deploy-app', 'ship'])
    expect(filterSkills(skills, 'deploy').map((s) => s.name)).toEqual(['deploy-app', 'ship'])
  })

  it('prefix name hits outrank weaker name hits even when the weaker hit is heavily used', () => {
    const skills = [
      skill({ id: 'om-auto-deploy', name: 'om-auto-deploy', scope: 'repo' }),
      skill({ id: 'deploy-app', name: 'deploy-app', scope: 'repo' }),
    ]
    expect(searchSkills(skills, 'deploy', { 'om-auto-deploy': 999 }).map((s) => s.name)).toEqual([
      'deploy-app',
      'om-auto-deploy',
    ])
  })

  it('queryScore: a prefix name hit outranks a description-only exact hit', () => {
    expect(queryScore('deploy-app', null, 'deploy')).toBeGreaterThan(queryScore('ship', 'deploy', 'deploy'))
  })

  it('queryScore: any name hit outranks a description-only hit', () => {
    expect(queryScore('om-fix', null, 'fix')).toBeGreaterThan(queryScore('ship', 'fix', 'fix'))
  })
})

describe('searchSkillsForDisplay (#255: grouped pickers keep query rank)', () => {
  const skills = [
    skill({ id: 'om-code-review', name: 'om-code-review', scope: 'repo' }),
    skill({ id: 'review', name: 'review', scope: 'user' }),
  ]
  const usage = { 'om-code-review': 999 }

  it('empty query still promotes Most used, then locality', () => {
    const display = searchSkillsForDisplay(skills, '', usage)
    expect(display.ranked).toBeNull()
    expect(display.mostUsed.map((s) => s.name)).toEqual(['om-code-review'])
    expect(display.project).toEqual([])
    expect(display.global.map((s) => s.name)).toEqual(['review'])
  })

  it('a typed query keeps the exact name first — usage and locality do not re-tier', () => {
    const display = searchSkillsForDisplay(skills, 'review', usage)
    expect(display.ranked?.map((s) => s.name)).toEqual(['review', 'om-code-review'])
    expect(display.mostUsed).toEqual([])
    expect(display.project).toEqual([])
    expect(display.global).toEqual([])
  })

  it('equal name matches keep project before global, even when the server listed global first', () => {
    const display = searchSkillsForDisplay(
      [skill({ id: 'g-review', name: 'g-review', scope: 'user' }), skill({ id: 'om-review', name: 'om-review', scope: 'repo' })],
      'review',
    )
    expect(display.ranked?.map((s) => s.name)).toEqual(['om-review', 'g-review'])
  })
})
