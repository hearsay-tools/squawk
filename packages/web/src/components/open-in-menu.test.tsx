import { ExternalLinkIcon, FolderIcon } from 'lucide-react'
import { describe, expect, it } from 'vitest'

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
})
