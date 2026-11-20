import { BotIcon, ExternalLinkIcon, FolderIcon, SparklesIcon } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { RUNNERS_RESPONSE } from '@/test/runners.testkit'
import { openInIcon } from './open-in-menu'

describe('openInIcon', () => {
  const target = (icon?: string) => ({ id: 'x', label: 'X', ...(icon === undefined ? {} : { icon }) })

  it('renders a known icon key with its icon and any other key with the generic glyph', () => {
    expect(openInIcon(target('folder'))).toBe(FolderIcon)
    expect(openInIcon(target('somethingNew'))).toBe(ExternalLinkIcon)
    expect(openInIcon(target())).toBe(ExternalLinkIcon)
  })

  it('renders an icon key that names an Object.prototype member with the generic glyph (hearsay-tools/squawk#2890)', () => {
    for (const icon of ['toString', 'constructor', '__proto__']) expect(openInIcon(target(icon))).toBe(ExternalLinkIcon)
  })

  // hearsay-tools/squawk#3898: an agent CLI target takes the icon key of its runner's entry in the
  // runners list, not a table keyed by runner id.
  it('renders an agent CLI target with the icon its runner names, and the generic glyph before the runners list answers', () => {
    const cli = (runner: string) => ({ id: `cli:${runner}`, label: runner, icon: runner })
    expect(openInIcon(cli('claude'), RUNNERS_RESPONSE)).toBe(BotIcon)
    expect(openInIcon(cli('codex'), RUNNERS_RESPONSE)).toBe(SparklesIcon)
    expect(openInIcon(cli('omp'), RUNNERS_RESPONSE)).toBe(BotIcon)
    expect(openInIcon(cli('claude'))).toBe(ExternalLinkIcon)
    expect(openInIcon(cli('unregistered'), RUNNERS_RESPONSE)).toBe(ExternalLinkIcon)
  })
})
