import type { RunnerInstallAction } from '@open-mercato/cezar-api-client/contract/runner-install'
import { cez, unwrap } from './client'

export async function getRunnerInstall(runner: string) {
  return unwrap(await cez.api.v1['runner-install'][':runner'].$get({ param: { runner } }), '/runner-install/:runner')
}

export async function changeRunnerInstall(runner: string, action: RunnerInstallAction) {
  return unwrap(await cez.api.v1['runner-install'][':runner'].$post({ param: { runner }, json: { action } }), '/runner-install/:runner')
}
