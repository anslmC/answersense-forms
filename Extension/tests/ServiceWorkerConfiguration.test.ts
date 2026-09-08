import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_STATE_STORAGE_KEY,
  configurationIdentity,
  createCredential,
  deleteCredential,
  getConfigurationStateRevision,
  replaceCredential,
  saveValidation,
  setActiveConfiguration,
  type CredentialStorage,
} from '../src/Generation/Credentials';
import { GEMINI_MODEL } from '../src/Generation/GeminiProvider';
import { GEMINI_PROVIDER_ID } from '../src/Generation/ProviderRegistry';
import {
  resolveActiveProviderConfiguration,
  resolveAuthorizedProviderConfiguration,
} from '../src/Background/ServiceWorkerConfiguration';

function storage(): CredentialStorage {
  const values: Record<string, unknown> = {};
  return {
    get: async (key) => ({ [key]: values[key] }),
    set: async (next) => {
      Object.assign(values, next);
    },
    remove: async (key) => {
      delete values[key];
    },
  };
}

async function configuredStorage(
  configuration: Partial<{
    providerId: string;
    modelId: string;
    providerConfig: Record<string, unknown>;
  }> = {}
): Promise<CredentialStorage> {
  const local = storage();
  const credential = await createCredential(
    { providerId: GEMINI_PROVIDER_ID, label: 'Primary', secret: 'test-secret' },
    local
  );
  const activeConfiguration = {
    providerId: configuration.providerId ?? GEMINI_PROVIDER_ID,
    modelId: configuration.modelId ?? GEMINI_MODEL,
    credentialId: credential.credentialId,
    providerConfig: configuration.providerConfig ?? {},
  };
  if (
    activeConfiguration.providerId === GEMINI_PROVIDER_ID &&
    activeConfiguration.modelId === GEMINI_MODEL
  ) {
    await setActiveConfiguration(activeConfiguration, local);
  } else {
    const current = await local.get(CONFIGURATION_STATE_STORAGE_KEY);
    await local.set({
      [CONFIGURATION_STATE_STORAGE_KEY]: {
        ...(current[CONFIGURATION_STATE_STORAGE_KEY] as Record<string, unknown>),
        activeConfiguration,
      },
    });
  }
  return local;
}

describe('Service Worker provider configuration resolution', () => {
  it('resolves a valid Gemini configuration through the compiled registry', async () => {
    const resolved = await resolveActiveProviderConfiguration(
      await configuredStorage()
    );

    expect(resolved.provider.providerId).toBe(GEMINI_PROVIDER_ID);
    expect(resolved.model.modelId).toBe(GEMINI_MODEL);
    expect(resolved.provider.adapterId).toBe(GEMINI_PROVIDER_ID);
    expect(resolved.secret).toBe('test-secret');
    expect(resolved.adapter('test-secret')).toBeDefined();
  });

  it('rejects provider/model mismatches and unknown providers or models', async () => {
    await expect(
      resolveActiveProviderConfiguration(
        await configuredStorage({ providerId: 'unknown-provider' })
      )
    ).rejects.toThrow('Unsupported provider configuration');

    await expect(
      resolveActiveProviderConfiguration(
        await configuredStorage({ modelId: 'unknown-model' })
      )
    ).rejects.toThrow('Unsupported provider configuration');
  });

  it('rejects malformed persisted configurations without resolving credentials', async () => {
    const local = storage();
    await local.set({
      [CONFIGURATION_STATE_STORAGE_KEY]: {
        credentials: [],
        activeConfiguration: {
          providerId: GEMINI_PROVIDER_ID,
          modelId: GEMINI_MODEL,
          credentialId: 'missing-credential',
          providerConfig: [],
        },
        validations: [],
      },
    });

    await expect(resolveActiveProviderConfiguration(local)).rejects.toThrow(
      'Configuration required'
    );
  });

  it('uses compiled endpoint and adapter metadata despite runtime providerConfig values', async () => {
    const resolved = await resolveActiveProviderConfiguration(
      await configuredStorage({
        providerConfig: {
          endpointHost: 'attacker.example',
          adapterId: 'attacker-adapter',
          modelId: 'attacker-model',
        },
      })
    );

    expect(resolved.provider.endpointHost).toBe(
      'generativelanguage.googleapis.com'
    );
    expect(resolved.provider.adapterId).toBe(GEMINI_PROVIDER_ID);
    expect(resolved.model.modelId).toBe(GEMINI_MODEL);
  });

  it('preserves the existing Gemini default when no active configuration is stored', async () => {
    const local = storage();
    await createCredential(
      { providerId: GEMINI_PROVIDER_ID, label: 'Primary', secret: 'test-secret' },
      local
    );

    const resolved = await resolveActiveProviderConfiguration(local);

    expect(resolved.provider.providerId).toBe(GEMINI_PROVIDER_ID);
    expect(resolved.model.modelId).toBe(GEMINI_MODEL);
  });

  it('authorizes only the exact current configuration digest with VALID state', async () => {
    const local = await configuredStorage();
    const resolved = await resolveActiveProviderConfiguration(local);
    const validation = {
      configurationDigest: resolved.configurationDigest,
      providerId: resolved.provider.providerId,
      modelId: resolved.model.modelId,
      credentialId: resolved.configuration.credentialId,
      status: 'VALID' as const,
      validatedAt: '2026-09-08T00:00:00.000Z',
    };
    await saveValidation(validation, local);

    await expect(
      resolveAuthorizedProviderConfiguration(
        resolved.configurationDigest,
        local
      )
    ).resolves.toMatchObject({
      configurationDigest: resolved.configurationDigest,
    });
    await expect(
      resolveAuthorizedProviderConfiguration('wrong-digest', local)
    ).rejects.toThrow('Configuration changed during generation');
  });

  it('rejects an older validation after the active configuration changes', async () => {
    const local = await configuredStorage();
    const first = await resolveActiveProviderConfiguration(local);
    await saveValidation(
      {
        configurationDigest: first.configurationDigest,
        providerId: first.provider.providerId,
        modelId: first.model.modelId,
        credentialId: first.configuration.credentialId,
        status: 'VALID',
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
      local
    );
    const changed = {
      ...first.configuration,
      providerConfig: { changed: true },
    };
    await setActiveConfiguration(changed, local);
    const second = await resolveActiveProviderConfiguration(local);
    expect(await configurationIdentity(changed)).not.toEqual(
      await configurationIdentity(first.configuration)
    );
    await expect(
      resolveAuthorizedProviderConfiguration(second.configurationDigest, local)
    ).rejects.toThrow('Configuration is not validated');
  });

  it('rejects authorization after credential replacement or deletion', async () => {
    const local = await configuredStorage();
    const resolved = await resolveActiveProviderConfiguration(local);
    await saveValidation(
      {
        configurationDigest: resolved.configurationDigest,
        providerId: resolved.provider.providerId,
        modelId: resolved.model.modelId,
        credentialId: resolved.configuration.credentialId,
        status: 'VALID',
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
      local
    );
    await deleteCredential(resolved.configuration.credentialId, local);

    await expect(
      resolveAuthorizedProviderConfiguration(resolved.configurationDigest, local)
    ).rejects.toThrow('Configuration required');
  });

  it('rejects a stale revision after credential replacement before adapter use', async () => {
    const local = await configuredStorage();
    const resolved = await resolveActiveProviderConfiguration(local);
    await saveValidation(
      {
        configurationDigest: resolved.configurationDigest,
        providerId: resolved.provider.providerId,
        modelId: resolved.model.modelId,
        credentialId: resolved.configuration.credentialId,
        status: 'VALID',
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
      local
    );
    const revision = await getConfigurationStateRevision(local);
    await replaceCredential(
      resolved.configuration.credentialId,
      { providerId: GEMINI_PROVIDER_ID, label: 'Replacement', secret: 'new-secret' },
      local
    );

    await expect(
      resolveAuthorizedProviderConfiguration(
        resolved.configurationDigest,
        local,
        revision
      )
    ).rejects.toThrow('changed');
  });

  it('rejects when configuration mutates between authorization storage reads', async () => {
    const base = await configuredStorage();
    const initial = await resolveActiveProviderConfiguration(base);
    await saveValidation(
      {
        configurationDigest: initial.configurationDigest,
        providerId: initial.provider.providerId,
        modelId: initial.model.modelId,
        credentialId: initial.configuration.credentialId,
        status: 'VALID',
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
      base
    );

    let armed = false;
    let configurationReads = 0;
    const originalGet = base.get;
    base.get = async (key) => {
      const result = await originalGet(key);
      if (
        armed &&
        key === CONFIGURATION_STATE_STORAGE_KEY &&
        ++configurationReads === 6
      ) {
        armed = false;
        const state = result[key] as Record<string, unknown>;
        const activeConfiguration = state.activeConfiguration as Record<
          string,
          unknown
        >;
        state.activeConfiguration = {
          ...activeConfiguration,
          providerConfig: { changed: true },
        };
        state.revision = Number(state.revision ?? 0) + 1;
      }
      return result;
    };
    armed = true;

    await expect(resolveAuthorizedProviderConfiguration(undefined, base)).rejects.toThrow(
      'changed'
    );
  });
});
