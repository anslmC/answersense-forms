import { describe, expect, it } from 'vitest';
import {
  GEMINI_API_KEY_STORAGE_KEY,
  createCredential,
  deleteCredential,
  getActiveConfiguration,
  getConfigurationStateRevision,
  getValidation,
  listCredentials,
  readGeminiCredential,
  replaceCredential,
  saveValidation,
  setActiveConfiguration,
  type CredentialStorage,
} from '../src/Generation/Credentials';

/**
 * A storage double that yields to the event loop on every operation. Without
 * serialization, overlapping read-modify-write mutations all observe the same
 * base state and overwrite one another.
 */
function storage(initial: Record<string, unknown> = {}): CredentialStorage {
  const values: Record<string, unknown> = { ...initial };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    get: async (key) => {
      await tick();
      return { [key]: values[key] };
    },
    set: async (next) => {
      await tick();
      Object.assign(values, next);
    },
    remove: async (key) => {
      await tick();
      delete values[key];
    },
  };
}

const geminiCredential = (label: string, secret: string) => ({
  providerId: 'gemini',
  label,
  secret,
});

const validatedAt = '2026-11-01T00:00:00.000Z';

describe('credential mutation serialization', () => {
  it('keeps every overlapping credential creation', async () => {
    const local = storage();
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createCredential(
          geminiCredential(`Key ${index}`, `secret-${index}`),
          local
        )
      )
    );

    expect(created).toHaveLength(5);
    expect(new Set(created.map((record) => record.credentialId)).size).toBe(5);
    expect(await listCredentials(local)).toHaveLength(5);
    expect(await getConfigurationStateRevision(local)).toBe(5);
  });

  it('continues after a failed mutation without losing queue recovery', async () => {
    const local = storage();

    await expect(
      replaceCredential(
        'missing-credential',
        geminiCredential('Missing', 'secret'),
        local
      )
    ).rejects.toThrow('Credential not found.');

    const created = await createCredential(
      geminiCredential('Primary', 'primary-secret'),
      local
    );
    expect(await listCredentials(local)).toEqual([created]);
    expect(await getConfigurationStateRevision(local)).toBe(1);
  });

  it('applies concurrent configuration and credential mutations in order', async () => {
    const local = storage();
    const primary = await createCredential(
      geminiCredential('Primary', 'primary-secret'),
      local
    );

    const [backup] = await Promise.all([
      createCredential(geminiCredential('Backup', 'backup-secret'), local),
      setActiveConfiguration(
        {
          providerId: 'gemini',
          modelId: 'gemini-3.1-flash-lite',
          credentialId: primary.credentialId,
          providerConfig: {},
        },
        local
      ),
    ]);

    expect(await listCredentials(local)).toHaveLength(2);
    expect((await getActiveConfiguration(local))?.credentialId).toBe(
      primary.credentialId
    );
    expect(backup.credentialId).not.toBe(primary.credentialId);
    expect(await getConfigurationStateRevision(local)).toBe(3);
  });

  it('does not resurrect a credential deleted concurrently', async () => {
    const local = storage();
    const doomed = await createCredential(
      geminiCredential('Doomed', 'doomed-secret'),
      local
    );

    const [kept] = await Promise.all([
      createCredential(geminiCredential('Kept', 'kept-secret'), local),
      deleteCredential(doomed.credentialId, local),
    ]);

    const remaining = await listCredentials(local);
    expect(remaining.map((record) => record.credentialId)).toEqual([
      kept.credentialId,
    ]);
    expect(await getConfigurationStateRevision(local)).toBe(3);
  });

  it('imports a legacy Gemini key exactly once under concurrent reads', async () => {
    const local = storage({ [GEMINI_API_KEY_STORAGE_KEY]: 'legacy-secret' });

    const concurrent = await Promise.all([
      listCredentials(local),
      listCredentials(local),
      listCredentials(local),
    ]);
    for (const credentials of concurrent) {
      expect(credentials).toHaveLength(1);
    }

    expect(await listCredentials(local)).toHaveLength(1);
    expect(await readGeminiCredential(local)).toBe('legacy-secret');
    expect(await getConfigurationStateRevision(local)).toBe(1);
  });

  it('keeps validation records for different configurations written concurrently', async () => {
    const local = storage();
    const credential = await createCredential(
      geminiCredential('Primary', 'primary-secret'),
      local
    );

    await Promise.all(
      ['digest-a', 'digest-b'].map((configurationDigest) =>
        saveValidation(
          {
            configurationDigest,
            providerId: 'gemini',
            modelId: 'gemini-3.1-flash-lite',
            credentialId: credential.credentialId,
            status: 'VALID',
            validatedAt,
          },
          local
        )
      )
    );

    expect(await getValidation('digest-a', local)).not.toBeNull();
    expect(await getValidation('digest-b', local)).not.toBeNull();
    expect(await getConfigurationStateRevision(local)).toBe(3);
  });

  it('does not block later writes after a rejected validation write', async () => {
    const local = storage();

    await expect(
      saveValidation(
        {
          configurationDigest: 'digest-missing',
          providerId: 'gemini',
          modelId: 'gemini-3.1-flash-lite',
          credentialId: 'missing-credential',
          status: 'VALID',
          validatedAt,
        },
        local
      )
    ).rejects.toThrow('Credential not found.');
    expect(await getConfigurationStateRevision(local)).toBe(0);

    const created = await createCredential(
      geminiCredential('Primary', 'primary-secret'),
      local
    );
    expect(await listCredentials(local)).toEqual([created]);
    expect(await getConfigurationStateRevision(local)).toBe(1);
  });
});
