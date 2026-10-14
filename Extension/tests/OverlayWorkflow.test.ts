import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountOverlay, type OverlayHandle } from '../src/Overlay/Overlay';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { waitForInitialDiscovery } from '../src/Content/Navigation';
import type { QuestionResult } from '../src/Models/Logical';
import {
  NVIDIA_GPT_OSS_MODEL,
  NVIDIA_MODEL,
} from '../src/Generation/NvidiaProvider';
import { NVIDIA_PROVIDER_ID } from '../src/Generation/ProviderRegistry';

const configurationState = {
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
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
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
  validation: {
    configurationDigest: 'digest-1',
    providerId: 'gemini',
    modelId: 'gemini-model',
    credentialId: 'credential-1',
    status: 'VALID' as const,
    validatedAt: '2026-09-12T00:00:00.000Z',
  },
};

type TestConfigurationState = Omit<
  typeof configurationState,
  'activeConfiguration' | 'configurationDigest' | 'validation'
> & {
  activeConfiguration: typeof configurationState.activeConfiguration | null;
  configurationDigest: string | null;
  validation: typeof configurationState.validation | null;
};

const generationResult = {
  report: { cycleId: 'cycle-1', status: 'complete' as const, results: [] },
  fillReport: {
    cycleId: 'cycle-1',
    outcomes: [
      { questionId: 'question-1', status: 'FILLED' as const },
      { questionId: 'question-2', status: 'FILLED' as const },
      { questionId: 'question-3', status: 'FILLED' as const },
      { questionId: 'question-4', status: 'FILLED' as const },
    ],
  },
};

let resolveGeneration!: (result: typeof generationResult) => void;

function createSnapshot() {
  return {
    supported: true,
    uiState: 'READY' as const,
    page: { pageId: 'page-1', questionCount: 4 },
    lifecycle: {
      activePage: {
        form: {
          questions: ['question-1', 'question-2', 'question-3', 'question-4'].map(
            (id, index) => ({
              id,
              text: `Question ${index + 1}`,
              type: 'short-text',
              supported: true,
              existingInput: { hasValue: true },
            })
          ),
        },
      },
    },
    result: null,
    error: null,
  };
}

function createUnfilledSnapshot() {
  const snapshot = createSnapshot();
  return {
    ...snapshot,
    lifecycle: {
      ...snapshot.lifecycle,
      activePage: {
        ...snapshot.lifecycle.activePage,
        form: {
          ...snapshot.lifecycle.activePage.form,
          questions: snapshot.lifecycle.activePage.form.questions.map((question) => ({
            ...question,
            existingInput: { hasValue: false },
          })),
        },
      },
    },
  };
}

function createForceClearResponse() {
  return {
    status: 'force-cleared',
    snapshot: {
      activePage: {
        form: { activePageId: 'page-1', questions: [{ id: 'question-1' }] },
      },
    },
  };
}

function createAlreadyFilledGenerationResult() {
  return {
    report: { cycleId: 'cycle-no-op', status: 'complete' as const, results: [] },
    fillReport: { cycleId: 'cycle-no-op', outcomes: [] },
  };
}

interface ProviderActionMessage {
  type?: string;
  providerId?: string;
  credentialId?: string;
  selectedConfiguration?: {
    providerId: string;
    modelId: string;
    credentialId: string;
  };
}

function providerActionConfigurationState() {
  return {
    ...configurationState,
    providers: [
      {
        providerId: 'gemini',
        displayName: 'Gemini',
        models: [
          { modelId: 'gemini-model', displayName: 'Gemini model' },
          { modelId: 'gemini-alt', displayName: 'Gemini alternate' },
        ],
        supportsValidation: true,
      },
      {
        providerId: NVIDIA_PROVIDER_ID,
        displayName: 'NVIDIA',
        models: [
          { modelId: NVIDIA_MODEL, displayName: 'NVIDIA model' },
          { modelId: NVIDIA_GPT_OSS_MODEL, displayName: 'NVIDIA alternate' },
        ],
        supportsValidation: true,
      },
    ],
    credentials: [
      ...configurationState.credentials,
      {
        credentialId: 'nvidia-primary',
        providerId: NVIDIA_PROVIDER_ID,
        label: 'NVIDIA primary',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
    ],
  };
}

async function mountProviderActionOverlay(
  sendMessage: (message: ProviderActionMessage) => Promise<Record<string, unknown>>
) {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
    runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
  });
  vi.stubGlobal('Option', function (label: string, value: string) {
    const option = document.createElement('option');
    option.textContent = label;
    option.value = value;
    return option;
  });
  const handle = await mountOverlay();
  await handle.refresh();
  const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
  const providerSelect = shadowRoot?.querySelector<HTMLSelectElement>(
    '[data-provider-select]'
  );
  const modelSelect = shadowRoot?.querySelector<HTMLSelectElement>(
    '[data-model-select]'
  );
  const credentialSelect = shadowRoot?.querySelector<HTMLSelectElement>(
    '[data-credential-select]'
  );
  if (!shadowRoot || !providerSelect || !modelSelect || !credentialSelect) {
    throw new Error('Provider configuration controls missing.');
  }
  return { handle, shadowRoot, providerSelect, modelSelect, credentialSelect };
}

describe('live Overlay generation workflow', () => {
  let overlay: OverlayHandle | null = null;

  afterEach(() => {
    overlay?.close();
    overlay = null;
    document.documentElement.replaceChildren(document.head, document.body);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows elapsed validation time only while pending', async () => {
    let currentState: TestConfigurationState = {
      ...configurationState,
      validation: null,
    };
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    const pendingValidation = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return currentState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'configuration-set') return currentState;
      if (message.type === 'configuration-validate') {
        markValidationStarted();
        await pendingValidation;
        currentState = {
          ...currentState,
          validation: {
            ...configurationState.validation,
            status: 'VALID',
          },
        };
        return { valid: true };
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    fixture.shadowRoot
      .querySelector<HTMLButtonElement>('[data-configuration-toggle]')
      ?.click();
    const status = fixture.shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-status]'
    );
    fixture.shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-validate-configuration]')
      ?.click();

    await validationStarted;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(status?.textContent).toMatch(/VALIDATING · \d+ ms/u);

    releaseValidation();
    await vi.waitFor(() =>
      expect(status?.textContent).toBe('Status: Valid')
    );
    const finalStatus = status?.textContent;
    expect(status?.textContent).toBe(finalStatus);
  });

  it('keeps configuration collapsed until opened and preserves its controls', async () => {
    let currentConfigurationState: TestConfigurationState = {
      ...configurationState,
      providers: [
        {
          ...configurationState.providers[0],
          models: [
            {
              modelId: 'gemini-3.5-flash-lite',
              displayName: 'Gemini 3.5 Flash-Lite',
            },
            {
              modelId: 'gemini-3.1-flash-lite',
              displayName: 'Gemini 3.1 Flash-Lite',
            },
          ],
        },
      ],
      activeConfiguration: null,
      validation: null,
    };
    let keyOneValidated = false;
    const sendMessage = vi.fn(async (message: {
      type?: string;
      credentialId?: string;
      selectedConfiguration?: {
        providerId: string;
        modelId: string;
        credentialId: string;
      };
    }) => {
      if (message.type === 'configuration-state') {
        const selected = message.selectedConfiguration;
        if (!selected) return currentConfigurationState;
        const isBackup = selected.credentialId === 'credential-2';
        return {
          ...currentConfigurationState,
          selectedConfiguration: { ...selected, providerConfig: {} },
          selectedConfigurationDigest: isBackup ? 'digest-2' : 'digest-1',
          selectedValidation: isBackup
            ? {
                ...configurationState.validation,
                credentialId: 'credential-2',
                configurationDigest: 'digest-2',
              }
            : configurationState.validation,
        };
      }
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'configuration-set') {
        if (!currentConfigurationState.activeConfiguration) {
          return currentConfigurationState;
        }
        const credentialId = message.credentialId ?? 'credential-1';
        currentConfigurationState = {
          ...currentConfigurationState,
          credentials: [
            ...currentConfigurationState.credentials,
            ...(credentialId === 'credential-2'
              ? [
                  {
                    credentialId: 'credential-2',
                    providerId: 'gemini',
                    label: 'Backup',
                    createdAt: '2026-09-12T00:00:00.000Z',
                    updatedAt: '2026-09-12T00:00:00.000Z',
                  },
                ]
              : []),
          ],
          activeConfiguration: {
            ...configurationState.activeConfiguration,
            credentialId,
          },
          configurationDigest:
            credentialId === 'credential-2' ? 'digest-2' : 'digest-1',
          validation:
            credentialId === 'credential-2'
              ? {
                  ...configurationState.validation,
                  credentialId: 'credential-2',
                  configurationDigest: 'digest-2',
                }
              : keyOneValidated
                ? configurationState.validation
                : currentConfigurationState.validation,
        };
        return currentConfigurationState;
      }
      if (message.type === 'credential-delete-selected') {
        currentConfigurationState = {
          ...currentConfigurationState,
          credentials: currentConfigurationState.credentials.filter(
            (credential) => credential.credentialId !== message.credentialId
          ),
        };
        return {};
      }
      if (message.type === 'configuration-validate') {
        keyOneValidated = true;
        currentConfigurationState = configurationState;
        return {};
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    await overlay.refresh();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const modelSelect = shadowRoot?.querySelector<HTMLSelectElement>('[data-model-select]');
    expect(modelSelect?.options.length).toBe(2);
    expect(modelSelect?.value).toBe('gemini-3.1-flash-lite');
    expect(modelSelect?.selectedOptions[0]?.textContent).toBe('Gemini 3.1 Flash-Lite');
    expect(modelSelect?.value).not.toBe('');

    currentConfigurationState = {
      ...configurationState,
      providers: currentConfigurationState.providers,
      activeConfiguration: {
        ...configurationState.activeConfiguration,
        modelId: 'gemini-3.5-flash-lite',
      },
      validation: null,
    };
    await overlay.refresh();
    expect(modelSelect?.value).toBe('gemini-3.5-flash-lite');

    currentConfigurationState = {
      ...configurationState,
      providers: currentConfigurationState.providers,
      activeConfiguration: {
        ...configurationState.activeConfiguration,
        modelId: 'unsupported-model',
      },
      validation: null,
    };
    await overlay.refresh();
    expect(modelSelect?.value).toBe('gemini-3.1-flash-lite');
    expect(modelSelect?.value).not.toBe('');

    const section = shadowRoot?.querySelector<HTMLElement>('[data-configuration-toggle]')
      ?.parentElement;
    const toggle = shadowRoot?.querySelector<HTMLButtonElement>('[data-configuration-toggle]');
    const content = shadowRoot?.querySelector<HTMLElement>('[data-configuration-content]');

    expect(section?.children).toHaveLength(3);
    expect(toggle?.textContent).toContain('Configuration');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Expand Configuration');
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('►');
    const guidance = shadowRoot?.querySelector<HTMLElement>('[data-configuration-guidance]');
    expect(guidance?.textContent?.trim()).toBe('Configure the extension before generating.');
    expect(guidance?.tagName).toBe('SPAN');
    expect(guidance?.parentElement?.tagName).toBe('P');
    expect(guidance?.closest('button')).toBeNull();
    const apiKeyHelp = guidance?.parentElement;
    const apiKeyLink = apiKeyHelp?.querySelector<HTMLButtonElement>(
      '[data-open-configuration]'
    );
    expect(apiKeyHelp?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Configure the extension before generating. Need an API key? Find provider links in Resources.'
    );
    expect(apiKeyLink?.type).toBe('button');
    const geminiResource = shadowRoot?.querySelector<HTMLAnchorElement>(
      '.resources-link'
    );
    expect(geminiResource?.textContent?.trim()).toBe('Get Gemini API key');
    expect(geminiResource?.href).toBe('https://aistudio.google.com/app/apikey');
    const overlayStyles = readFileSync(
      resolve(process.cwd(), 'src/Overlay/Overlay.css'),
      'utf8'
    );
    expect(overlayStyles).toContain('.generation-panel');
    expect(overlayStyles).toMatch(/\.generation-panel[\s\S]*border-top/);
    expect(overlayStyles).toContain('font-size: 11px;');
    expect(overlayStyles).toContain('color: #4b5563;');
    expect(overlayStyles).toMatch(
      /\.status-panel\s*\{[\s\S]*flex-direction: column;[\s\S]*align-items: flex-start;/
    );
    expect(content?.hidden).toBe(true);

    apiKeyLink?.click();
    expect(content?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('▼');

    toggle?.click();
    expect(content?.hidden).toBe(true);

    toggle?.click();
    expect(content?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse Configuration');
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('▼');
    for (const selector of [
      '[data-add-credential]',
      '[data-replace-credential]',
      '[data-provider-select]',
      '[data-model-select]',
      '[data-credential-select]',
      '[data-save-validate-configuration]',
      '[data-delete-credential]',
      '[data-credential-status]',
      '[data-configuration-status]',
      '[data-configuration-message]',
    ]) {
      expect(content?.querySelector(selector)).not.toBeNull();
    }

    expect(content?.textContent).toContain('API Keys');
    expect(content?.textContent).toContain('Add Gemini API key');
    expect(content?.textContent).toContain('Replace API key');
    expect(content?.textContent).toContain('Delete this key');
    expect(content?.textContent).not.toContain('Credential');
    expect(content?.querySelector('[data-add-credential-form]')?.textContent).toContain(
      'Key Name'
    );
    expect(content?.querySelector('[data-credential-secret]')).toBeNull();
    expect(content?.querySelector('[data-replace-credential-select]')).not.toBeNull();
    expect(content?.querySelector('[data-replace-credential-secret]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(content?.textContent).toContain('Save & Validate');
    expect(content?.querySelector('[data-configuration-status]')?.textContent).toContain(
      'Save & Validate'
    );

    const addCredential = content?.querySelector<HTMLButtonElement>('[data-add-credential]');
    const addCredentialForm = content?.querySelector<HTMLElement>('[data-add-credential-form]');
    const replaceCredential = content?.querySelector<HTMLButtonElement>('[data-replace-credential]');
    const replaceCredentialForm = content?.querySelector<HTMLElement>('[data-replace-credential-form]');
    addCredential?.click();
    expect(addCredentialForm?.hidden).toBe(false);
    content?.querySelector<HTMLButtonElement>('[data-cancel-add-credential]')?.click();
    expect(addCredentialForm?.hidden).toBe(true);
    replaceCredential?.click();
    expect(replaceCredentialForm?.hidden).toBe(false);
    content?.querySelector<HTMLButtonElement>('[data-cancel-replace-credential]')?.click();
    expect(replaceCredentialForm?.hidden).toBe(true);

    currentConfigurationState = {
      ...currentConfigurationState,
      validation: null,
    };
    content?.querySelector<HTMLButtonElement>('[data-save-validate-configuration]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'configuration-set' })
      );
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'configuration-validate' })
      );
    });
    currentConfigurationState = {
      ...currentConfigurationState,
      credentials: [
        ...currentConfigurationState.credentials,
        {
          credentialId: 'credential-2',
          providerId: 'gemini',
          label: 'Backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    await overlay.refresh();
    const deleteCredentialSelect = content?.querySelector<HTMLSelectElement>(
      '[data-credential-select]'
    );
    if (!deleteCredentialSelect) throw new Error('API key selector missing.');
    deleteCredentialSelect.value = 'credential-2';
    deleteCredentialSelect.dispatchEvent(new Event('change'));
    content?.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'credential-delete-selected',
        credentialId: 'credential-2',
      });
    });
    expect(
      sendMessage.mock.calls.filter(
        ([message]) => message.type === 'credential-delete-selected'
      )
    ).toHaveLength(1);
    await vi.waitFor(() => {
      expect(
        currentConfigurationState.credentials.map((credential) => credential.credentialId)
      ).toEqual(['credential-1']);
      expect(deleteCredentialSelect.value).toBe('credential-1');
    });
    await vi.waitFor(() => {
      expect(content?.querySelector<HTMLElement>('[data-configuration-message]')?.textContent).toBe(
        'API key deleted.'
      );
    });
    const credentialMessage = content?.querySelector<HTMLElement>(
      '[data-credential-message]'
    );
    expect(credentialMessage?.hidden).toBe(true);
    expect(credentialMessage?.textContent).not.toContain('API key deleted.');

    const configurationMessage = content?.querySelector<HTMLElement>(
      '[data-configuration-message]'
    );
    if (!configurationMessage) throw new Error('Configuration message missing.');
    configurationMessage.textContent = '';
    configurationMessage.hidden = true;
    deleteCredentialSelect.value = '';
    content?.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    expect(configurationMessage.hidden).toBe(true);
    expect(configurationMessage.textContent).toBe('');
    expect(credentialMessage?.hidden).toBe(true);

    await vi.waitFor(() => {
      expect(guidance?.parentElement?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Configuration is valid. Need an API key? Get one from Google AI Studio.'
      );
    });
    toggle?.click();
    expect(content?.hidden).toBe(true);
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('►');
    expect(guidance?.parentElement?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Configuration is valid. Need an API key? Get one from Google AI Studio.'
    );
    expect(shadowRoot?.querySelector('[data-primary-action]')).not.toBeNull();
    expect(shadowRoot?.querySelector('[data-force-clear]')).not.toBeNull();

    currentConfigurationState = {
      ...configurationState,
      credentials: [
        ...configurationState.credentials,
        {
          credentialId: 'credential-2',
          providerId: 'gemini',
          label: 'Backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    await overlay.refresh();
    const credentialSelect = content?.querySelector<HTMLSelectElement>(
      '[data-credential-select]'
    );
    const primaryAction = shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-primary-action]'
    );
    const resultsContainer = shadowRoot?.querySelector<HTMLElement>('[data-results]');
    if (!credentialSelect || !primaryAction || !resultsContainer) {
      throw new Error('Configuration controls missing.');
    }
    const replaceResults = vi.spyOn(resultsContainer, 'replaceChildren');
    credentialSelect.value = 'credential-2';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      const status = content?.querySelector<HTMLElement>('[data-configuration-status]');
      expect(status?.textContent).toBe(
        'Status: Valid — re-save needed Save & Validate to use this configuration.'
      );
      expect(status?.querySelector('[data-resave-status]')?.textContent).toBe(
        'Status: Valid — re-save needed'
      );
    });
    expect(replaceResults).toHaveBeenCalledOnce();
    expect(primaryAction.disabled).toBe(true);
    primaryAction.click();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'p7-generate' })
    );

    content?.querySelector<HTMLButtonElement>('[data-save-validate-configuration]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'configuration-set',
          credentialId: 'credential-2',
        })
      );
    });
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'configuration-validate')).toHaveLength(1);
    await vi.waitFor(() => expect(primaryAction.disabled).toBe(false));

    credentialSelect.value = 'credential-1';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(content?.querySelector('[data-configuration-status]')?.textContent).toBe(
        'Status: Valid — re-save needed Save & Validate to use this configuration.'
      );
    });
    content?.querySelector<HTMLButtonElement>('[data-save-validate-configuration]')?.click();
    await vi.waitFor(() => expect(primaryAction.disabled).toBe(false));
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'configuration-validate')).toHaveLength(1);

    credentialSelect.value = 'credential-2';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(content?.querySelector('[data-configuration-status]')?.textContent).toBe(
        'Status: Valid — re-save needed Save & Validate to use this configuration.'
      );
    });
    content?.querySelector<HTMLButtonElement>('[data-save-validate-configuration]')?.click();
    await vi.waitFor(() => expect(primaryAction.disabled).toBe(false));
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'configuration-validate')).toHaveLength(1);
    toggle?.click();
    expect(content?.hidden).toBe(false);
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('▼');
  });

  it('generates once and removes the obsolete primary action in the real Shadow DOM workflow', async () => {
    let generationCount = 0;
    const pendingGeneration = new Promise<typeof generationResult>((resolve) => {
      resolveGeneration = resolve;
    });
    const sendMessage = vi.fn(async (message: {
      type?: string;
      selectedConfiguration?: {
        providerId: string;
        modelId: string;
        credentialId: string;
      };
    }) => {
      if (message.type === 'configuration-state') {
        const credentials = [
          ...configurationState.credentials,
          {
            credentialId: 'credential-2',
            providerId: 'gemini',
            label: 'Backup',
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-09-12T00:00:00.000Z',
          },
        ];
        if (!message.selectedConfiguration) {
          return { ...configurationState, credentials };
        }
        const isBackup =
          message.selectedConfiguration.credentialId === 'credential-2';
        return {
          ...configurationState,
          credentials,
          selectedConfiguration: {
            ...message.selectedConfiguration,
            providerConfig: {},
          },
          selectedConfigurationDigest: isBackup ? 'digest-2' : 'digest-1',
          selectedValidation: {
            ...configurationState.validation,
            credentialId: message.selectedConfiguration.credentialId,
            configurationDigest: isBackup ? 'digest-2' : 'digest-1',
          },
        };
      }
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        generationCount += 1;
        return generationCount === 1 ? pendingGeneration : generationResult;
      }
      if (message.type === 'p7-force-clear') return createForceClearResponse();
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay({
      onRefresh: async () => {
        await overlay?.refresh();
      },
    });
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const status = () => shadowRoot?.querySelector<HTMLElement>('[data-status]');
    const resultSummary = () => shadowRoot?.querySelector<HTMLElement>('.result-summary');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const forceClear = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]');
    const configurationControls = () =>
      Array.from(
        shadowRoot?.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >(
          '[data-configuration-content] button, [data-configuration-content] input, [data-configuration-content] select'
        ) ?? []
      );
    const forceClearDisplay = () => {
      const button = forceClear();
      if (!button) return undefined;
      if (button.hidden) return 'none';
      return getComputedStyle(button).display;
    };
    const overrideFlow = () => shadowRoot?.querySelector<HTMLElement>('[data-override-flow]');

    expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toMatch(
      /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important/
    );

    expect(overrideAction()?.hidden).toBe(true);
    expect(shadowRoot?.querySelector('[data-override-action]:not([hidden])')).toBeNull();

    await vi.waitFor(() => {
      expect(primary()?.hidden).toBe(false);
      expect(primary()?.textContent).toBe('Generate & Auto-Fill');
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
    });
    const validationStatus = shadowRoot?.querySelector<HTMLElement>(
      '[data-configuration-status]'
    );
    expect(validationStatus?.textContent).toBe('Status: Valid');
    expect(validationStatus?.classList.contains('is-validation-success')).toBe(true);

    const configurationControlStates = configurationControls().map((control) => ({
      control,
      disabled: control.disabled,
      title: control.getAttribute('title'),
      value: control.value,
    }));
    primary()?.click();
    await vi.waitFor(() => {
      expect(primary()?.textContent).toBe('Generating...');
      expect(status()?.textContent).toBe('Generating answers...');
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
      expect(shadowRoot?.querySelector('.overlay-panel')?.classList.contains('is-generating')).toBe(true);
      expect(shadowRoot?.querySelector('.overlay-panel.is-generating .logo-arm-left')).not.toBeNull();
      expect(shadowRoot?.querySelector('.overlay-panel.is-generating .logo-arm-right')).not.toBeNull();
      expect(shadowRoot?.querySelector('style')).not.toBeNull();
      expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toContain(
        'animation: overlay-border-gradient 0.7s linear infinite'
      );
    });
    expect(configurationControlStates.length).toBeGreaterThan(0);
    expect(configurationControls().every((control) => control.disabled)).toBe(true);
    expect(configurationControls().every((control) => control.title === 'Generation in progress')).toBe(true);
    resolveGeneration(generationResult);
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(primary()).toBeNull();
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
      expect(shadowRoot?.querySelector('.overlay-panel')?.classList.contains('is-generating')).toBe(false);
      expect(shadowRoot?.querySelector('.overlay-panel.is-generating .logo-arm-left')).toBeNull();
      expect(shadowRoot?.querySelector('.overlay-panel.is-generating .logo-arm-right')).toBeNull();
      expect(
        configurationControlStates.every(
          ({ control, disabled, title }) =>
            control.disabled === disabled && control.getAttribute('title') === title
        )
      ).toBe(true);
      expect(
        configurationControlStates.every(({ control, value }) => control.value === value)
      ).toBe(true);
      expect(resultSummary()?.hidden).not.toBe(true);
      expect(resultSummary()?.textContent).toContain(
        '4 filled · 0 already filled · 0 failed · 0 skipped'
      );
      expect(shadowRoot?.querySelector<HTMLElement>('.result-note')?.textContent).toBe(
        "All answers are already filled. Override is available if you want to replace them. Using Override will make another API call and replace the existing filled answer(s), whether they are correct or incorrect. Recommended: don't override every time to avoid rate limiting, unless your API key has no rate limit."
      );
      expect(shadowRoot?.querySelector<HTMLElement>('.all-filled-note')).not.toBeNull();
      expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toContain(
        '.result-note.all-filled-note'
      );
      const overlayStyles = readFileSync(
        resolve(process.cwd(), 'src/Overlay/Overlay.css'),
        'utf8'
      );
      expect(overlayStyles).toContain('margin: 4px 0 0;');
      expect(overlayStyles).toContain('padding: 0;');
      expect(overlayStyles).not.toContain('border: 2px solid #9ca3af;');
      expect(overlayStyles).toContain('background: #f8fafc;');
      expect(overlayStyles).toContain('font-size: 11px;');
      const visibleOverrideActions = [...(shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-override-action]') ?? [])]
        .filter((button) => !button.hidden);
      expect(visibleOverrideActions).toHaveLength(1);
      expect(visibleOverrideActions[0]?.textContent?.trim()).toBe('Override Filled Answer(s)');
      expect(forceClear()?.tagName).toBe('BUTTON');
      expect(forceClear()?.textContent?.trim()).toBe('Force Unsettle This Page');
      expect(forceClear()?.hidden).toBe(true);
      expect(
        [...(shadowRoot?.querySelectorAll('button') ?? [])].some(
          (button) => button.textContent?.includes('Generating...')
        )
      ).toBe(false);
      expect(
        [...(shadowRoot?.querySelectorAll('button') ?? [])].some(
          (button) => button.textContent?.includes('Generate & Auto-Fill')
        )
      ).toBe(false);
    });
    
    expect(overrideFlow()?.hidden).toBe(true);
    overrideAction()?.click();
    expect(overrideFlow()?.hidden).toBe(false);
    expect(overrideAction()?.textContent?.trim()).toBe('Override Filled Answer(s)');
    expect(overrideFlow()?.querySelector('h3')).toBeNull();
    expect(shadowRoot?.querySelector('[data-override-specific]')).toBeNull();
    const openedCandidates = shadowRoot?.querySelectorAll<HTMLInputElement>(
      '[data-override-specific-list] input[type="checkbox"]'
    );
    expect(
      shadowRoot?.querySelector<HTMLElement>('[data-override-specific-list]')?.hidden
    ).toBe(false);
    expect(openedCandidates).toHaveLength(4);
    expect([...openedCandidates ?? []].every((checkbox) => !checkbox.checked)).toBe(true);
    openedCandidates?.[1]?.click();
    expect(openedCandidates?.[1]?.checked).toBe(true);
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation]')?.hidden).toBe(false);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-cancel]')?.click();
    overrideAction()?.click();
    expect(overrideFlow()?.hidden).toBe(true);
    overrideAction()?.click();
    expect(overrideFlow()?.hidden).toBe(false);
    expect(shadowRoot?.querySelector('[data-override-all]')).not.toBeNull();
    expect(shadowRoot?.querySelector('[data-override-specific-state]')).toBeNull();
    expect(shadowRoot?.querySelector('[data-override-uncheck]')?.textContent?.trim()).toBe(
      'Uncheck All'
    );
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    expect(shadowRoot?.querySelector('[data-override-all]')?.textContent?.trim()).toBe(
      'All filled answers'
    );
    expect(
      [...(shadowRoot?.querySelectorAll<HTMLInputElement>('[data-override-specific-list] input') ?? [])]
        .every((checkbox) => checkbox.checked)
    ).toBe(true);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'p7-generate')).toHaveLength(1);
    expect(
      shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation-text]')?.textContent
    ).toBe('Override 4 filled answers?');
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-uncheck]')?.click();
    expect(
      [...(shadowRoot?.querySelectorAll<HTMLInputElement>('[data-override-specific-list] input') ?? [])]
        .every((checkbox) => !checkbox.checked)
    ).toBe(true);
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation]')?.hidden).toBe(true);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-cancel]')?.click();
    shadowRoot?.querySelectorAll<HTMLInputElement>('[data-override-specific-list] input')[1]?.click();
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation]')?.hidden).toBe(false);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-cancel]')?.click();
    expect(shadowRoot?.querySelector('span[data-filled-status]')).not.toBeNull();
    expect(shadowRoot?.querySelector('[data-primary-action]')).toBeNull();
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-discover')
    ).toHaveLength(1);

    shadowRoot?.querySelector<HTMLButtonElement>('.overlay-refresh')?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Ready to generate');
      expect(primary()?.textContent).toBe('Generate & Auto-Fill');
      expect(primary()?.hidden).toBe(false);
      expect(resultSummary()).toBeNull();
      expect(overrideAction()?.hidden).toBe(true);
      expect(overrideFlow()?.hidden).toBe(true);
    });
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-discover')
    ).toHaveLength(2);
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'p7-force-clear' });

    primary()?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(primary()).toBeNull();
    });
    expect(generationCount).toBe(2);

    overrideAction()?.click();
    expect(overrideFlow()?.hidden).toBe(false);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]')?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Ready to generate');
      expect(overrideFlow()?.hidden).toBe(true);
      expect(primary()?.hidden).toBe(false);
    });

    expect(sendMessage).toHaveBeenCalledWith({ type: 'p7-force-clear' });

    primary()?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(primary()).toBeNull();
    });
    expect(generationCount).toBe(3);
    overrideAction()?.click();
    expect(overrideFlow()?.hidden).toBe(false);

    const credentialSelect = shadowRoot?.querySelector<HTMLSelectElement>(
      '[data-credential-select]'
    );
    if (!credentialSelect) throw new Error('API key selector missing.');
    const actionContainer = shadowRoot?.querySelector('[data-filled-status]')
      ?.parentElement;
    if (!actionContainer) throw new Error('Generate action container missing.');
    const insertedPrimaryLabels: string[] = [];
    const insertBefore = actionContainer.insertBefore.bind(actionContainer);
    vi.spyOn(actionContainer, 'insertBefore').mockImplementation((node, reference) => {
      if (
        node instanceof HTMLButtonElement &&
        node.matches('[data-primary-action]')
      ) {
        insertedPrimaryLabels.push(node.textContent ?? '');
      }
      return insertBefore(node, reference);
    });
    credentialSelect.value = 'credential-2';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Ready to configure');
      expect(resultSummary()).toBeNull();
      expect(overrideAction()?.hidden).toBe(true);
      expect(overrideFlow()?.hidden).toBe(true);
      expect(
        shadowRoot?.querySelector<HTMLElement>('.all-filled-note')?.hidden
      ).toBe(true);
      expect(
        shadowRoot?.querySelector('[data-configuration-status]')?.textContent
      ).toBe('Status: Valid — re-save needed Save & Validate to use this configuration.');
    });
    expect(insertedPrimaryLabels).toEqual(['Generate & Auto-Fill']);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'configuration-validate')).toHaveLength(0);
    expect(shadowRoot?.textContent).not.toContain(
      '4 filled · 0 already filled · 0 failed · 0 skipped'
    );
    expect(shadowRoot?.textContent).not.toContain('All answers are already filled.');
  });

  it('ignores a late generation snapshot after changing the selected API key', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    let generationCount = 0;
    const pendingGeneration = new Promise<typeof generationResult>((resolve) => {
      resolveGeneration = resolve;
    });
    const backupCredential = {
      credentialId: 'credential-2',
      providerId: 'gemini',
      label: 'Backup',
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    };
    const sendMessage = vi.fn(async (message: {
      type?: string;
      selectedConfiguration?: {
        providerId: string;
        modelId: string;
        credentialId: string;
      };
    }) => {
      if (message.type === 'configuration-state') {
        const credentials = [...configurationState.credentials, backupCredential];
        if (message.selectedConfiguration) {
          return {
            ...configurationState,
            credentials,
            selectedConfiguration: {
              ...message.selectedConfiguration,
              providerConfig: {},
            },
            selectedConfigurationDigest: 'digest-2',
            selectedValidation: {
              ...configurationState.validation,
              credentialId: 'credential-2',
              configurationDigest: 'digest-2',
            },
          };
        }
        return { ...configurationState, credentials };
      }
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        generationCount += 1;
        return generationCount === 1 ? generationResult : pendingGeneration;
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      },
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (listener: (message: unknown) => void) =>
            listeners.push(listener),
        },
      },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const status = () => shadowRoot?.querySelector<HTMLElement>('[data-status]');
    const resultSummary = () => shadowRoot?.querySelector<HTMLElement>('.result-summary');
    const overrideAction = () =>
      shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const overrideFlow = () =>
      shadowRoot?.querySelector<HTMLElement>('[data-override-flow]');
    const primary = () =>
      shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');

    await vi.waitFor(() => expect(primary()?.disabled).toBe(false));
    primary()?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(overrideAction()?.hidden).toBe(false);
    });
    overrideAction()?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-confirm]')?.click();
    await vi.waitFor(() => {
      expect(generationCount).toBe(2);
      expect(primary()?.textContent).toBe('Generating...');
    });

    const credentialSelect = shadowRoot?.querySelector<HTMLSelectElement>(
      '[data-credential-select]'
    );
    if (!credentialSelect) throw new Error('API key selector missing.');
    credentialSelect.value = 'credential-2';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Ready to configure');
      expect(
        shadowRoot?.querySelector('[data-configuration-status]')?.textContent
      ).toBe('Status: Valid — re-save needed Save & Validate to use this configuration.');
    });

    listeners[0]?.({
      type: 'p7-state-updated',
      snapshot: {
        uiState: 'ERROR',
        page: { pageId: 'page-1', questionCount: 4 },
        result: null,
        error: 'Provider request failed.',
        generationOperationId: null,
      },
    });
    expect(status()?.textContent).toBe('Ready to configure');
    expect(resultSummary()).toBeNull();
    expect(overrideAction()?.hidden).toBe(true);
    expect(overrideFlow()?.hidden).toBe(true);
    expect(shadowRoot?.querySelector<HTMLElement>('[data-message]')?.hidden).toBe(true);
    expect(shadowRoot?.textContent).not.toContain('Provider request failed.');
    expect(shadowRoot?.textContent).not.toContain(
      '4 filled · 0 already filled · 0 failed · 0 skipped'
    );
    expect(
      shadowRoot?.querySelector('[data-configuration-status]')?.textContent
    ).toBe('Status: Valid — re-save needed Save & Validate to use this configuration.');

    resolveGeneration(generationResult);
    await vi.waitFor(() => expect(primary()?.textContent).toBe('Generate & Auto-Fill'));
    expect(status()?.textContent).toBe('Ready to configure');
    expect(resultSummary()).toBeNull();
    expect(overrideAction()?.hidden).toBe(true);
    expect(
      shadowRoot?.querySelector('[data-configuration-status]')?.textContent
    ).toBe('Status: Valid — re-save needed Save & Validate to use this configuration.');
  });

  it('renders reused answers as a non-interactive settled status', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        return { status: 'reused' as const, pageId: 'page-1' };
      }
      if (message.type === 'p7-force-clear') return createForceClearResponse();
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const settledStatus = () => shadowRoot?.querySelector<HTMLElement>('[data-filled-status]');
    const settledDetail = () => shadowRoot?.querySelector<HTMLElement>('[data-detail]');
    const forceClearNote = () => shadowRoot?.querySelector<HTMLElement>('[data-force-clear-note]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const forceClear = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]');
    const forceClearDisplay = () => {
      const button = forceClear();
      if (!button) return undefined;
      if (button.hidden) return 'none';
      return getComputedStyle(button).display;
    };

    expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toMatch(
      /\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important/
    );

    await vi.waitFor(() => expect(primary()?.textContent).toBe('Generate & Auto-Fill'));
    primary()?.click();
    await vi.waitFor(() => {
      expect(shadowRoot?.querySelector('[data-primary-action]')).toBeNull();
      expect(settledStatus()?.textContent).toBe('Page Answers already settled');
      expect(settledStatus()?.hidden).toBe(false);
      expect(settledStatus()?.tagName).toBe('SPAN');
      expect(settledStatus()?.classList.contains('is-settled')).toBe(true);
      expect(settledDetail()?.textContent).toBe('Reused answers for page page-1.');
      expect(settledDetail()?.classList.contains('settled-detail')).toBe(true);
      expect(forceClearNote()?.textContent?.trim()).toBe(
        'Force unsettling this page re-enables generation for this page. Once unsettled, you can generate answers again.'
      );
      expect(forceClearNote()?.hidden).toBe(false);
      expect(shadowRoot?.querySelector('button[data-filled-status]')).toBeNull();
      const forceClear = shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]');
      expect(forceClear?.tagName).toBe('BUTTON');
      expect(forceClear?.textContent?.trim()).toBe('Force Unsettle This Page');
      expect(forceClear?.hidden).toBe(false);
      expect(forceClearDisplay()).not.toBe('none');
      expect(overrideAction()?.hidden).toBe(true);
    });

    forceClear()?.click();
    await vi.waitFor(() => {
      expect(settledStatus()?.hidden).toBe(true);
      expect(primary()?.textContent).toBe('Generate & Auto-Fill');
      expect(primary()?.hidden).toBe(false);
      expect(overrideAction()?.hidden).toBe(true);
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
      expect(forceClearNote()?.hidden).toBe(true);
      expect(settledDetail()?.classList.contains('settled-detail')).toBe(false);
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'p7-force-clear' });
  });

  it('explains the all-answers-filled no-op while keeping Override available', async () => {
    let generationCalls = 0;
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        generationCalls += 1;
        return createAlreadyFilledGenerationResult();
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => {
      expect(shadowRoot?.querySelector<HTMLElement>('.result-summary')?.textContent).toBe(
        '0 filled · 0 already filled · 0 failed · 0 skipped'
      );
      expect(shadowRoot?.querySelector<HTMLElement>('.result-note')?.textContent).toBe(
        "All answers are already filled. Override is available if you want to replace them. Using Override will make another API call and replace the existing filled answer(s), whether they are correct or incorrect. Recommended: don't override every time to avoid rate limiting, unless your API key has no rate limit."
      );
      expect(shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]')?.hidden).toBe(false);
    });
    expect(generationCalls).toBe(1);
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-generate')
    ).toHaveLength(1);
  });

  it('keeps normal filled counts and appends only successful Override replacements', async () => {
    const overrideResult = {
      report: { cycleId: 'cycle-override', status: 'complete' as const, results: [] },
      fillReport: {
        cycleId: 'cycle-override',
        outcomes: [
          { questionId: 'question-1', status: 'FILLED' as const },
          { questionId: 'question-2', status: 'FILLED' as const },
          { questionId: 'question-3', status: 'FILLED' as const },
          {
            questionId: 'question-4',
            status: 'FILL_FAILED' as const,
            reason: 'The question was empty. Consider manually entering an answer or using Auto-Generate.',
          },
        ],
      },
    };
    let generationCalls = 0;
    const onRefresh = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        generationCalls += 1;
        return generationCalls === 1 ? generationResult : overrideResult;
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay({ onRefresh });
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const summary = () => shadowRoot?.querySelector<HTMLElement>('.result-summary');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() =>
      expect(summary()?.textContent).toBe('4 filled · 0 already filled · 0 failed · 0 skipped')
    );
    overrideAction()?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-confirm]')?.click();
    await vi.waitFor(() =>
      expect(summary()?.textContent).toBe(
        '3 filled · 0 already filled · 1 failed · 0 skipped · 3 overrided'
      )
    );
    const failureHeader = shadowRoot?.querySelector<HTMLElement>('.override-failure');
    expect(failureHeader?.textContent).toBe('Override failed for Q4. ↻');
    const inlineRefresh = failureHeader?.querySelector<HTMLButtonElement>(
      '.override-failure-refresh'
    );
    expect(inlineRefresh?.textContent).toBe('↻');
    expect(inlineRefresh?.getAttribute('aria-label')).toBe('Refresh');
    expect(inlineRefresh?.title).toBe('Refresh');
    expect(inlineRefresh?.tagName).toBe('BUTTON');
    expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toContain(
      'color: #c2410c;'
    );
    expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).not.toContain(
      'color: #9a3412;'
    );
    shadowRoot?.querySelector<HTMLButtonElement>('.overlay-refresh')?.click();
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    inlineRefresh?.click();
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(shadowRoot?.querySelector<HTMLElement>('.override-failure-detail')?.textContent).toBe(
      'Q4 was empty. Consider manually entering an answer or using Auto-Generate.'
    );
    const overrideFlow = shadowRoot?.querySelector<HTMLElement>('[data-override-flow]');
    expect(overrideFlow?.hidden).toBe(true);
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-specific-list]')?.hidden).toBe(true);
    expect(shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]')?.hidden).toBe(false);
    expect(shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]')?.hidden).toBe(true);
    expect(summary()?.textContent).toContain('3 filled');
    expect(summary()?.textContent).toContain('3 overrided');
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]')?.click();
    expect(overrideFlow?.hidden).toBe(false);
    expect(shadowRoot?.querySelectorAll('[data-override-specific-list] input')).toHaveLength(4);
  });

  it('does not append an Override count for cancellation or failed Override', async () => {
    let generationCalls = 0;
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        generationCalls += 1;
        return generationCalls === 1 ? generationResult : { error: 'Override failed.' };
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const summary = () => shadowRoot?.querySelector<HTMLElement>('.result-summary');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() =>
      expect(summary()?.textContent).toBe('4 filled · 0 already filled · 0 failed · 0 skipped')
    );
    overrideAction()?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-cancel]')?.click();
    expect(summary()?.textContent).not.toContain('overrided');
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-confirm]')?.click();
    await vi.waitFor(() => expect(shadowRoot?.querySelector('[data-status]')?.textContent).toBe("Couldn't generate answers."));
    expect(shadowRoot?.querySelector('.result-summary')).toBeNull();
  });

  it('keeps an answer discovered after structural readiness through zero-result REVIEW into Override', async () => {
    document.body.innerHTML = `
      <main>
        <section data-page-id="page-ready-sync" data-answersense-active-page="true">
          <div
            role="listitem"
            data-question-id="already-filled"
            data-question-text="Already filled question"
            data-question-type="short-text"
          >
            <input type="text" value="">
          </div>
        </section>
      </main>
    `;
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    const discovery = waitForInitialDiscovery(
      document,
      () => discoverActiveGoogleFormsPage(document),
      { timeoutMs: 1000 }
    );
    input!.value = 'Existing answer';
    const discovered = await discovery;
    const normalized = normalizeDiscoveredActivePage(discovered!, 'cycle-ready-sync');
    const readyQuestion = normalized.form.questions[0];
    expect(readyQuestion).toMatchObject({
      id: 'already-filled',
      supported: true,
      type: 'short-text',
      existingInput: { value: 'Existing answer', hasValue: true },
    });

    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') {
        return {
          supported: true,
          uiState: 'READY' as const,
          page: { pageId: normalized.form.activePageId, questionCount: 1 },
          lifecycle: {
            activePage: {
              form: {
                questions: normalized.form.questions.map((question) => ({
                  id: question.id,
                  text: question.text,
                  type: question.type,
                  supported: question.supported,
                  existingInput: question.existingInput
                    ? { hasValue: question.existingInput.hasValue }
                    : null,
                })),
              },
            },
          },
          result: null,
          error: null,
        };
      }
      if (message.type === 'p7-generate') {
        const skippedQuestionIds: Array<string | null> = [
          'already-filled',
          ...Array.from({ length: 9 }, (_, index) => `skipped-${index + 2}`),
          null,
        ];
        const results: QuestionResult[] = [
          ...skippedQuestionIds.map((questionId, index) => ({
            questionId,
            status:
              index === 1 || index === 2
                ? ('unsupported' as const)
                : ('ABSTAINED' as const),
            answer: null,
            reason:
              index === 0
                ? 'LOW_CONFIDENCE'
                : index === 1
                  ? 'Question type is unsupported.'
                  : index === 2
                    ? 'Question text is unavailable.'
                    : 'UNABLE_TO_DETERMINE',
          })),
          {
            questionId: 'unfilled-only',
            status: 'GENERATED',
            answer: { questionId: 'unfilled-only', value: 'Not filled' },
            reason: null,
          },
          {
            questionId: 'failed-12',
            status: 'GENERATION_FAILED',
            answer: null,
            reason: 'Generation failed.',
          },
        ];
        return {
          report: {
            cycleId: 'cycle-zero-skipped',
            status: 'partial' as const,
            results,
          },
          fillReport: {
            cycleId: 'cycle-zero-skipped',
            outcomes: [
              ...skippedQuestionIds.map((questionId) => ({
                questionId,
                status: 'SKIPPED' as const,
                reason: 'The reviewed answer was skipped.',
                answer: null,
                code: null,
              })),
              {
                questionId: 'failed-12',
                status: 'FILL_FAILED' as const,
                reason: 'The current DOM question was not found.',
                answer: null,
                code: 'ELEMENT_NOT_FOUND' as const,
              },
            ],
          },
        };
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => {
      expect(shadowRoot?.querySelector<HTMLElement>('.result-summary')?.textContent).toContain(
        '0 filled · 1 already filled · 1 failed · 11 skipped'
      );
      expect(overrideAction()?.hidden).toBe(false);
    });
    const tooltipTrigger = shadowRoot?.querySelector<HTMLButtonElement>(
      '.skipped-details-trigger'
    );
    const skippedLabel = shadowRoot?.querySelector<HTMLElement>(
      '.result-summary-skipped'
    );
    expect(skippedLabel?.textContent).toContain('11 skipped');
    expect(
      shadowRoot?.querySelector('.result-summary-row > .skipped-details')
    ).not.toBeNull();
    expect(
      shadowRoot?.querySelector('.result-summary-row > .skipped-details')
        ?.previousElementSibling
    ).toBe(shadowRoot?.querySelector('.result-summary'));
    expect(tooltipTrigger?.querySelector('svg.validation-failure-info')).not.toBeNull();
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('false');
    const tooltipAnchor = tooltipTrigger?.parentElement;
    const mouseEnter = new Event('pointerenter');
    Object.defineProperty(mouseEnter, 'pointerType', { value: 'mouse' });
    tooltipAnchor?.dispatchEvent(mouseEnter);
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('true');
    const mouseLeave = new Event('pointerleave');
    Object.defineProperty(mouseLeave, 'pointerType', { value: 'mouse' });
    tooltipAnchor?.dispatchEvent(mouseLeave);
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('true');
    const tooltipPanel = shadowRoot?.querySelector<HTMLElement>(
      '#skipped-question-details'
    );
    const panelEnter = new Event('pointerenter');
    Object.defineProperty(panelEnter, 'pointerType', { value: 'mouse' });
    tooltipPanel?.dispatchEvent(panelEnter);
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('true');
    const panelLeave = new Event('pointerleave');
    Object.defineProperty(panelLeave, 'pointerType', { value: 'mouse' });
    tooltipPanel?.dispatchEvent(panelLeave);
    await vi.waitFor(() =>
      expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('false')
    );
    tooltipTrigger?.focus();
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('true');
    tooltipTrigger?.blur();
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('false');
    const touchDown = new Event('pointerdown');
    Object.defineProperty(touchDown, 'pointerType', { value: 'touch' });
    tooltipTrigger?.dispatchEvent(touchDown);
    tooltipTrigger?.click();
    expect(tooltipTrigger?.getAttribute('aria-expanded')).toBe('true');
    const tooltip = shadowRoot?.querySelector<HTMLElement>(
      '#skipped-question-details'
    );
    expect(tooltip?.getAttribute('aria-hidden')).toBe('false');
    const tooltipItems = tooltip?.querySelectorAll('li') ?? [];
    expect(tooltipItems).toHaveLength(11);
    expect(tooltipItems[0]?.textContent).toContain('Question ID already-filled');
    expect(tooltipItems[0]?.textContent).toContain('Already filled question');
    expect(tooltipItems[0]?.textContent).toContain(
      'No confident answer was available. The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.'
    );
    expect(tooltipItems[1]?.textContent).toContain('Question ID skipped-2');
    expect(tooltipItems[1]?.textContent).toContain(
      'Question type is unsupported. The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.'
    );
    expect(tooltipItems[2]?.textContent).toContain('Question ID skipped-3');
    expect(tooltipItems[2]?.textContent).toContain(
      'Question text is unavailable or empty. The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.'
    );
    expect(tooltipItems[3]?.textContent).toContain(
      'An answer could not be determined.'
    );
    expect(tooltipItems[10]?.textContent).toContain('Question ID unavailable');
    expect(tooltipItems[10]?.textContent).not.toContain('failed-12');
    expect(tooltipItems[10]?.textContent).not.toContain('unfilled-only');
    const overlayCss = readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8');
    expect(overlayCss).toMatch(
      /\.skipped-details-panel\s*\{[^}]*max-height:\s*min\(280px,[^}]*overflow-y:\s*auto;/
    );
    overrideAction()?.click();
    expect(
      shadowRoot?.querySelectorAll<HTMLInputElement>('[data-override-specific-list] input')
    ).toHaveLength(1);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    expect(
      shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation-text]')?.textContent
    ).toBe('Override 1 filled answer?');
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'p7-discover')).toHaveLength(1);
  });

  it('does not show the all-answers-filled note when generation fails', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') return { error: 'Generation failed.' };
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => {
      expect(shadowRoot?.querySelector<HTMLElement>('[data-status]')?.textContent).toBe(
        "Couldn't generate answers."
      );
      expect(shadowRoot?.querySelector('.result-note:not([hidden])')).toBeNull();
      expect(shadowRoot?.querySelector<HTMLElement>('[data-force-clear-note]')?.hidden).toBe(true);
      expect(shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]')?.hidden).toBe(true);
    });
  });

  it('projects filled generation outcomes into Override without Refresh', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createUnfilledSnapshot();
      if (message.type === 'p7-generate') return generationResult;
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const overrideRefresh = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-refresh]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => expect(overrideAction()?.hidden).toBe(false));
    expect(overrideRefresh()?.hidden).toBe(false);
    overrideAction()?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-specific]')?.click();
    expect(
      shadowRoot?.querySelectorAll('[data-override-specific-list] input')
    ).toHaveLength(4);
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-generate')
    ).toHaveLength(1);
  });

  it('refreshes only Override candidates when its filled-answer count is zero', async () => {
    const noFilledResult = {
      report: { cycleId: 'cycle-1', status: 'complete' as const, results: [] },
      fillReport: { cycleId: 'cycle-1', outcomes: [] },
    };
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createUnfilledSnapshot();
      if (message.type === 'p7-generate') return noFilledResult;
      return {};
    });
    const onRefresh = vi.fn(async () => undefined);

    const page = document.createElement('section');
    page.dataset.pageId = 'page-1';
    page.dataset.answersenseActivePage = 'true';
    for (let index = 1; index <= 4; index += 1) {
      const question = document.createElement('div');
      question.setAttribute('role', 'listitem');
      question.dataset.questionId = `question-${index}`;
      question.dataset.questionType = 'short-text';
      question.dataset.questionText = `Question ${index}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = `Detected answer ${index}`;
      question.append(input);
      page.append(question);
    }
    document.body.append(page);

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay({ onRefresh });
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideRefresh = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-refresh]');
    const candidateInputs = () =>
      shadowRoot?.querySelectorAll<HTMLInputElement>(
        '[data-override-specific-list] input[type="checkbox"]'
      );

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    expect(overrideRefresh()?.hidden).toBe(true);
    primary()?.click();
    await vi.waitFor(() =>
      expect(shadowRoot?.querySelector<HTMLElement>('[data-status]')?.textContent).toBe(
        'Review answers'
      )
    );
    expect(overrideRefresh()?.hidden).toBe(false);
    expect(overrideRefresh()?.getAttribute('aria-label')).toBe(
      'Refresh filled-answer detection'
    );
    expect(candidateInputs()).toHaveLength(0);

    overrideRefresh()?.click();
    await vi.waitFor(() =>
      expect(
        shadowRoot?.querySelector<HTMLElement>('[data-override-flow]')?.hidden
      ).toBe(false)
    );
    expect(overrideRefresh()?.hidden).toBe(false);
    expect(candidateInputs()).toHaveLength(4);
    expect(shadowRoot?.querySelector<HTMLElement>('[data-status]')?.textContent).toBe(
      'Review answers'
    );
    expect(shadowRoot?.querySelector<HTMLElement>('.result-summary')).not.toBeNull();
    candidateInputs()?.[0]?.click();
    expect(
      shadowRoot?.querySelector<HTMLElement>(
        '[data-override-confirmation-text]'
      )?.textContent
    ).toBe('Override 1 filled answer?');
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-all]')?.click();
    expect(
      shadowRoot?.querySelector<HTMLElement>(
        '[data-override-confirmation-text]'
      )?.textContent
    ).toBe('Override 4 filled answers?');

    expect(onRefresh).not.toHaveBeenCalled();
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-discover')
    ).toHaveLength(1);
    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === 'p7-generate')
    ).toHaveLength(1);
  });

  it('uses the synchronized multi-page lifecycle projection without Refresh', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') {
        return {
          ...createSnapshot(),
          page: { pageId: 'page-a', questionCount: 2 },
          lifecycle: {
            activePage: {
              form: {
                activePageId: 'page-a',
                questions: [
                  {
                    id: 'page-a-first',
                    text: 'Page A first',
                    type: 'short-text',
                    supported: true,
                    existingInput: { hasValue: false },
                  },
                  {
                    id: 'page-a-second',
                    text: 'Page A second',
                    type: 'short-text',
                    supported: true,
                    existingInput: { hasValue: false },
                  },
                ],
              },
            },
          },
        };
      }
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');
    const overrideSpecific = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-specific]');

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'p7-discover' }));
    listeners[0]?.({
      type: 'p7-state-updated',
      snapshot: {
        uiState: 'READY',
        page: { pageId: 'page-b', questionCount: 1 },
        result: null,
        error: null,
      },
    });
    listeners[0]?.({
      type: 'p7-state-updated',
      snapshot: {
        uiState: 'REVIEW',
        page: {
          pageId: 'page-a',
          questionCount: 2,
          questions: [
            {
              id: 'page-a-first',
              text: 'Page A first',
              type: 'short-text',
              supported: true,
              existingInput: { hasValue: true },
            },
            {
              id: 'page-a-second',
              text: 'Page A second',
              type: 'short-text',
              supported: true,
              existingInput: { hasValue: true },
            },
          ],
        },
        result: generationResult,
        error: null,
      },
    });

    await vi.waitFor(() => expect(overrideAction()?.hidden).toBe(false));
    overrideAction()?.click();
    overrideSpecific()?.click();
    expect(
      shadowRoot?.querySelectorAll<HTMLInputElement>('[data-override-specific-list] input')
    ).toHaveLength(2);
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'p7-discover' && message !== undefined)).toBe(true);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'p7-discover')).toHaveLength(1);
  });

  it('opens Override in REVIEW and sends only the selected eligible question IDs', async () => {
    const sendMessage = vi.fn(async (message: { type?: string; intent?: unknown }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') return generationResult;
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => expect(overrideAction()?.hidden).toBe(false));
    overrideAction()?.click();
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-flow]')?.hidden).toBe(false);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-specific]')?.click();

    const checkboxes = shadowRoot?.querySelectorAll<HTMLInputElement>(
      '[data-override-specific-list] input[type="checkbox"]'
    );
    expect(checkboxes).toHaveLength(4);
    checkboxes?.[1].click();
    expect(shadowRoot?.querySelector<HTMLElement>('[data-override-confirmation]')?.hidden).toBe(false);
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-confirm]')?.click();

    await vi.waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(([message]) => message.type === 'p7-generate')
      ).toHaveLength(2)
    );
    const generateCalls = sendMessage.mock.calls.filter(
      ([message]) => message.type === 'p7-generate'
    );
    expect(generateCalls[1]?.[0]).toMatchObject({
      type: 'p7-generate',
      intent: { type: 'OVERRIDE_FILLED', selectedQuestionIds: ['question-2'] },
    });
  });

  it('collapses long Override question text and toggles the complete display', async () => {
    const longText =
      'The Renaissance began in ______ (country) in the 14th century and marked a revival of interest in classical Greek and Roman art and learning. One of its most iconic works, the Mona Lisa, remains widely studied today.';
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') {
        const snapshot = createSnapshot();
        return {
          ...snapshot,
          lifecycle: {
            ...snapshot.lifecycle,
            activePage: {
              ...snapshot.lifecycle.activePage,
              form: {
                ...snapshot.lifecycle.activePage.form,
                questions: snapshot.lifecycle.activePage.form.questions.map((question, index) =>
                  index === 0 ? { ...question, text: longText } : question
                ),
              },
            },
          },
        };
      }
      if (message.type === 'p7-generate') return generationResult;
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const overrideAction = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-override-action]');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => expect(overrideAction()?.hidden).toBe(false));
    overrideAction()?.click();

    const candidateLabels = shadowRoot?.querySelectorAll<HTMLLabelElement>('[data-override-specific-list] label');
    expect(candidateLabels).toHaveLength(4);
    const longLabel = candidateLabels?.[0];
    const toggle = longLabel?.querySelector<HTMLButtonElement>('[data-question-toggle]');
    const questionSpans = longLabel?.querySelectorAll<HTMLSpanElement>('span');
    const overlayCss = readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toBe('►');
    expect(overlayCss).toMatch(
      /\.override-question-toggle\s*\{[\s\S]*display: inline-flex;[\s\S]*align-items: center;[\s\S]*justify-content: center;/
    );
    expect(longLabel?.textContent).toContain('...');
    expect(questionSpans?.[0]?.hidden).toBe(false);
    expect(questionSpans?.[1]?.hidden).toBe(true);
    toggle?.click();
    expect(toggle?.textContent).toBe('▼');
    expect(questionSpans?.[0]?.hidden).toBe(true);
    expect(questionSpans?.[1]?.hidden).toBe(false);
    expect(questionSpans?.[1]?.textContent).toBe(longText);
    toggle?.click();
    expect(toggle?.textContent).toBe('►');
    expect(questionSpans?.[0]?.hidden).toBe(false);
    expect(questionSpans?.[1]?.hidden).toBe(true);
    expect(candidateLabels?.[1]?.textContent).toBe('Question 2');
  });

  it('offers refresh recovery after a provider failure without retrying generation', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        return { error: 'Server was busy. Try again.' };
      }
      return {};
    });
    const onRefresh = vi.fn(async () => undefined);

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay({ onRefresh });
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const primary = () => shadowRoot?.querySelector<HTMLButtonElement>('[data-primary-action]');
    const message = () => shadowRoot?.querySelector<HTMLElement>('[data-message]');
    const refresh = () => message()?.querySelector<HTMLButtonElement>('.override-failure-refresh');

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => expect(message()?.hidden).toBe(false));

    expect(message()?.textContent).toContain('Server was busy. Try again.');
    expect(message()?.textContent).not.toContain("Couldn't generate answers.");
    expect(shadowRoot?.querySelector('[data-status]')?.textContent).toBe(
      'Server was busy. Try again.'
    );
    expect(refresh()).not.toBeNull();
    expect(sendMessage.mock.calls.filter(([request]) => request.type === 'p7-generate')).toHaveLength(1);

    refresh()?.click();
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls.filter(([request]) => request.type === 'p7-generate')).toHaveLength(1);
  });

  it('opens configuration from API-key help and keeps the Gemini resource link', async () => {
    const fixture = await mountProviderActionOverlay(async (message) => {
      if (message.type === 'configuration-state') {
        return providerActionConfigurationState();
      }
      if (message.type === 'p7-discover') return createSnapshot();
      return {};
    });
    overlay = fixture.handle;
    const { shadowRoot } = fixture;
    const helpButton = shadowRoot.querySelector<HTMLButtonElement>(
      '[data-open-configuration]'
    );
    const content = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-content]'
    );
    const toggle = shadowRoot.querySelector<HTMLButtonElement>(
      '[data-configuration-toggle]'
    );
    const resourceLink = shadowRoot.querySelector<HTMLAnchorElement>(
      '.resources-link'
    );
    const nvidiaResourceLink = shadowRoot.querySelector<HTMLAnchorElement>(
      '.resources-link[href="https://build.nvidia.com/settings/api-keys"]'
    );

    expect(helpButton?.textContent?.trim()).toBe(
      'Need an API key? Find provider links in Resources.'
    );
    expect(content?.hidden).toBe(true);
    expect(resourceLink?.textContent?.trim()).toBe('Get Gemini API key');
    expect(resourceLink?.href).toBe(
      'https://aistudio.google.com/app/apikey'
    );
    expect(resourceLink?.target).toBe('_blank');
    expect(resourceLink?.rel).toBe('noopener noreferrer');
    const geminiLogo = resourceLink?.querySelector<SVGSVGElement>('svg');
    expect(geminiLogo?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(geminiLogo?.getAttribute('fill')).toBe('currentColor');
    expect(geminiLogo?.querySelectorAll('path')).toHaveLength(1);
    expect(nvidiaResourceLink?.textContent?.trim()).toBe('Get NVIDIA API key');
    expect(nvidiaResourceLink?.href).toBe(
      'https://build.nvidia.com/settings/api-keys'
    );
    expect(nvidiaResourceLink?.target).toBe('_blank');
    expect(nvidiaResourceLink?.rel).toBe('noopener noreferrer');
    const nvidiaLogo = nvidiaResourceLink?.querySelector<SVGSVGElement>('svg');
    expect(nvidiaLogo?.getAttribute('viewBox')).toBe('0 86.6 512 338.8');
    expect(nvidiaLogo?.getAttribute('fill')).toBe('currentColor');
    expect(nvidiaLogo?.style.fill).toBe('#000000');
    expect(nvidiaLogo?.querySelectorAll('path')).toHaveLength(1);
    const resourcesTooltip = shadowRoot?.querySelector<HTMLElement>(
      '[data-resources-heading] .validation-failure-info-tooltip'
    );
    expect(resourcesTooltip?.querySelector('svg.validation-failure-info')).not.toBeNull();
    expect(resourcesTooltip?.dataset.tooltip).toBe(
      'Signing in may be required to create an API key.'
    );

    helpButton?.click();
    expect(content?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not apply a late Add credential completion after switching providers', async () => {
    const state = providerActionConfigurationState();
    let resolveCreate!: (response: Record<string, unknown>) => void;
    const pendingCreate = new Promise<Record<string, unknown>>((resolve) => {
      resolveCreate = resolve;
    });
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return state;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-create') return pendingCreate;
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    vi.stubGlobal('prompt', vi.fn(() => 'new-gemini-secret'));
    const addForm = shadowRoot.querySelector<HTMLElement>(
      '[data-add-credential-form]'
    );
    const credentialLabel = shadowRoot.querySelector<HTMLInputElement>(
      '[data-credential-label]'
    );
    addForm?.removeAttribute('hidden');
    if (credentialLabel) credentialLabel.value = 'New Gemini key';
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-add-credential]')
      ?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'credential-create', providerId: 'gemini' })
      )
    );

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    credentialSelect.value = 'nvidia-primary';
    credentialSelect.dispatchEvent(new Event('change'));
    shadowRoot.querySelector<HTMLButtonElement>('[data-add-credential]')?.click();
    const currentAddForm = shadowRoot.querySelector<HTMLElement>(
      '[data-add-credential-form]'
    );
    const currentCredentialLabel = shadowRoot.querySelector<HTMLInputElement>(
      '[data-credential-label]'
    );
    if (currentCredentialLabel) {
      currentCredentialLabel.value = 'NVIDIA key in progress';
    }
    const configurationMessage = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-message]'
    );
    const credentialMessage = shadowRoot.querySelector<HTMLElement>(
      '[data-credential-message]'
    );
    if (configurationMessage) {
      configurationMessage.textContent = 'Current NVIDIA feedback';
      configurationMessage.hidden = false;
    }
    if (credentialMessage) {
      credentialMessage.textContent = 'Current NVIDIA key feedback';
      credentialMessage.hidden = false;
    }
    const configurationStateCalls = sendMessage.mock.calls.filter(
      ([request]) => request.type === 'configuration-state'
    ).length;

    resolveCreate({ credentialId: 'new-gemini-key' });
    await pendingCreate;
    await Promise.resolve();

    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(currentAddForm?.hidden).toBe(false);
    expect(currentCredentialLabel?.value).toBe('NVIDIA key in progress');
    expect(configurationMessage?.textContent).toBe('Current NVIDIA feedback');
    expect(credentialMessage?.textContent).toBe('Current NVIDIA key feedback');
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === 'configuration-state'
      )
    ).toHaveLength(configurationStateCalls);
  });

  it('shows the latest invalid Gemini credential result after provider switching and retries', async () => {
    const baseState = providerActionConfigurationState();
    const initialState = {
      ...baseState,
      credentials: [
        ...baseState.credentials,
        {
          credentialId: 'gemini-backup',
          providerId: 'gemini',
          label: 'Gemini backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    const selectedConfiguration = {
      providerId: 'gemini',
      modelId: 'gemini-model',
      credentialId: 'credential-1',
      providerConfig: {},
    };
    let hasSavedConfiguration = false;
    let validationFailed = false;
    const invalidState = () => ({
      ...initialState,
      activeConfiguration: selectedConfiguration,
      configurationDigest: 'invalid-gemini-digest',
      validation: validationFailed
        ? {
            ...initialState.validation,
            configurationDigest: 'invalid-gemini-digest',
            status: 'INVALID' as const,
            failureCode: 'AUTHENTICATION_FAILED',
          }
        : null,
    });
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') {
        return hasSavedConfiguration ? invalidState() : initialState;
      }
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'configuration-set') {
        hasSavedConfiguration = true;
        return invalidState();
      }
      if (message.type === 'configuration-validate') {
        validationFailed = true;
        return { error: 'Credential invalid.' };
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, credentialSelect } = fixture;
    const saveButton = shadowRoot.querySelector<HTMLButtonElement>(
      '[data-save-validate-configuration]'
    );
    const status = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-status]'
    );
    const message = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-message]'
    );

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));

    saveButton?.click();
    await vi.waitFor(() => {
      expect(message?.textContent).toBe('');
      expect(message?.hidden).toBe(true);
      expect(status?.textContent).toContain('Validation failed');
      expect(status?.textContent).toContain('Credential invalid.');
      expect(status?.textContent).not.toContain('Select a provider');
    });

    saveButton?.click();
    await vi.waitFor(() => {
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === 'configuration-validate'
        )
      ).toHaveLength(2);
      expect(message?.hidden).toBe(true);
      expect(status?.textContent).toContain('Credential invalid.');
      expect(status?.textContent).not.toContain('Select a provider');
    });

    credentialSelect.value = 'gemini-backup';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(message?.hidden).toBe(true);
    expect(status?.textContent).not.toContain('Credential invalid.');
  });

  it('disables the API-key selector when the selected provider has no keys', async () => {
    let state = {
      ...providerActionConfigurationState(),
      credentials: providerActionConfigurationState().credentials.filter(
        (credential) => credential.providerId === NVIDIA_PROVIDER_ID
      ),
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return state;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-create') {
        state = {
          ...state,
          credentials: [
            ...state.credentials,
            {
              credentialId: 'gemini-added',
              providerId: 'gemini',
              label: 'Added Gemini key',
              createdAt: '2026-09-12T00:00:00.000Z',
              updatedAt: '2026-09-12T00:00:00.000Z',
            },
          ],
        };
        return {};
      }
      if (message.type === 'credential-delete-selected') {
        state = {
          ...state,
          credentials: state.credentials.filter(
            (credential) => credential.credentialId !== message.credentialId
          ),
        };
        return {};
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, credentialSelect } = fixture;
    const credentialStatus = shadowRoot.querySelector<HTMLElement>(
      '[data-credential-status]'
    );
    const addCredentialButton = shadowRoot.querySelector<HTMLButtonElement>(
      '[data-add-credential]'
    );

    expect(credentialStatus?.parentElement?.classList.contains('credential-heading-row')).toBe(true);
    expect(credentialStatus?.parentElement?.querySelector('#credential-heading')?.textContent).toBe('API Keys');
    expect(credentialStatus?.textContent).toBe('1 API key stored.');
    expect(credentialStatus?.title).toBe('');
    expect(credentialStatus?.dataset.tooltip).toBe(
      'Gemini keys: 0\nNVIDIA keys: 1'
    );
    expect(credentialSelect.disabled).toBe(true);
    expect(credentialSelect.options[0]?.textContent).toBe('No API keys added yet');

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(addCredentialButton?.textContent).toBe('Add NVIDIA API key');
    expect(credentialSelect.disabled).toBe(false);
    expect(credentialSelect.value).toBe('nvidia-primary');

    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));
    expect(addCredentialButton?.textContent).toBe('Add Gemini API key');
    expect(credentialSelect.disabled).toBe(true);

    vi.stubGlobal('prompt', vi.fn(() => 'new-gemini-secret'));
    shadowRoot.querySelector<HTMLButtonElement>('[data-add-credential]')?.click();
    const credentialLabel = shadowRoot.querySelector<HTMLInputElement>(
      '[data-credential-label]'
    );
    if (credentialLabel) credentialLabel.value = 'Added Gemini key';
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-add-credential]')
      ?.click();
    await vi.waitFor(() => {
      expect(credentialSelect.disabled).toBe(false);
      expect(credentialSelect.value).toBe('gemini-added');
      expect(credentialStatus?.dataset.tooltip).toBe(
        'Gemini keys: 1\nNVIDIA keys: 1'
      );
    });

    shadowRoot.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    shadowRoot.querySelector<HTMLButtonElement>('[data-confirm-delete]')?.click();
    await vi.waitFor(() => expect(credentialSelect.disabled).toBe(true));
    expect(credentialSelect.options[0]?.textContent).toBe('No API keys added yet');
    expect(credentialStatus?.dataset.tooltip).toBe(
      'Gemini keys: 0\nNVIDIA keys: 1'
    );
  });

  it('keeps NVIDIA selected after successfully adding an NVIDIA key', async () => {
    let currentConfigurationState = {
      ...providerActionConfigurationState(),
      credentials: [
        ...providerActionConfigurationState().credentials,
        {
          credentialId: 'nvidia-backup',
          providerId: NVIDIA_PROVIDER_ID,
          label: 'NVIDIA backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return currentConfigurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-create') {
        currentConfigurationState = {
          ...currentConfigurationState,
          credentials: [
            ...currentConfigurationState.credentials,
            {
              credentialId: 'nvidia-added',
              providerId: message.providerId ?? NVIDIA_PROVIDER_ID,
              label: 'Added NVIDIA key',
              createdAt: '2026-09-12T00:00:00.000Z',
              updatedAt: '2026-09-12T00:00:00.000Z',
            },
          ],
        };
        return { credentialId: 'nvidia-added' };
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('nvidia-primary');
    vi.stubGlobal('prompt', vi.fn(() => 'new-nvidia-secret'));
    shadowRoot.querySelector<HTMLButtonElement>('[data-add-credential]')?.click();
    const keyLabel = shadowRoot.querySelector<HTMLInputElement>(
      '[data-credential-label]'
    );
    if (keyLabel) keyLabel.value = 'Added NVIDIA key';
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-add-credential]')
      ?.click();

    await vi.waitFor(() =>
      expect(
        shadowRoot.querySelector<HTMLElement>('[data-credential-message]')
          ?.textContent
      ).toBe('API key added.')
    );
    const credentialMessage = shadowRoot.querySelector<HTMLElement>(
      '[data-credential-message]'
    );
    expect(credentialMessage?.hidden).toBe(false);
    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-primary',
      'nvidia-backup',
      'nvidia-added',
    ]);
    await vi.waitFor(
      () => expect(credentialMessage?.hidden).toBe(true),
      { timeout: 2500, interval: 25 }
    );
    expect(credentialMessage?.textContent).toBe('');
  });

  it('does not apply a late Replace completion or save another provider', async () => {
    const state = providerActionConfigurationState();
    let resolveReplace!: (response: Record<string, unknown>) => void;
    const pendingReplace = new Promise<Record<string, unknown>>((resolve) => {
      resolveReplace = resolve;
    });
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return state;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-replace') return pendingReplace;
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    vi.stubGlobal('prompt', vi.fn(() => 'replacement-secret'));
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-replace-credential]')
      ?.click();
    const replaceSelection = shadowRoot.querySelector<HTMLSelectElement>(
      '[data-replace-credential-select]'
    );
    if (replaceSelection) replaceSelection.value = 'credential-1';
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-replace-credential]')
      ?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'credential-replace',
          providerId: 'gemini',
          credentialId: 'credential-1',
        })
      )
    );

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    credentialSelect.value = 'nvidia-primary';
    credentialSelect.dispatchEvent(new Event('change'));
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-replace-credential]')
      ?.click();
    const currentReplaceForm = shadowRoot.querySelector<HTMLElement>(
      '[data-replace-credential-form]'
    );
    const currentReplaceSelection = shadowRoot.querySelector<HTMLSelectElement>(
      '[data-replace-credential-select]'
    );
    if (currentReplaceSelection) {
      currentReplaceSelection.value = 'nvidia-primary';
    }
    const credentialMessage = shadowRoot.querySelector<HTMLElement>(
      '[data-credential-message]'
    );
    if (credentialMessage) {
      credentialMessage.textContent = 'Current NVIDIA key feedback';
      credentialMessage.hidden = false;
    }
    const configurationStateCalls = sendMessage.mock.calls.filter(
      ([request]) => request.type === 'configuration-state'
    ).length;

    resolveReplace({ credentialId: 'replacement-gemini-key' });
    await pendingReplace;
    await Promise.resolve();

    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(currentReplaceForm?.hidden).toBe(false);
    expect(currentReplaceSelection?.value).toBe('nvidia-primary');
    expect(credentialMessage?.textContent).toBe('Current NVIDIA key feedback');
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-set')
    ).toHaveLength(0);
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === 'configuration-state'
      )
    ).toHaveLength(configurationStateCalls);
  });

  it('does not reload or report a late Delete completion after switching providers', async () => {
    const state = providerActionConfigurationState();
    let resolveDelete!: (response: Record<string, unknown>) => void;
    const pendingDelete = new Promise<Record<string, unknown>>((resolve) => {
      resolveDelete = resolve;
    });
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return state;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-delete-selected') return pendingDelete;
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    credentialSelect.value = 'credential-1';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(
        sendMessage.mock.calls.some(
          ([request]) =>
            request.type === 'configuration-state' && request.selectedConfiguration
        )
      ).toBe(true)
    );
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-delete-credential]')
      ?.click();
    shadowRoot.querySelector<HTMLButtonElement>('[data-confirm-delete]')?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'credential-delete-selected',
        credentialId: 'credential-1',
      })
    );

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    credentialSelect.value = 'nvidia-primary';
    credentialSelect.dispatchEvent(new Event('change'));
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-delete-credential]')
      ?.click();
    const deleteConfirmation = shadowRoot.querySelector<HTMLElement>(
      '[data-delete-confirmation]'
    );
    const configurationMessage = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-message]'
    );
    if (configurationMessage) {
      configurationMessage.textContent = 'Current NVIDIA feedback';
      configurationMessage.hidden = false;
    }
    const configurationStateCalls = sendMessage.mock.calls.filter(
      ([request]) => request.type === 'configuration-state'
    ).length;

    resolveDelete({ deleted: true });
    await pendingDelete;
    await Promise.resolve();

    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(deleteConfirmation?.hidden).toBe(false);
    expect(configurationMessage?.textContent).toBe('Current NVIDIA feedback');
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === 'configuration-state'
      )
    ).toHaveLength(configurationStateCalls);
  });

  it('keeps NVIDIA selected when deleting a key and chooses a same-provider replacement', async () => {
    let currentConfigurationState = {
      ...providerActionConfigurationState(),
      credentials: [
        ...providerActionConfigurationState().credentials,
        {
          credentialId: 'nvidia-backup',
          providerId: NVIDIA_PROVIDER_ID,
          label: 'NVIDIA backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return currentConfigurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-delete-selected') {
        currentConfigurationState = {
          ...currentConfigurationState,
          credentials: currentConfigurationState.credentials.filter(
            (credential) => credential.credentialId !== message.credentialId
          ),
        };
        return { deleted: true };
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('nvidia-primary');
    shadowRoot.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    shadowRoot.querySelector<HTMLButtonElement>('[data-confirm-delete]')?.click();

    await vi.waitFor(() =>
      expect(
        shadowRoot.querySelector<HTMLElement>('[data-configuration-message]')
          ?.textContent
      ).toBe('API key deleted.')
    );
    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-backup');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-backup',
    ]);

    shadowRoot.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    shadowRoot.querySelector<HTMLButtonElement>('[data-confirm-delete]')?.click();
    await vi.waitFor(() =>
      expect(credentialSelect.options[0]?.textContent).toBe(
        'No API keys added yet'
      )
    );
    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('');
    expect(credentialSelect.options).toHaveLength(1);
    expect(credentialSelect.options[0]?.textContent).toBe('No API keys added yet');
  });

  it('keeps NVIDIA selected when replacing a non-active NVIDIA key', async () => {
    let currentConfigurationState = {
      ...providerActionConfigurationState(),
      credentials: [
        ...providerActionConfigurationState().credentials,
        {
          credentialId: 'nvidia-backup',
          providerId: NVIDIA_PROVIDER_ID,
          label: 'NVIDIA backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return currentConfigurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'credential-replace') {
        currentConfigurationState = {
          ...currentConfigurationState,
          credentials: [
            ...currentConfigurationState.credentials.filter(
              (credential) => credential.credentialId !== 'nvidia-backup'
            ),
            {
              credentialId: 'nvidia-replaced',
              providerId: NVIDIA_PROVIDER_ID,
              label: 'NVIDIA backup',
              createdAt: '2026-09-12T00:00:00.000Z',
              updatedAt: '2026-09-12T00:00:00.000Z',
            },
          ],
        };
        return { credentialId: 'nvidia-replaced' };
      }
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, modelSelect, credentialSelect } = fixture;

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('nvidia-primary');
    shadowRoot.querySelector<HTMLButtonElement>('[data-replace-credential]')?.click();
    const replaceSelect = shadowRoot.querySelector<HTMLSelectElement>(
      '[data-replace-credential-select]'
    );
    if (replaceSelect) replaceSelect.value = 'nvidia-backup';
    vi.stubGlobal('prompt', vi.fn(() => 'replacement-secret'));
    shadowRoot
      .querySelector<HTMLButtonElement>('[data-save-replace-credential]')
      ?.click();

    await vi.waitFor(() =>
      expect(
        shadowRoot.querySelector<HTMLElement>('[data-credential-message]')
          ?.textContent
      ).toBe('API key replaced.')
    );
    expect(providerSelect.value).toBe(NVIDIA_PROVIDER_ID);
    expect(modelSelect.value).toBe(NVIDIA_MODEL);
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-primary',
      'nvidia-replaced',
    ]);
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-set')
    ).toHaveLength(0);
  });

  it('shows the no-keys message as a placeholder, not a dropdown choice', async () => {
    let currentConfigurationState: TestConfigurationState = {
      ...configurationState,
      credentials: [],
      activeConfiguration: null,
      configurationDigest: null,
      validation: null,
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return currentConfigurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { credentialSelect } = fixture;

    expect(credentialSelect.options).toHaveLength(1);
    expect(credentialSelect.options[0]?.textContent).toBe('No API keys added yet');
    expect(credentialSelect.options[0]?.disabled).toBe(true);
    expect(credentialSelect.options[0]?.hidden).toBe(true);
    expect(credentialSelect.value).toBe('');

    currentConfigurationState = {
      ...currentConfigurationState,
      credentials: [
        {
          credentialId: 'gemini-new-key',
          providerId: 'gemini',
          label: 'Gemini key',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    await fixture.handle.refresh();

    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'gemini-new-key',
    ]);
    expect(credentialSelect.options[0]?.textContent).toBe('Gemini key');
    expect(credentialSelect.options[0]?.disabled).toBe(false);
    expect(credentialSelect.options[0]?.hidden).toBe(false);
    expect(credentialSelect.value).toBe('gemini-new-key');
  });

  it('selects the first provider key by default and restores remembered keys', async () => {
    const state = {
      ...providerActionConfigurationState(),
      credentials: [
        ...providerActionConfigurationState().credentials,
        {
          credentialId: 'gemini-backup',
          providerId: 'gemini',
          label: 'Gemini backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
      activeConfiguration: null,
      configurationDigest: null,
      validation: null,
    };
    const sendMessage = vi.fn(async (message: ProviderActionMessage) => {
      if (message.type === 'configuration-state') return state;
      if (message.type === 'p7-discover') return createSnapshot();
      return {};
    });
    const fixture = await mountProviderActionOverlay(sendMessage);
    overlay = fixture.handle;
    const { shadowRoot, providerSelect, credentialSelect } = fixture;
    const primaryAction = shadowRoot.querySelector<HTMLButtonElement>(
      '[data-primary-action]'
    );
    const configurationStatus = shadowRoot.querySelector<HTMLElement>(
      '[data-configuration-status]'
    );

    expect(providerSelect.value).toBe('gemini');
    expect(credentialSelect.value).toBe('credential-1');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'credential-1',
      'gemini-backup',
    ]);
    expect(primaryAction?.disabled).toBe(true);

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-primary',
    ]);
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);

    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('credential-1');
    credentialSelect.value = 'gemini-backup';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(primaryAction?.disabled).toBe(true);

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('nvidia-primary');
    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));
    expect(credentialSelect.value).toBe('gemini-backup');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);
    expect(
      sendMessage.mock.calls.filter(
        ([request]) =>
          request.type === 'configuration-state' && request.selectedConfiguration
      )
    ).toHaveLength(0);
  });

  it('preserves provider keys and ignores stale NVIDIA validation after a selection change', async () => {
    const multiProviderState = {
      ...configurationState,
      providers: [
        {
          providerId: 'gemini',
          displayName: 'Gemini',
          models: [
            { modelId: 'gemini-model', displayName: 'Gemini model' },
            { modelId: 'gemini-alt', displayName: 'Gemini alternate' },
          ],
          supportsValidation: true,
        },
        {
          providerId: NVIDIA_PROVIDER_ID,
          displayName: 'NVIDIA',
          models: [
            { modelId: NVIDIA_MODEL, displayName: 'NVIDIA Nemotron 3 Super' },
            { modelId: NVIDIA_GPT_OSS_MODEL, displayName: 'OpenAI GPT-OSS 20B' },
          ],
          supportsValidation: true,
        },
      ],
      credentials: [
        ...configurationState.credentials,
        {
          credentialId: 'gemini-backup',
          providerId: 'gemini',
          label: 'Gemini backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
        {
          credentialId: 'nvidia-primary',
          providerId: NVIDIA_PROVIDER_ID,
          label: 'NVIDIA primary',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
        {
          credentialId: 'nvidia-backup',
          providerId: NVIDIA_PROVIDER_ID,
          label: 'NVIDIA backup',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
      activeConfiguration: {
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'gemini-backup',
        providerConfig: {},
      },
      configurationDigest: 'active-gemini-digest',
      validation: {
        configurationDigest: 'active-gemini-digest',
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'gemini-backup',
        status: 'VALID' as const,
        validatedAt: '2026-09-12T00:00:00.000Z',
      },
    };
    type MutableMultiProviderState = Omit<
      typeof multiProviderState,
      'activeConfiguration' | 'configurationDigest' | 'validation'
    > & {
      activeConfiguration: typeof multiProviderState.activeConfiguration | null;
      configurationDigest: string | null;
      validation: typeof multiProviderState.validation | null;
    };
    let currentConfigurationState: MutableMultiProviderState = multiProviderState;
    let deferSelectedValidation = false;
    let deferNvidiaValidation = false;
    const pendingValidationResolvers: {
      selected?: () => void;
      nvidia?: () => void;
    } = {};
    const sendMessage = vi.fn(async (message: {
      type?: string;
      providerId?: string;
      modelId?: string;
      credentialId?: string;
      selectedConfiguration?: {
        providerId: string;
        modelId: string;
        credentialId: string;
      };
    }) => {
      if (message.type === 'configuration-state') {
        if (!message.selectedConfiguration) return currentConfigurationState;
        if (
          deferSelectedValidation &&
          message.selectedConfiguration.providerId === 'gemini'
        ) {
          deferSelectedValidation = false;
          return new Promise<Record<string, unknown>>((resolve) => {
            pendingValidationResolvers.selected = () =>
              resolve({
                ...currentConfigurationState,
                selectedConfiguration: {
                  ...message.selectedConfiguration,
                  providerConfig: {},
                },
                selectedConfigurationDigest: 'stale-gemini-digest',
                selectedValidation: {
                  ...multiProviderState.validation,
                  configurationDigest: 'stale-gemini-digest',
                  credentialId: message.selectedConfiguration?.credentialId,
                },
              });
          });
        }
        return {
          ...currentConfigurationState,
          selectedConfiguration: {
            ...message.selectedConfiguration,
            providerConfig: {},
          },
          selectedConfigurationDigest: 'draft-digest',
          selectedValidation: null,
        };
      }
      if (message.type === 'configuration-set') {
        const nextActiveConfiguration = {
          providerId: message.providerId ?? '',
          modelId: message.modelId ?? '',
          credentialId: message.credentialId ?? '',
          providerConfig: {},
        };
        const nextDigest = `active-${message.providerId}-digest`;
        const configurationUnchanged =
          currentConfigurationState.activeConfiguration?.providerId ===
            nextActiveConfiguration.providerId &&
          currentConfigurationState.activeConfiguration.modelId ===
            nextActiveConfiguration.modelId &&
          currentConfigurationState.activeConfiguration.credentialId ===
            nextActiveConfiguration.credentialId &&
          currentConfigurationState.configurationDigest === nextDigest;
        currentConfigurationState = {
          ...currentConfigurationState,
          activeConfiguration: nextActiveConfiguration,
          configurationDigest: nextDigest,
          validation: configurationUnchanged
            ? currentConfigurationState.validation
            : null,
        };
        return currentConfigurationState;
      }
      if (message.type === 'configuration-validate') {
        if (
          currentConfigurationState.activeConfiguration?.providerId ===
            NVIDIA_PROVIDER_ID &&
          deferNvidiaValidation
        ) {
          deferNvidiaValidation = false;
          return new Promise<Record<string, unknown>>((resolve) => {
            pendingValidationResolvers.nvidia = () => {
              const activeConfiguration =
                currentConfigurationState.activeConfiguration;
              if (activeConfiguration) {
                currentConfigurationState = {
                  ...currentConfigurationState,
                  validation: {
                    configurationDigest:
                      currentConfigurationState.configurationDigest ?? '',
                    providerId: activeConfiguration.providerId,
                    modelId: activeConfiguration.modelId,
                    credentialId: activeConfiguration.credentialId,
                    status: 'VALID',
                    validatedAt: '2026-09-12T00:00:00.000Z',
                  },
                };
              }
              resolve({ valid: true });
            };
          });
        }
        const activeConfiguration = currentConfigurationState.activeConfiguration;
        if (activeConfiguration) {
          currentConfigurationState = {
            ...currentConfigurationState,
            validation: {
              configurationDigest:
                currentConfigurationState.configurationDigest ?? '',
              providerId: activeConfiguration.providerId,
              modelId: activeConfiguration.modelId,
              credentialId: activeConfiguration.credentialId,
              status: 'VALID',
              validatedAt: '2026-09-12T00:00:00.000Z',
            },
          };
        }
        return { valid: true };
      }
      if (message.type === 'p7-discover') return createSnapshot();
      return {};
    });

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    });
    vi.stubGlobal('Option', function (label: string, value: string) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      return option;
    });

    overlay = await mountOverlay();
    await overlay.refresh();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const providerSelect = shadowRoot?.querySelector<HTMLSelectElement>(
      '[data-provider-select]'
    );
    const modelSelect = shadowRoot?.querySelector<HTMLSelectElement>(
      '[data-model-select]'
    );
    const credentialSelect = shadowRoot?.querySelector<HTMLSelectElement>(
      '[data-credential-select]'
    );
    const primaryAction = shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-primary-action]'
    );
    if (!providerSelect || !modelSelect || !credentialSelect) {
      throw new Error('Provider configuration controls missing.');
    }

    expect(Array.from(providerSelect.options, (option) => option.value)).toEqual([
      'gemini',
      NVIDIA_PROVIDER_ID,
    ]);
    expect(providerSelect.value).toBe('gemini');
    expect(modelSelect.value).toBe('gemini-model');
    expect(credentialSelect.value).toBe('gemini-backup');

    deferSelectedValidation = true;
    credentialSelect.value = 'credential-1';
    credentialSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(pendingValidationResolvers.selected).toBeTypeOf('function')
    );

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    expect(Array.from(modelSelect.options, (option) => option.value)).toEqual([
      NVIDIA_MODEL,
      NVIDIA_GPT_OSS_MODEL,
    ]);
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-primary',
      'nvidia-backup',
    ]);
    expect(
      Array.from(credentialSelect.options).every((option) => !option.disabled)
    ).toBe(true);
    expect(
      Array.from(credentialSelect.options).map((option) => option.value)
    ).not.toContain('credential-1');
    const configurationStatus = shadowRoot?.querySelector<HTMLElement>(
      '[data-configuration-status]'
    );
    const configurationMessage = shadowRoot?.querySelector<HTMLElement>(
      '[data-configuration-message]'
    );
    const credentialMessage = shadowRoot?.querySelector<HTMLElement>(
      '[data-credential-message]'
    );
    const addCredentialForm = shadowRoot?.querySelector<HTMLElement>(
      '[data-add-credential-form]'
    );
    const credentialLabel = shadowRoot?.querySelector<HTMLInputElement>(
      '[data-credential-label]'
    );
    const saveButton = shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-save-validate-configuration]'
    );
    expect(configurationStatus?.textContent).toContain('Select a provider');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(credentialSelect.value).toBe('nvidia-primary');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'nvidia-primary',
      'nvidia-backup',
    ]);
    expect(saveButton?.disabled).toBe(false);
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === 'configuration-state' && request.selectedConfiguration
      )
    ).toHaveLength(1);

    modelSelect.value = NVIDIA_GPT_OSS_MODEL;
    modelSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_GPT_OSS_MODEL));
    credentialSelect.value = 'nvidia-backup';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === 'configuration-state' && request.selectedConfiguration
      )
    ).toHaveLength(1);

    addCredentialForm?.removeAttribute('hidden');
    if (credentialLabel) credentialLabel.value = 'temporary NVIDIA label';
    if (configurationMessage) {
      configurationMessage.textContent = 'Validation failed';
      configurationMessage.hidden = false;
    }
    if (credentialMessage) {
      credentialMessage.textContent = 'API key could not be added.';
      credentialMessage.hidden = false;
    }

    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe('gemini-model'));
    expect(credentialSelect.value).toBe('credential-1');
    expect(Array.from(credentialSelect.options, (option) => option.value)).toEqual([
      'credential-1',
      'gemini-backup',
    ]);
    expect(
      Array.from(credentialSelect.options).every((option) => !option.disabled)
    ).toBe(true);
    expect(configurationStatus?.textContent).toContain('Select a provider');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(configurationMessage?.textContent).toBe('');
    expect(configurationMessage?.hidden).toBe(true);
    expect(credentialMessage?.textContent).toBe('');
    expect(credentialMessage?.hidden).toBe(true);
    expect(addCredentialForm?.hidden).toBe(true);
    expect(credentialLabel?.value).toBe('');

    credentialSelect.value = 'credential-1';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(primaryAction?.disabled).toBe(true);
    pendingValidationResolvers.selected?.();
    await vi.waitFor(() =>
      expect(configurationStatus?.textContent).toContain('Select a provider')
    );
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);

    credentialSelect.value = 'gemini-backup';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(configurationStatus?.textContent).toContain('Select a provider');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-validate')
    ).toHaveLength(0);
    saveButton?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'configuration-set',
        providerId: 'gemini',
        modelId: 'gemini-model',
        credentialId: 'gemini-backup',
      })
    );
    await vi.waitFor(() =>
      expect(configurationStatus?.textContent).toMatch(/^Status: Valid · \d+ ms$/u)
    );
    expect(primaryAction?.disabled).toBe(false);
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-validate')
    ).toHaveLength(1);

    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    expect(credentialSelect.value).toBe('nvidia-backup');
    expect(saveButton?.disabled).toBe(false);
    expect(configurationStatus?.textContent).toContain('Select a provider');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);
    expect(
      currentConfigurationState.credentials.map((credential) => credential.credentialId)
    ).toEqual([
      'credential-1',
      'gemini-backup',
      'nvidia-primary',
      'nvidia-backup',
    ]);
    credentialSelect.value = 'nvidia-primary';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(saveButton?.disabled).toBe(false);
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    deferNvidiaValidation = true;
    saveButton?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'configuration-set',
        providerId: NVIDIA_PROVIDER_ID,
        modelId: NVIDIA_MODEL,
        credentialId: 'nvidia-primary',
      })
    );
    await vi.waitFor(() =>
      expect(pendingValidationResolvers.nvidia).toBeTypeOf('function')
    );
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-validate')
    ).toHaveLength(2);

    providerSelect.value = 'gemini';
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe('gemini-model'));
    expect(credentialSelect.value).toBe('gemini-backup');
    expect(configurationStatus?.textContent).not.toBe('VALIDATING');
    expect(primaryAction?.disabled).toBe(true);
    credentialSelect.value = 'credential-1';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(saveButton?.disabled).toBe(false);
    expect(configurationStatus?.textContent).not.toBe('VALIDATING');
    pendingValidationResolvers.nvidia?.();
    await vi.waitFor(() =>
      expect(configurationStatus?.textContent).toContain('Select a provider')
    );
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);
    expect(configurationMessage?.hidden).toBe(true);
    expect(currentConfigurationState.credentials).toContainEqual(
      expect.objectContaining({
        credentialId: 'nvidia-primary',
        providerId: NVIDIA_PROVIDER_ID,
      })
    );
    expect(currentConfigurationState.validation).toMatchObject({
      providerId: NVIDIA_PROVIDER_ID,
      status: 'VALID',
    });
    currentConfigurationState = {
      ...currentConfigurationState,
      validation: null,
    };
    providerSelect.value = NVIDIA_PROVIDER_ID;
    providerSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(modelSelect.value).toBe(NVIDIA_MODEL));
    credentialSelect.value = 'nvidia-primary';
    credentialSelect.dispatchEvent(new Event('change'));
    expect(configurationStatus?.textContent).toContain('Select a provider');
    expect(configurationStatus?.textContent).not.toContain('Status: Valid');
    expect(primaryAction?.disabled).toBe(true);
    saveButton?.click();
    await vi.waitFor(() =>
      expect(configurationStatus?.textContent).toBe('Status: Valid')
    );
    expect(
      sendMessage.mock.calls.filter(([request]) => request.type === 'configuration-validate')
    ).toHaveLength(3);
    expect(primaryAction?.disabled).toBe(false);
  });

});
