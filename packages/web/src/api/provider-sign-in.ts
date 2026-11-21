import type { ProviderId } from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'

export async function startProviderSignIn(provider: ProviderId, profileId?: string) {
  return unwrap(await cez.api.v1.providers['sign-in'].start.$post({ json: { provider, ...(profileId ? { profileId } : {}) } }), '/providers/sign-in/start')
}

export async function getProviderSignIn(id: string) {
  return unwrap(await cez.api.v1.providers['sign-in'][':id'].$get({ param: { id } }), '/providers/sign-in/:id')
}

export async function replayProviderSignIn(id: string, redirectUrl: string) {
  return unwrap(await cez.api.v1.providers['sign-in'][':id'].redirect.$post({ param: { id }, json: { redirectUrl } }), '/providers/sign-in/:id/redirect')
}

export async function cancelProviderSignIn(id: string) {
  return unwrap(await cez.api.v1.providers['sign-in'][':id'].$delete({ param: { id } }), '/providers/sign-in/:id')
}

