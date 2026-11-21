import { z } from 'zod';
import { runnerSchema } from './runner.ts';

export const providerConnectSchema = z.object({
  provider: runnerSchema,
  /** Which agent account to sign in (spec 2026-07-29-agent-profiles). Absent = the discovered
   *  default, which is what every pre-profiles client sends. Without this, "Connect" on a second
   *  Claude account would open a login for the FIRST one and report success. */
  profileId: z.string().max(64).optional(),
}).strict();

/** Agent-account bodies (spec 2026-07-29-agent-profiles). Bounds mirror `agentProfileSchema` in
 *  src/workspace/config.ts exactly, so a value these accept can never be degraded away by the
 *  next load's `.catch`. The id is allocated server-side and is never a request field. */
export const createAgentProfileSchema = z.object({
  provider: runnerSchema,
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096),
}).strict();

export const updateAgentProfileSchema = z.object({
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096).optional(),
}).strict().refine(
  (value) => value.label !== undefined || value.configDir !== undefined,
  'send label or configDir',
);

/** `PUT …/agent-profiles/selection` — which account a project uses for one provider. `null`
 *  clears it back to the discovered account. */
export const selectAgentProfileSchema = z.object({
  projectId: z.string().min(1).max(64),
  provider: runnerSchema,
  profileId: z.string().max(64).nullable(),
}).strict();

export const providerParamSchema = runnerSchema;

export const providerEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const providerRetrySchema = z.object({
  authFailureId: z.string().min(1).max(128),
}).strict();

export const providerRouteParamsSchema = z.object({ provider: providerParamSchema });

export const agentProfileRouteParamsSchema = z.object({ id: z.string() });

export const providerSignInParamsSchema = z.object({ id: z.uuid() });
export const providerSignInRedirectSchema = z.object({
  redirectUrl: z.string().url().max(8192),
}).strict();
