import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isCurrentValidationValid,
  modelsForProvider,
  authorizationStatus,
  validGenerationMessage,
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
  it('keeps credential entry controls hidden until the user opens an API-key flow', () => {
    const markup = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );
    expect(markup).toContain('<div class="credential-form" data-add-credential-form hidden>');
    expect(markup).toContain('<div class="credential-form" data-replace-credential-form hidden>');
    expect(markup).toContain('<label for="credential-label">Key Name</label>');
    expect(markup).toContain('<label for="credential-secret">API key</label>');
    expect(markup).toContain('<label for="replace-credential-select">Key to replace</label>');
    expect(markup).toContain('<label for="replace-credential-secret">New API Key</label>');
    expect(markup).toContain('<button type="button" data-save-add-credential>Save</button>');
    expect(markup).toContain('<button type="button" class="secondary" data-cancel-add-credential>');
    expect(markup).toContain('<button type="button" data-save-replace-credential>Replace</button>');
    expect(markup).toContain('<button type="button" class="secondary" data-cancel-replace-credential>');
  });

  it('uses API key terminology in visible popup text', () => {
    const markup = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );
    const styles = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.css'),
      'utf8'
    );
    const visibleText = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(markup.indexOf('data-status')).toBeGreaterThan(
      markup.indexOf('</header>')
    );
    expect(markup.indexOf('data-status')).toBeLessThan(
      markup.indexOf('credential-heading')
    );
    expect(markup.indexOf('credential-heading')).toBeLessThan(
      markup.indexOf('configuration-heading')
    );
    expect(markup.indexOf('configuration-heading')).toBeLessThan(
      markup.indexOf('validation-heading')
    );
    expect(markup.indexOf('validation-heading')).toBeLessThan(
      markup.indexOf('generation-heading')
    );
    expect(styles).toContain('.generation-panel');
    expect(styles).toMatch(/\.generation-panel[\s\S]*border-top/);
    expect(visibleText).toContain('API Keys');
    expect(visibleText).toContain('No API keys added yet');
    expect(visibleText).toContain('Add API key');
    expect(visibleText).toContain('Replace API key');
    expect(visibleText).toContain('Delete All keys');
    expect(visibleText).toContain('Force Unsettle');
    expect(visibleText).not.toContain('Credential');
  });

  it('keeps generation interactive only through the authorized flow', () => {
    const markup = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.ts'),
      'utf8'
    );
    expect(markup).toMatch(
      /<button type="button" data-primary-action hidden>\s*Generate &amp; Auto-Fill/
    );
    expect(popupSource).toContain(
      'primary.disabled = !isCurrentValidationValid(configurationState);'
    );
    expect(popupSource).toContain(
      'if (!isCurrentValidationValid(configurationState)) return;'
    );
  });

  it('shows the unsaved validation message until configuration is saved', () => {
    const markup = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.ts'),
      'utf8'
    );
    expect(markup).toContain('data-unsaved-configuration hidden>');
    expect(markup).toContain('Save the configuration before validating');
    expect(popupSource).toContain(
      'unsavedConfiguration.hidden = !configurationDirty;'
    );
    expect(popupSource).toContain('configurationDirty = false;');
    expect(popupSource).toContain('validateButton.disabled =');
    expect(popupSource).toContain(
      'validating || !configurationState.activeConfiguration || configurationDirty;'
    );
  });

  it('clears stale terminal progress state when entering the GENERATING branch', () => {
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Popup/Popup.ts'),
      'utf8'
    );

    expect(popupSource).toContain("progressFill.style.width = '';");
    expect(popupSource).toContain("progressBar.removeAttribute('aria-valuetext');");
    expect(popupSource).toContain(
      "progress.classList.remove('is-complete', 'is-partial', 'is-error')"
    );
  });

  it('restricts models to the selected compiled provider', () => {
    expect(modelsForProvider(baseState, 'gemini')).toEqual([
      { modelId: 'gemini-model', displayName: 'Gemini model' },
    ]);
    expect(modelsForProvider(baseState, 'unsupported')).toEqual([]);
  });

  it('starts not validated and gates generation until exact validation exists', () => {
    expect(validationStatus(baseState, false)).toBe('NOT_VALIDATED');
    expect(authorizationStatus(baseState, false)).toBe(
      'NOT VALIDATED — Configuration saved. Validate it before generating.'
    );
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
    expect(authorizationStatus(validated, false)).toBe('VALID');
    expect(validGenerationMessage(validated)).toBe(
      'Configuration is valid. Generate is available on a supported page.'
    );
    expect(authorizationStatus(validated, false, true)).toBe(
      'NOT VALIDATED — Save the configuration before validating'
    );
  });

  it('uses the initial authorization reason when no configuration or keys exist', () => {
    const initial = {
      ...baseState,
      credentials: [],
      activeConfiguration: null,
      configurationDigest: null,
      validation: null,
    };
    expect(authorizationStatus(initial, false)).toBe(
      'NOT VALIDATED — Save the configuration before validating'
    );
    expect(isCurrentValidationValid(initial)).toBe(false);
  });

  it('invalidates a previously valid configuration when its API key is deleted', () => {
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
    const deleted = { ...validated, credentials: [] };
    expect(isCurrentValidationValid(validated)).toBe(true);
    expect(authorizationStatus(validated, false)).toBe('VALID');
    expect(isCurrentValidationValid(deleted)).toBe(false);
    expect(authorizationStatus(deleted, false)).toBe(
      'NOT VALIDATED — Save the configuration before validating'
    );
    expect(validGenerationMessage(deleted)).toBeNull();
    expect(isCurrentValidationValid(deleted)).toBe(false);
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
