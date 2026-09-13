import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isCurrentValidationValid,
  modelsForProvider,
  authorizationStatus,
  validGenerationMessage,
  validationStatus,
  type ConfigurationState,
} from '../src/Workflow/Configuration';

const baseState: ConfigurationState = {
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
  it('restores the configuration controls in the overlay scaffold', () => {
    const overlaySource = readFileSync(
      resolve(process.cwd(), 'src/Overlay/Overlay.ts'),
      'utf8'
    );
    for (const token of [
      'data-status',
      'data-detail',
      'data-message',
      'data-results',
      'data-primary-action',
      'data-force-clear',
      'data-workflow-progress',
      'data-workflow-progress-bar',
      'data-workflow-progress-text',
      'data-workflow-progress-fill',
      'data-provider-select',
      'data-model-select',
      'data-credential-select',
      'data-credential-label',
      'data-credential-secret',
      'data-save-configuration',
      'data-delete-credential',
      'data-validate-configuration',
      'data-validation-status',
      'data-unsaved-configuration',
      'data-validation-message',
      'data-add-credential',
      'data-replace-credential',
      'data-add-credential-form',
      'data-replace-credential-form',
      'data-save-add-credential',
      'data-cancel-add-credential',
      'data-save-replace-credential',
      'data-cancel-replace-credential',
      'data-credential-message',
    ]) {
      expect(overlaySource).toContain(token);
    }
  });

  it('keeps generation interactive only through the authorized flow', () => {
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Workflow/WorkflowApp.ts'),
      'utf8'
    );
    const contentSource = readFileSync(
      resolve(process.cwd(), 'src/Content/Content.ts'),
      'utf8'
    );
    expect(popupSource).toContain(
      'primary.disabled = !isCurrentValidationValid(configurationState);'
    );
    expect(popupSource).toContain('renderAll(controller.state);');
    expect(popupSource).toContain(
      "if (state.name === 'GENERATING') {"
    );
    expect(popupSource).toContain(
      "primary.textContent = 'Generating...';"
    );
    expect(popupSource).toContain(
      "filledStatus.textContent = 'Page Answers already settled';"
    );
    expect(popupSource).toContain(
      "if ('status' in state.result) {"
    );
    expect(popupSource).toContain(
      'if (!isCurrentValidationValid(configurationState)) return;'
    );
    expect(contentSource).toContain(
      'if (!shouldGeneratePage(pageLifecycle.currentRevisitStatus)) {'
    );
  });

  it('shows the unsaved validation message until configuration is saved', () => {
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Workflow/WorkflowApp.ts'),
      'utf8'
    );
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
      resolve(process.cwd(), 'src/Workflow/WorkflowApp.ts'),
      'utf8'
    );

    expect(popupSource).toContain("progressFill.style.width = '';");
    expect(popupSource).toContain("progressBar.removeAttribute('aria-valuetext');");
    expect(popupSource).toContain(
      "progress.classList.remove('is-complete', 'is-partial', 'is-error')"
    );
  });

  it('toggles a generating-only overlay border state and defines the 0.7s animated glint', () => {
    const popupSource = readFileSync(
      resolve(process.cwd(), 'src/Workflow/WorkflowApp.ts'),
      'utf8'
    );
    const overlayStyles = readFileSync(
      resolve(process.cwd(), 'src/Overlay/Overlay.css'),
      'utf8'
    );

    expect(popupSource).toContain("overlayPanel.classList.toggle('is-generating', state.name === 'GENERATING');");
    expect(overlayStyles).toContain('.overlay-panel.is-generating');
    expect(overlayStyles).toContain('animation: overlay-border-gradient 0.7s');
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
