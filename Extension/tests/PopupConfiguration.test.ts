import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isCurrentValidationValid,
  modelsForProvider,
  validationStatus,
  type PopupConfigurationState,
} from '../src/Popup/Configuration';

const baseState: PopupConfigurationState = {
  providers: [
    {
      providerId: 'gemini',
      displayName: 'Gemini',
      models: [{ modelId: 'gemini-model', displayName: 'Gemini model' }],
      supportsValidation: true,
    },
  ],
  credentials: [
    {
      credentialId: 'credential-1',
      providerId: 'gemini',
      label: 'Primary',
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    },
  ],
  activeConfiguration: {
    providerId: 'gemini',
    modelId: 'gemini-model',
    credentialId: 'credential-1',
    providerConfig: {},
  },
  configurationDigest: 'digest-1',
  configurationRevision: 1,
  validation: null,
};

describe('popup configuration state', () => {
  it('uses API key terminology in visible popup text', () => {
    const markup = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );
    const visibleText = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(visibleText).toContain('API Keys');
    expect(visibleText).toContain('Add API key');
    expect(visibleText).toContain('Replace API key');
    expect(visibleText).toContain('Delete API key');
    expect(visibleText).not.toContain('Credential');
  });

  it('restricts models to the selected compiled provider', () => {
    expect(modelsForProvider(baseState, 'gemini')).toEqual([
      { modelId: 'gemini-model', displayName: 'Gemini model' },
    ]);
    expect(modelsForProvider(baseState, 'unsupported')).toEqual([]);
  });

  it('starts not validated and gates generation until exact validation exists', () => {
    expect(validationStatus(baseState, false)).toBe('NOT_VALIDATED');
    expect(isCurrentValidationValid(baseState)).toBe(false);
    const validated = {
      ...baseState,
      validation: {
        configurationDigest: 'digest-1',
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'credential-1',
        status: 'VALID' as const,
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
    };
    expect(validationStatus(validated, false)).toBe('VALID');
    expect(isCurrentValidationValid(validated)).toBe(true);
  });

  it('marks validation as loading and rejects stale or mismatched records', () => {
    expect(validationStatus(baseState, true)).toBe('VALIDATING');
    const stale = {
      ...baseState,
      validation: {
        configurationDigest: 'old-digest',
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'credential-1',
        status: 'VALID' as const,
        validatedAt: '2026-09-08T00:00:00.000Z',
      },
    };
    expect(validationStatus(stale, false)).toBe('NOT_VALIDATED');
    expect(isCurrentValidationValid(stale)).toBe(false);
  });

  it('preserves invalid state without exposing a secret-bearing field', () => {
    const invalid = {
      ...baseState,
      validation: {
        configurationDigest: 'digest-1',
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'credential-1',
        status: 'INVALID' as const,
        validatedAt: '2026-09-08T00:00:00.000Z',
        failureCode: 'INVALID_CREDENTIAL',
      },
    };
    expect(validationStatus(invalid, false)).toBe('INVALID');
    expect(JSON.stringify(invalid)).not.toContain('secret');
  });
});
