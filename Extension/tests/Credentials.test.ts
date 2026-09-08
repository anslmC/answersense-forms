import { describe, expect, it } from 'vitest';
import {
  deleteGeminiCredential,
  hasGeminiCredential,
  readGeminiCredential,
  storeGeminiCredential,
  type CredentialStorage,
} from '../src/Generation/Credentials';

function storage(): CredentialStorage {
  const values: Record<string, unknown> = {};
  return {
    get: async (key) => ({ [key]: values[key] }),
    set: async (next) => Object.assign(values, next),
    remove: async (key) => delete values[key],
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
});
