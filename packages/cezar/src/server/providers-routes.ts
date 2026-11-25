import { Hono, type Context } from 'hono';
import type { AgentProfileResponse, AgentProfilesResponse } from '@open-mercato/cezar-contract';
import {
  agentProfileRouteParamsSchema,
  createAgentProfileSchema,
  providerConnectSchema,
  providerEnabledSchema,
  providerRetrySchema,
  providerRouteParamsSchema,
  selectAgentProfileSchema,
  updateAgentProfileSchema,
} from '@open-mercato/cezar-contract/provider-requests';
import { strictRefreshQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { profileCapableProviders, supportsProfiles } from '../core/agent-profiles.ts';
import type { ProviderAuthService, ProviderId } from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { isRegisteredRunner, knownRunnerIds, registeredRunnerId, registeredRunners } from '../core/runner-registry.ts';
import type { Home } from '../home/home.ts';
import { expandTilde } from '../paths.ts';
import {
  CONTROL_CHARS_RE,
  DEFAULT_AGENT_ACCOUNT_ID,
  defaultAgentAccountStore,
  isAbsoluteConfigDir,
  loadAgentAccounts,
  mergeWriteAgentAccounts,
  removeAgentAccount,
  type AgentAccount,
  type AgentAccountStore,
} from '../workspace/agent-accounts.ts';
import {
  defaultAgentProfile,
  listAgentProfiles,
  profileDirState,
  resolveStoredProfile,
  sameProfileDir,
  type ResolvedAgentProfile,
} from '../workspace/agent-profiles.ts';
import { preservedDisabledProviders, type WorkspaceConfig } from '../workspace/config.ts';
import { allocateAgentProfileId } from './agent-profile-id.ts';
import { emitProviderRow } from './server-deps.ts';
import {
  hostedProfileRefusal,
  writeErrorMessage,
  type ProjectApiEnv,
  type ProviderStatusBundle,
  type ResolvedServerDeps,
  type ResolveWorkspaceProfileFn,
  type ServerCapabilitiesFn,
  type WorkspaceEventBus,
} from './server-types.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

export interface ProvidersRouteDeps {
  bootRoot: string;
  capabilities: ServerCapabilitiesFn;
  modelCatalog: RunnerModelCatalog;
  providerAuth: ProviderAuthService;
  providerStatus: ProviderStatusBundle['providerStatus'];
  invalidateHostModels: ProviderStatusBundle['invalidateHostModels'];
  workspaceConfig: ResolvedServerDeps['workspaceConfig'];
  workspaceEvents: WorkspaceEventBus;
  openTerminal: ResolvedServerDeps['openTerminal'];
  resolveWorkspaceProfile: ResolveWorkspaceProfileFn;
}

export function createProvidersRoutes(deps: ProvidersRouteDeps) {
  const {
    bootRoot,
    capabilities,
    modelCatalog,
    providerAuth,
    providerStatus,
    invalidateHostModels,
    workspaceConfig,
    workspaceEvents,
    openTerminal,
    resolveWorkspaceProfile,
  } = deps;

  return new Hono<ProjectApiEnv>()
    .get(
      '/providers/status',
      queryZodValidator(strictRefreshQuerySchema, { message: 'refresh must be 1 when provided' }),
      async (c) => {
        const query = { data: c.req.valid('query') };
        const refresh = query.data.refresh === '1';
        if (refresh) {
          for (const { id } of registeredRunners()) modelCatalog.invalidate(id);
        }
        return c.json(await providerStatus({ refresh }));
      },
    )

    .put(
      '/providers/:provider/enabled',
      paramZodValidator(providerRouteParamsSchema, { message: 'provider and enabled boolean are required', runners: { ids: ['provider'] } }),
      jsonZodValidator(providerEnabledSchema, { message: 'provider and enabled boolean are required' }),
      async (c) => {
        const provider = { data: registeredRunnerId(c.req.valid('param').provider) };
        const body = { data: c.req.valid('json') };
        let workspace: WorkspaceConfig;
        try {
          workspace = await workspaceConfig.mergeWrite((config) => {
            const disabled = new Set(config.disabledProviders);
            if (body.data.enabled) disabled.delete(provider.data);
            else disabled.add(provider.data);
            config.disabledProviders = preservedDisabledProviders(registeredRunners().map(({ id }) => id), disabled, config.disabledProviders);
          });
        } catch {
          return c.json({ error: 'Provider preference could not be saved.' }, 500);
        }
        const result = applyProviderEnablement(
          await providerAuth.status(),
          workspace.disabledProviders,
        );
        emitProviderRow(workspaceEvents, result.providers, provider.data);
        return c.json(result);
      },
    )

    .post(
      '/providers/:provider/retry',
      paramZodValidator(providerRouteParamsSchema, { message: 'provider and current authFailureId are required', runners: { ids: ['provider'] } }),
      jsonZodValidator(providerRetrySchema, { message: 'provider and current authFailureId are required' }),
      async (c) => {
        const provider = { data: registeredRunnerId(c.req.valid('param').provider) };
        const body = { data: c.req.valid('json') };
        if (!providerAuth.clearRuntimeAuthFailure(provider.data, body.data.authFailureId)) {
          return c.json({ error: 'Authentication incident changed. Refresh and try again.' }, 409);
        }
        invalidateHostModels(provider.data);
        const result = await providerStatus({ refresh: true });
        emitProviderRow(workspaceEvents, result.providers, provider.data);
        return c.json(result);
      },
    )

    .post('/providers/connect', jsonZodValidator(providerConnectSchema, { message: `provider must be ${knownRunnerIds().slice(0, -1).join(', ')}, or ${knownRunnerIds().at(-1)}`, runners: { ids: ['provider'] } }), async (c) => {
      const body = { data: c.req.valid('json') };

      const provider = body.data.provider as ProviderId;
      if (body.data.profileId !== undefined
        && body.data.profileId !== DEFAULT_AGENT_ACCOUNT_ID
        && !capabilities().localHandoff) {
        return c.json(hostedProfileRefusal, 409);
      }
      const resolved = await resolveWorkspaceProfile(provider, body.data.profileId);
      if ('error' in resolved) return c.json({ error: resolved.error }, 400);
      const { profile } = resolved;
      const command = providerAuth.loginCommand(provider, profile.isDefault ? null : profile.path);
      if (command === null) {
        return c.json({ error: providerAuth.loginRefusalHint(provider, profile.configDir) }, 409);
      }
      if (!profile.isDefault) providerAuth.forgetProfileStatus(provider, profile.id);
      const row = profile.isDefault
        ? (await providerAuth.status({ refresh: true })).providers.find(
          (candidate) => candidate.provider === provider,
        )
        : await providerAuth.profileStatus(provider, { id: profile.id, configDir: profile.path });
      if (!row) {
        return c.json({ error: 'Authentication could not be verified. Try again.' }, 500);
      }

      if (row.status === 'connected') {
        invalidateHostModels(provider);
        return c.json({ opened: false, connected: true, command });
      }
      if (row.status === 'not-installed') {
        return c.json({ error: row.hint ?? providerAuth.installHint(provider), command }, 409);
      }
      if (row.status === 'unknown') {
        return c.json({ error: row.hint ?? 'Authentication could not be verified. Try again.', command }, 409);
      }
      if (!capabilities().localHandoff) {
        return c.json({ error: `Run this command on the machine hosting Squawk.`, command }, 409);
      }
      let opened = false;
      try {
        opened = await openTerminal(bootRoot, command);
      } catch {
        // Terminal handoff is best-effort; the exact command remains the safe fallback.
      }
      if (!opened) {
        return c.json({ error: 'No terminal emulator could be opened. Run this command manually.', command }, 409);
      }
      invalidateHostModels(provider);
      return c.json({ opened: true, command });
    });
}

export interface AgentProfilesRouteDeps {
  home: Home;
  capabilities: ServerCapabilitiesFn;
  providerAuth: ProviderAuthService;
  providerStatus: ProviderStatusBundle['providerStatus'];
  invalidateHostModels: ProviderStatusBundle['invalidateHostModels'];
  workspaceProjects: WorkspaceProjects;
  resolveWorkspaceProfile: ResolveWorkspaceProfileFn;
  projectRootFor: (projectId: string) => Promise<string | null>;
}

export function createAgentProfilesRoutes(deps: AgentProfilesRouteDeps) {
  const {
    home,
    capabilities,
    providerAuth,
    providerStatus,
    invalidateHostModels,
    workspaceProjects,
    resolveWorkspaceProfile,
    projectRootFor,
  } = deps;

  const agentProfileBody = async (profile: ResolvedAgentProfile): Promise<AgentProfileResponse['profile']> => ({
    id: profile.id,
    provider: profile.provider,
    label: profile.label,
    configDir: profile.configDir,
    path: profile.path,
    ...(await profileDirState(profile.provider, profile.path)),
    isDefault: profile.isDefault,
    ...(() => {
      const cached = profile.isDefault
        ? providerAuth.peekStatus()?.providers.find((row) => row.provider === profile.provider)
        : providerAuth.peekProfileStatus(profile.provider, profile.id);
      return cached ? { status: cached } : {};
    })(),
  });

  const accountById = async (id: string): Promise<ResolvedAgentProfile | null> => {
    const [head, tail] = id.split(':');
    if (head === DEFAULT_AGENT_ACCOUNT_ID) {
      const provider = registeredRunners().find(({ id }) => id === tail)?.id;
      return provider ? defaultAgentProfile(provider) : null;
    }
    try {
      const stored = (await loadAgentAccounts(home)).accounts.find((a) => a.id === id);
      return stored && isRegisteredRunner(stored.provider) ? resolveStoredProfile(stored) : null;
    } catch {
      return null;
    }
  };

  const localAccount = async (c: Context<ProjectApiEnv, '/workspace/agent-profiles/:id'>) => {
    if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
    const id = c.req.param('id');
    return (await accountById(id)) ?? c.json({ error: `unknown account: ${id}` }, 404);
  };

  const checkProfileDir = (configDir: string): string | null => {
    if (CONTROL_CHARS_RE.test(configDir)) return 'folder must not contain control characters';
    const expanded = expandTilde(configDir);
    return isAbsoluteConfigDir(expanded) ? null : `folder must be an absolute path: ${configDir}`;
  };

  const conflictingProfile = async (
    profiles: readonly AgentAccount[],
    provider: ProviderId,
    path: string,
    exceptId?: string,
  ): Promise<string | null> => {
    if (await sameProfileDir(path, defaultAgentProfile(provider).path)) {
      return 'that is already this agent\'s default folder';
    }
    for (const candidate of profiles) {
      if (candidate.provider !== provider || candidate.id === exceptId) continue;
      if (await sameProfileDir(path, expandTilde(candidate.configDir))) {
        return `that folder is already used by "${candidate.label || candidate.id}"`;
      }
    }
    return null;
  };

  return new Hono<ProjectApiEnv>()
    .get('/workspace/agent-profiles', async (c) => {
      const editable = capabilities().localHandoff;
      let store = defaultAgentAccountStore();
      if (editable) {
        try {
          store = await loadAgentAccounts(home);
        } catch {
          // an unreadable home degrades to "no extra accounts", never a failed request
        }
      }
      const profiles = editable
        ? await Promise.all(listAgentProfiles(store, registeredRunners().map(({ id }) => id)).map(agentProfileBody))
        : [];
      return c.json<AgentProfilesResponse>({
        editable,
        profiles,
        profileCapableProviders: profileCapableProviders(),
        selections: editable ? store.selections : {},
      });
    })

    .post('/workspace/agent-profiles', jsonZodValidator(() => createAgentProfileSchema, { runners: { ids: ['provider'] } }), async (c) => {
      if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
      const { configDir, label } = c.req.valid('json'), provider = registeredRunnerId(c.req.valid('json').provider);
      if (!supportsProfiles(provider)) {
        return c.json({ error: `${provider} cannot carry more than one account` }, 400);
      }
      const dirError = checkProfileDir(configDir);
      if (dirError) return c.json({ error: dirError }, 400);

      let existing: readonly AgentAccount[] = [];
      try {
        existing = (await loadAgentAccounts(home)).accounts;
      } catch {
        // unreadable store — the merge-write below reports the real failure
      }
      const conflict = await conflictingProfile(existing, provider, expandTilde(configDir));
      if (conflict !== null) return c.json({ error: conflict }, 409);

      let created: AgentAccount | undefined;
      try {
        await mergeWriteAgentAccounts((store) => {
          const id = allocateAgentProfileId(label ?? configDir, store.accounts.map((a) => a.id));
          created = {
            id,
            provider,
            configDir,
            label: label?.trim() || id,
            addedAt: new Date().toISOString(),
          };
          store.accounts.push(created);
        }, home);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (!created) return c.json({ error: 'account could not be saved' }, 500);
      const account = resolveStoredProfile(created);
      const created201 = await agentProfileBody(account);
      void providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
      return c.json({ profile: created201 }, 201);
    })

    .patch(
      '/workspace/agent-profiles/:id',
      paramZodValidator(agentProfileRouteParamsSchema),
      jsonZodValidator(() => updateAgentProfileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        const { label, configDir } = c.req.valid('json');
        if (configDir !== undefined) {
          const dirError = checkProfileDir(configDir);
          if (dirError) return c.json({ error: dirError }, 400);
        }

        let existing: readonly AgentAccount[] = [];
        try {
          existing = (await loadAgentAccounts(home)).accounts;
        } catch {
          // unreadable store — treated as unknown, like DELETE and PATCH /projects
        }
        const current = existing.find((a) => a.id === id);
        if (!current || !isRegisteredRunner(current.provider)) return c.json({ error: `unknown account: ${id}` }, 404);
        if (configDir !== undefined) {
          const conflict = await conflictingProfile(existing, current.provider, expandTilde(configDir), id);
          if (conflict !== null) return c.json({ error: conflict }, 409);
        }

        let updated: AgentAccount | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            const entry = store.accounts.find((a) => a.id === id);
            if (!entry) return;
            if (label !== undefined) entry.label = label.trim() || entry.id;
            if (configDir !== undefined) entry.configDir = configDir;
            updated = entry;
          }, home);
        } catch (err) {
          return c.json({ error: writeErrorMessage(err) }, 500);
        }
        if (!updated) return c.json({ error: `unknown account: ${id}` }, 404);
        const repointed = resolveStoredProfile(updated);
        providerAuth.forgetProfileStatus(repointed.provider, repointed.id);
        const body = await agentProfileBody(repointed);
        void providerAuth
          .profileStatus(repointed.provider, { id: repointed.id, configDir: repointed.path })
          .catch(() => {});
        return c.json({ profile: body });
      },
    )

    .get(
      '/workspace/agent-profiles/:id/status',
      paramZodValidator(agentProfileRouteParamsSchema),
      queryZodValidator(strictRefreshQuerySchema, { message: 'refresh must be 1 when provided' }),
      async (c) => {
        const account = await localAccount(c);
        if (account instanceof Response) return account;
        const refresh = c.req.valid('query').refresh === '1';
        if (refresh) invalidateHostModels(account.provider);
        if (account.isDefault) {
          const all = await providerStatus(refresh ? { refresh: true } : undefined);
          const row = all.providers.find((candidate) => candidate.provider === account.provider);
          return c.json({ status: row ?? { provider: account.provider, status: 'unknown' as const } });
        }
        if (refresh) providerAuth.forgetProfileStatus(account.provider, account.id);
        return c.json({
          status: await providerAuth.profileStatus(account.provider, {
            id: account.id,
            configDir: account.path,
          }),
        });
      },
    )

    .put(
      '/workspace/agent-profiles/selection',
      jsonZodValidator(() => selectAgentProfileSchema, { runners: { ids: ['provider'] } }),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const { projectId, profileId } = c.req.valid('json'), provider = registeredRunnerId(c.req.valid('json').provider);
        const resolvedId = await workspaceProjects.canonicalProjectId(projectId);
        const root = await projectRootFor(resolvedId);
        if (root === null) return c.json({ error: `unknown project: ${projectId}` }, 404);
        if (profileId !== null && profileId !== DEFAULT_AGENT_ACCOUNT_ID) {
          const account = await resolveWorkspaceProfile(provider, profileId);
          if ('error' in account) return c.json({ error: account.error }, 400);
        }
        let store: AgentAccountStore;
        try {
          store = await mergeWriteAgentAccounts((current) => {
            const selection = current.selections[root] ?? {};
            if (profileId === null || profileId === DEFAULT_AGENT_ACCOUNT_ID) delete selection[provider];
            else selection[provider] = profileId;
            if (Object.keys(selection).length === 0) delete current.selections[root];
            else current.selections[root] = selection;
          }, home);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        return c.json({ selections: store.selections });
      },
    )

    .delete(
      '/workspace/agent-profiles/:id',
      paramZodValidator(agentProfileRouteParamsSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        let removed = false;
        let removedProvider: ProviderId | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            removedProvider = removeAgentAccount(store, id);
            removed = removedProvider !== undefined;
          }, home);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        if (!removed) return c.json({ error: `unknown account: ${id}` }, 404);
        providerAuth.forgetProfileStatus(removedProvider, id);
        return c.json({ removed: true as const, id });
      },
    );
}
