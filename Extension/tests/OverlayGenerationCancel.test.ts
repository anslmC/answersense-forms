import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function createSnapshot() {
  return {
    supported: true,
    uiState: 'READY' as const,
    page: { pageId: 'page-1', questionCount: 4 },
    lifecycle: {
      activePage: {
        form: {
          questions: [
            'question-1',
            'question-2',
            'question-3',
            'question-4',
          ].map((id, index) => ({
            id,
            text: `Question ${index + 1}`,
            type: 'short-text',
            supported: true,
            existingInput: { hasValue: false },
          })),
        },
      },
    },
    result: null,
    error: null,
  };
}

interface DeferredGeneration {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let overlay: OverlayHandle | null = null;
let pendingGenerations: DeferredGeneration[] = [];
let sendMessage: ReturnType<typeof vi.fn>;
let addListener: ReturnType<typeof vi.fn>;

function installChrome(): void {
  pendingGenerations = [];
  sendMessage = vi.fn(async (message: { type?: string }) => {
    if (message.type === 'configuration-state') return configurationState;
    if (message.type === 'p7-discover') return createSnapshot();
    if (message.type === 'p7-generate') {
      return new Promise((resolve, reject) => {
        pendingGenerations.push({ resolve, reject });
      });
    }
    if (message.type === 'p7-cancel-generation') return { status: 'canceled' };
    return {};
  });
  addListener = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    runtime: { sendMessage, onMessage: { addListener } },
  });
  vi.stubGlobal('Option', function (label: string, value: string) {
    const option = document.createElement('option');
    option.textContent = label;
    option.value = value;
    return option;
  });
}

function shadowRoot(): ShadowRoot {
  const root = document.querySelector('#answersense-overlay-host')?.shadowRoot;
  if (!root) throw new Error('Overlay shadow root missing.');
  return root;
}

const status = () => shadowRoot().querySelector<HTMLElement>('[data-status]');
const primary = () =>
  shadowRoot().querySelector<HTMLButtonElement>('[data-primary-action]');
const cancelButton = () =>
  shadowRoot().querySelector<HTMLButtonElement>('[data-generation-cancel]');
const progressText = () =>
  shadowRoot().querySelector<HTMLElement>('[data-workflow-progress-text]');
const announcement = () =>
  shadowRoot().querySelector<HTMLElement>(
    '[data-generation-cancel-announcement]'
  );

async function mount(): Promise<void> {
  overlay = await mountOverlay();
  await vi.advanceTimersByTimeAsync(0);
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

async function startGeneration(): Promise<void> {
  primary()?.click();
  await flush();
}

async function settleGenerationWith(value: unknown): Promise<void> {
  pendingGenerations.at(-1)?.resolve(value);
  await flush();
}

describe('overlay generation warning and cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installChrome();
  });

  afterEach(() => {
    overlay?.close();
    overlay = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    document.documentElement.replaceChildren(document.head, document.body);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the existing loading UI immediately after generation starts', async () => {
    await mount();
    expect(primary()?.disabled).toBe(false);

    await startGeneration();

    expect(primary()?.textContent).toBe('Generating...');
    expect(status()?.textContent).toBe('Generating answers...');
    expect(progressText()?.textContent).toBe('Processing page…');
    expect(cancelButton()?.hidden).toBe(true);
    expect(
      shadowRoot()
        .querySelector('.overlay-panel')
        ?.classList.contains('is-generating')
    ).toBe(true);
  });

  it('shows the warning and Cancel button only after twenty seconds', async () => {
    await mount();
    await startGeneration();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(status()?.textContent).toBe('Generating answers...');
    expect(cancelButton()?.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(status()?.textContent).toBe('This is taking longer than usual');
    expect(cancelButton()?.hidden).toBe(false);
    expect(cancelButton()?.textContent?.trim()).toBe('Cancel');
    expect(cancelButton()?.classList.contains('secondary')).toBe(true);
    expect(progressText()?.textContent).toBe('Processing page…');
  });

  it('never shows the warning when generation succeeds before twenty seconds', async () => {
    await mount();
    await startGeneration();

    await vi.advanceTimersByTimeAsync(5_000);
    await settleGenerationWith(generationResult);
    expect(status()?.textContent).toBe('Review answers');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(status()?.textContent).toBe('Review answers');
    expect(cancelButton()?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the warning timer when generation fails', async () => {
    await mount();
    await startGeneration();

    await vi.advanceTimersByTimeAsync(5_000);
    pendingGenerations.at(-1)?.reject(new Error('Generation failed.'));
    await flush();
    expect(status()?.textContent).toBe("Couldn't generate answers.");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(status()?.textContent).toBe("Couldn't generate answers.");
    expect(cancelButton()?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels through the existing service worker lifecycle and reuses the overlay', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(20_000);
    const host = document.querySelector('#answersense-overlay-host');
    expect(cancelButton()?.hidden).toBe(false);

    cancelButton()?.click();
    await flush();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'p7-cancel-generation' });
    expect(document.querySelectorAll('#answersense-overlay-host')).toHaveLength(
      1
    );
    expect(document.querySelector('#answersense-overlay-host')).toBe(host);
    expect(status()?.textContent).toBe('Canceled');
    expect(primary()?.textContent).toBe('Generate & Auto-Fill');
    expect(cancelButton()?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(status()?.textContent).toBe('Ready to generate');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a brief Canceled confirmation and then restores the ready status', async () => {
    await mount();
    await startGeneration();

    cancelButton()?.click();
    await flush();
    expect(status()?.textContent).toBe('Canceled');

    await vi.advanceTimersByTimeAsync(1_499);
    expect(status()?.textContent).toBe('Canceled');

    await vi.advanceTimersByTimeAsync(1);
    expect(status()?.textContent).toBe('Ready to generate');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('announces the cancellation in a polite live region', async () => {
    await mount();
    await startGeneration();
    expect(announcement()?.textContent).toBe('');
    expect(announcement()?.closest('.status-panel')).toBeNull();

    cancelButton()?.click();
    await flush();

    expect(announcement()?.getAttribute('role')).toBe('status');
    expect(announcement()?.getAttribute('aria-live')).toBe('polite');
    expect(announcement()?.classList.contains('visually-hidden')).toBe(true);
    expect(announcement()?.textContent).toBe('Generation canceled.');

    await startGeneration();
    expect(announcement()?.textContent).toBe('');
  });

  it('does not let the Canceled confirmation overwrite a new generation', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(20_000);

    cancelButton()?.click();
    await flush();
    expect(status()?.textContent).toBe('Canceled');

    await startGeneration();
    expect(status()?.textContent).toBe('Generating answers...');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(status()?.textContent).toBe('Generating answers...');
  });

  it('ignores a canceled generation that completes afterwards', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(20_000);
    cancelButton()?.click();
    await flush();

    await settleGenerationWith(generationResult);

    expect(status()?.textContent).toBe('Ready to generate');
    expect(shadowRoot().querySelector('.result-summary')).toBeNull();
    expect(primary()?.textContent).toBe('Generate & Auto-Fill');
    expect(
      shadowRoot()
        .querySelector('.overlay-panel')
        ?.classList.contains('is-generating')
    ).toBe(false);
  });

  it('starts a fresh generation after cancellation', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(20_000);
    cancelButton()?.click();
    await flush();
    await settleGenerationWith(generationResult);

    await startGeneration();
    expect(pendingGenerations).toHaveLength(2);
    expect(status()?.textContent).toBe('Generating answers...');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(status()?.textContent).toBe('This is taking longer than usual');

    await settleGenerationWith(generationResult);
    expect(status()?.textContent).toBe('Review answers');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accumulate timers, overlay elements, or listeners across cycles', async () => {
    await mount();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await startGeneration();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(status()?.textContent).toBe('This is taking longer than usual');

      cancelButton()?.click();
      await flush();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(vi.getTimerCount()).toBe(0);

      await settleGenerationWith(generationResult);
      expect(status()?.textContent).toBe('Ready to generate');
    }

    expect(document.querySelectorAll('#answersense-overlay-host')).toHaveLength(
      1
    );
    expect(
      shadowRoot().querySelectorAll('[data-generation-cancel]')
    ).toHaveLength(1);
    expect(addListener).toHaveBeenCalledOnce();
  });
});
