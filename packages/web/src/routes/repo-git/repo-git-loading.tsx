import { LoaderCircleIcon } from 'lucide-react'

import { useLocation } from 'react-router'

import { CenteredState } from '@/components/centered-state'
import { SplitPage } from '@/components/page-shell'

import { stripProjectPrefix } from '@/lib/project-router'

import { RepoBackLink } from './repo-back-link'

/** The repo view's loading surface — also the route's `Suspense` fallback (routes.tsx), so it
 *  lives outside the lazy chunk it stands in for, same reason as git-tab-loading.tsx. */
export function RepoGitLoading() {
  // Every repository URL offers the phone's way back to the Git screen, except the bare
  // `/git` index itself (a phone shows the Git screen there, so the link would point home).
  const { pathname, search } = useLocation()
  const back = stripProjectPrefix(pathname) !== '/git' || new URLSearchParams(search).get('view') === 'repo'
  return (
    <SplitPage route="repo-git" density="sparse" flushPadding>
      {back ? <RepoBackLink /> : null}
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading repository…"
        subtitle="Fetching the repo's git state."
      />
    </SplitPage>
  )
}
