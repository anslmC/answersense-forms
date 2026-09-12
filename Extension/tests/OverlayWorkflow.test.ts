import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountOverlay, type OverlayHandle } from '../src/Overlay/Overlay';

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

describe('live Overlay generation workflow', () => {
  let overlay: OverlayHandle | null = null;

  afterEach(() => {
    overlay?.close();
    overlay = null;
    document.documentElement.replaceChildren(document.head, document.body);
    vi.unstubAllGlobals();
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

    await vi.waitFor(() => {
      expect(primary()?.hidden).toBe(false);
      expect(primary()?.textContent).toBe('Generate & Auto-Fill');
    });

    primary()?.click();
    await vi.waitFor(() => {
      expect(primary()?.textContent).toBe('Generating...');
      expect(status()?.textContent).toBe('Generating answers...');
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
      expect(shadowRoot?.querySelector('.overlay-panel')?.classList.contains('is-generating')).toBe(false);
      expect(resultSummary()?.hidden).not.toBe(true);
      expect(resultSummary()?.textContent).toBe('4 filled · 0 failed · 0 skipped');
      expect(overrideAction()?.hidden).toBe(false);
      expect(overrideAction()?.textContent?.trim()).toBe('Override Filled Answer(s)');
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

    shadowRoot?.querySelector<HTMLButtonElement>('[data-force-clear]')?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Ready to generate');
      expect(primary()?.textContent).toBe('Generate & Auto-Fill');
      expect(primary()?.hidden).toBe(false);
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'p7-force-clear' });

    primary()?.click();
    await vi.waitFor(() => {
      expect(status()?.textContent).toBe('Review answers');
      expect(primary()).toBeNull();
    });
    expect(generationCount).toBe(3);
  });

  it('renders reused answers as a non-interactive settled status', async () => {
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'configuration-state') return configurationState;
      if (message.type === 'p7-discover') return createSnapshot();
      if (message.type === 'p7-generate') {
        return { status: 'reused' as const, pageId: 'page-1' };
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
    const settledStatus = () => shadowRoot?.querySelector<HTMLElement>('[data-filled-status]');

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
    });
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

});
