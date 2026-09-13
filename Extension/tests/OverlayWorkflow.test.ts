import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountOverlay, type OverlayHandle } from '../src/Overlay/Overlay';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { waitForInitialDiscovery } from '../src/Content/Navigation';

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

type TestConfigurationState = Omit<typeof configurationState, 'validation'> & {
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

describe('live Overlay generation workflow', () => {
  let overlay: OverlayHandle | null = null;

  afterEach(() => {
    overlay?.close();
    overlay = null;
    document.documentElement.replaceChildren(document.head, document.body);
    vi.unstubAllGlobals();
  });

  it('keeps configuration collapsed until opened and preserves its controls', async () => {
    let currentConfigurationState: TestConfigurationState = {
      ...configurationState,
      validation: null,
    };
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return currentConfigurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'configuration-set') return currentConfigurationState;
      if (message.type === 'credential-delete-selected') return {};
      if (message.type === 'configuration-validate') {
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
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
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
    expect(guidance?.tagName).toBe('P');
    expect(guidance?.closest('button')).toBeNull();
    const overlayStyles = readFileSync(
      resolve(process.cwd(), 'src/Overlay/Overlay.css'),
      'utf8'
    );
    expect(overlayStyles).toContain('font-size: 11px;');
    expect(overlayStyles).toContain('color: #4b5563;');
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
      '[data-save-configuration]',
      '[data-delete-credential]',
      '[data-credential-status]',
      '[data-validation-status]',
      '[data-validate-configuration]',
      '[data-validation-message]',
    ]) {
      expect(content?.querySelector(selector)).not.toBeNull();
    }

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

    content?.querySelector<HTMLButtonElement>('[data-save-configuration]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'configuration-set' })
      );
    });
    content?.querySelector<HTMLButtonElement>('[data-delete-credential]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'credential-delete-selected',
        credentialId: 'credential-1',
      });
    });
    content?.querySelector<HTMLButtonElement>('[data-validate-configuration]')?.click();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: 'configuration-validate' });
    });
    await vi.waitFor(() => {
      expect(guidance?.textContent?.trim()).toBe(
        'Configuration is valid. Generate is available on a supported page.'
      );
    });
    toggle?.click();
    expect(content?.hidden).toBe(true);
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('►');
    expect(guidance?.textContent?.trim()).toBe(
      'Configuration is valid. Generate is available on a supported page.'
    );
    expect(shadowRoot?.querySelector('[data-primary-action]')).not.toBeNull();
    expect(shadowRoot?.querySelector('[data-force-clear]')).not.toBeNull();
    toggle?.click();
    expect(content?.hidden).toBe(false);
    expect(shadowRoot?.querySelector('[data-configuration-toggle-icon]')?.textContent).toBe('▼');
  });

  it('generates once and removes the obsolete primary action in the real Shadow DOM workflow', async () => {
    let generationCount = 0;
    const pendingGeneration = new Promise<typeof generationResult>((resolve) => {
      resolveGeneration = resolve;
    });
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
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

    primary()?.click();
    await vi.waitFor(() => {
      expect(primary()?.textContent).toBe('Generating...');
      expect(status()?.textContent).toBe('Generating answers...');
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
      expect(shadowRoot?.querySelector('.overlay-panel')?.classList.contains('is-generating')).toBe(true);
      expect(shadowRoot?.querySelector('style')).not.toBeNull();
      expect(readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8')).toContain(
        'animation: overlay-border-gradient 0.7s linear infinite'
      );
    });
    resolveGeneration(generationResult);
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(primary()).toBeNull();
      expect(forceClear()?.hidden).toBe(true);
      expect(forceClearDisplay()).toBe('none');
      expect(shadowRoot?.querySelector('.overlay-panel')?.classList.contains('is-generating')).toBe(false);
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
      expect(overlayStyles).toContain('margin: 4px;');
      expect(overlayStyles).toContain('padding: 6px;');
      expect(overlayStyles).toContain('border: 2px solid #9ca3af;');
      expect(overlayStyles).toContain('background: #f8fafc;');
      expect(overlayStyles).toContain('font-size: 12.5px;');
      expect(overlayStyles).toContain('opacity: 0.95;');
      const visibleOverrideActions = [...(shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-override-action]') ?? [])]
        .filter((button) => !button.hidden);
      expect(visibleOverrideActions).toHaveLength(1);
      expect(visibleOverrideActions[0]?.textContent?.trim()).toBe('Override Filled Answer(s)');
      expect(forceClear()?.tagName).toBe('BUTTON');
      expect(forceClear()?.textContent?.trim()).toBe('Force Unsettle All');
      expect(forceClear()?.hidden).toBe(false);
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
      expect(shadowRoot?.querySelector('button[data-filled-status]')).toBeNull();
      const forceClear = shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]');
      expect(forceClear?.tagName).toBe('BUTTON');
      expect(forceClear?.textContent?.trim()).toBe('Force Unsettle All');
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
        return {
          report: { cycleId: 'cycle-zero-skipped', status: 'complete' as const, results: [] },
          fillReport: {
            cycleId: 'cycle-zero-skipped',
            outcomes: [{ questionId: 'unanswered', status: 'SKIPPED' as const }],
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
      expect(shadowRoot?.querySelector<HTMLElement>('.result-summary')?.textContent).toBe(
        '0 filled · 0 already filled · 0 failed · 1 skipped'
      );
      expect(overrideAction()?.hidden).toBe(false);
    });
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
      expect(shadowRoot?.querySelector('.result-note')).toBeNull();
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

    await vi.waitFor(() => expect(primary()?.hidden).toBe(false));
    primary()?.click();
    await vi.waitFor(() => expect(overrideAction()?.hidden).toBe(false));
    overrideAction()?.click();
    shadowRoot?.querySelector<HTMLButtonElement>('[data-override-specific]')?.click();
    expect(
      shadowRoot?.querySelectorAll('[data-override-specific-list] input')
    ).toHaveLength(4);
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
    expect(candidateLabels?.[1]?.textContent).toBe('Q2 — Question 2');
  });

});
