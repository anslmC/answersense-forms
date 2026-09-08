import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_STATE_STORAGE_KEY,
  deleteGeminiCredential,
  deleteCredential,
  configurationIdentity,
  createCredential,
  getActiveConfiguration,
  getValidation,
  hasGeminiCredential,
  invalidateValidation,
  listCredentials,
  readCredentialSecret,
  readGeminiCredential,
  replaceCredential,
  saveValidation,
  setActiveConfiguration,
  storeGeminiCredential,
  type CredentialStorage,
} from '../src/Generation/Credentials';

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

describe('BYOK credential storage', () => {
  it('stores, replaces, reads, and deletes only the local credential', async () => {
    const local = storage();

    await storeGeminiCredential(' first-key ', local);
    expect(await readGeminiCredential(local)).toBe('first-key');
    expect(await hasGeminiCredential(local)).toBe(true);

    await storeGeminiCredential('second-key', local);
    expect(await readGeminiCredential(local)).toBe('second-key');

    await deleteGeminiCredential(local);
    expect(await readGeminiCredential(local)).toBeNull();
    expect(await hasGeminiCredential(local)).toBe(false);
  });

  it('rejects an empty credential', async () => {
    await expect(storeGeminiCredential('  ', storage())).rejects.toThrow(
      'API key is required'
    );
  });

  it('creates multiple provider-associated credentials and redacts listings', async () => {
    const local = storage();

    const first = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'first-secret' },
      local
    );
    const second = await createCredential(
      { providerId: 'other', label: 'Backup', secret: 'second-secret' },
      local
    );

    expect(first.credentialId).not.toBe(second.credentialId);
    expect(first).not.toHaveProperty('secret');
    expect(second).not.toHaveProperty('secret');
    expect(await listCredentials(local)).toEqual([first, second]);
    expect(await readCredentialSecret(first.credentialId, local)).toBe(
      'first-secret'
    );
    expect(await readCredentialSecret(second.credentialId, local)).toBe(
      'second-secret'
    );
  });

  it('migrates the legacy Gemini key once without retaining the legacy key', async () => {
    const local = storage();
    await local.set({ geminiApiKey: 'legacy-secret' });

    const credentials = await listCredentials(local);

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      providerId: 'gemini',
      label: 'Gemini credential',
    });
    expect(credentials[0]).not.toHaveProperty('secret');
    expect(await readGeminiCredential(local)).toBe('legacy-secret');
    await expect(local.get('geminiApiKey')).resolves.toEqual({
      geminiApiKey: undefined,
    });
  });

  it('persists and retrieves an active configuration without a secret', async () => {
    const local = storage();
    const credential = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'secret' },
      local
    );
    const configuration = {
      providerId: 'gemini',
      modelId: 'model-a',
      credentialId: credential.credentialId,
      providerConfig: {},
    };

    await expect(setActiveConfiguration(configuration, local)).resolves.toEqual(
      configuration
    );
    await expect(getActiveConfiguration(local)).resolves.toEqual(configuration);
    expect(await getActiveConfiguration(local)).not.toHaveProperty('secret');
  });

  it('canonicalizes configuration keys and treats display metadata as excluded', async () => {
    const base = {
      providerId: 'gemini',
      modelId: 'model-a',
      credentialId: 'credential-1',
      providerConfig: {
        nested: { second: 'b', first: 'a' },
        first: 'a',
      },
    };
    const reordered = {
      providerId: ' gemini ',
      modelId: 'model-a',
      credentialId: 'credential-1',
      providerConfig: {
        first: 'a',
        nested: { first: 'a', second: 'b' },
      },
    };

    const first = await configurationIdentity(base);
    const second = await configurationIdentity(reordered);
    expect(first).toEqual(second);
    expect(
      await configurationIdentity({ ...base, providerConfig: {} })
    ).toEqual(
      await configurationIdentity({
        ...base,
        providerConfig: undefined,
      } as unknown as typeof base)
    );
    expect(
      await configurationIdentity({ ...base, providerId: 'other' })
    ).not.toEqual(first);
    expect(
      await configurationIdentity({ ...base, modelId: 'model-b' })
    ).not.toEqual(first);
    expect(
      await configurationIdentity({ ...base, credentialId: 'credential-2' })
    ).not.toEqual(first);
    expect(
      await configurationIdentity({
        ...base,
        providerConfig: { ...base.providerConfig, changed: true },
      })
    ).not.toEqual(first);
    expect(
      await configurationIdentity({ ...base, label: 'Display label' } as typeof base)
    ).toEqual(first);
  });

  it('persists validation and replaces records with a new immutable identity', async () => {
    const local = storage();
    const credential = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'old-secret' },
      local
    );
    const configuration = {
      providerId: 'gemini',
      modelId: 'model-a',
      credentialId: credential.credentialId,
      providerConfig: {},
    };
    const identity = await configurationIdentity(configuration);
    await setActiveConfiguration(configuration, local);
    await saveValidation(
      {
        configurationDigest: identity.digest,
        providerId: 'gemini',
        modelId: 'model-a',
        credentialId: credential.credentialId,
        status: 'VALID',
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
      local
    );
    await expect(getValidation(identity.digest, local)).resolves.toMatchObject({
      status: 'VALID',
    });

    const replacement = await replaceCredential(
      credential.credentialId,
      { providerId: 'gemini', label: 'Replacement', secret: 'new-secret' },
      local
    );

    expect(replacement.credentialId).not.toBe(credential.credentialId);
    expect(
      await readCredentialSecret(credential.credentialId, local)
    ).toBeNull();
    expect(await readCredentialSecret(replacement.credentialId, local)).toBe(
      'new-secret'
    );
    await expect(getActiveConfiguration(local)).resolves.toMatchObject({
      credentialId: replacement.credentialId,
    });
    await expect(getValidation(identity.digest, local)).resolves.toBeNull();
  });

  it('invalidates one validation digest without affecting another', async () => {
    const local = storage();
    const credential = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'secret' },
      local
    );
    for (const digest of ['keep', 'remove']) {
      await saveValidation(
        {
          configurationDigest: digest,
          providerId: 'gemini',
          modelId: 'model-a',
          credentialId: credential.credentialId,
          status: 'VALID',
          validatedAt: '2026-09-08T00:00:00.000Z',
        },
        local
      );
    }

    await invalidateValidation('remove', local);

    expect(await getValidation('keep', local)).toMatchObject({
      configurationDigest: 'keep',
    });
    expect(await getValidation('remove', local)).toBeNull();
  });

  it('deletes the credential, active configuration, and all dependent validations', async () => {
    const local = storage();
    const credential = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'secret' },
      local
    );
    const configuration = {
      providerId: 'gemini',
      modelId: 'model-a',
      credentialId: credential.credentialId,
      providerConfig: {},
    };
    await setActiveConfiguration(configuration, local);
    for (const digest of ['digest-a', 'digest-b']) {
      await saveValidation(
        {
          configurationDigest: digest,
          providerId: 'gemini',
          modelId: 'model-a',
          credentialId: credential.credentialId,
          status: 'INVALID',
          validatedAt: '2026-09-08T00:00:00.000Z',
          failureCode: 'AUTHENTICATION_FAILED',
        },
        local
      );
    }

    await deleteCredential(credential.credentialId, local);

    expect(await listCredentials(local)).toEqual([]);
    expect(await getActiveConfiguration(local)).toBeNull();
    expect(await getValidation('digest-a', local)).toBeNull();
    expect(await getValidation('digest-b', local)).toBeNull();
  });

  it('keeps foundation state in the existing local storage boundary', async () => {
    const local = storage();
    const credential = await createCredential(
      { providerId: 'gemini', label: 'Primary', secret: 'secret' },
      local
    );
    const stored = await local.get(CONFIGURATION_STATE_STORAGE_KEY);
    const state = stored[CONFIGURATION_STATE_STORAGE_KEY] as Record<
      string,
      unknown
    >;
    expect(state.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: credential.credentialId }),
      ])
    );
  });
});
