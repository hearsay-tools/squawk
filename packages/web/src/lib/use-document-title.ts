import { useEffect } from 'react'

export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
}

function titlePart(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The browser-tab grammar, kept pure so loading and fallback states are exhaustive in tests. */
export function documentTitleOf({ projectName, pageLabel }: DocumentTitleParts): string {
  const project = titlePart(projectName)
  const page = titlePart(pageLabel)

  if (project && page) return `${project} — ${page} · Squawk`
  if (project) return `${project} · Squawk`
  if (page) return `${page} · Squawk`
  return 'Squawk'
}

/** The cockpit's single runtime document-title writer. */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)
  useEffect(() => {
    document.title = title
  }, [title])
}
