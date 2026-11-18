import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOverlay, type OverlayHandle } from '../src/Overlay/Overlay';
import {
  GenerationPerformanceRecorder,
  type GenerationPerformanceReport,
} from '../src/Shared/Performance';

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
    ],
  },
};

function createSnapshot() {
  return {
    supported: true,
    uiState: 'READY' as const,
    page: { pageId: 'page-1', questionCount: 2 },
    lifecycle: {
      activePage: {
        form: {
          questions: ['question-1', 'question-2'].map((id, index) => ({
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

type RuntimeListener = (message: { type?: string; snapshot?: unknown }) => void;

let overlay: OverlayHandle | null = null;
let pendingGenerations: DeferredGeneration[] = [];
let runtimeListener: RuntimeListener | null = null;
let sendMessage: ReturnType<typeof vi.fn>;

function installChrome(): void {
  pendingGenerations = [];
  runtimeListener = null;
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
  const addListener = vi.fn((listener: RuntimeListener) => {
    runtimeListener = listener;
  });
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
const duration = () =>
  shadowRoot().querySelector<HTMLElement>('[data-generation-duration]');
const primary = () =>
  shadowRoot().querySelector<HTMLButtonElement>('[data-primary-action]');
const cancelButton = () =>
  shadowRoot().querySelector<HTMLButtonElement>('[data-generation-cancel]');
const progressText = () =>
  shadowRoot().querySelector<HTMLElement>('[data-workflow-progress-text]');

function displayedDurationMs(): number | null {
  const match = /·\s*([\d,]+)\s*ms/u.exec(duration()?.textContent ?? '');
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function performanceReport(): GenerationPerformanceReport | undefined {
  return (
    globalThis as typeof globalThis & {
      __answersensePerformance?: GenerationPerformanceReport;
    }
  ).__answersensePerformance;
}

function childPerformanceReport(
  outcome: GenerationPerformanceReport['outcome'] = 'SUCCESS'
): GenerationPerformanceReport {
  const recorder = new GenerationPerformanceRecorder('cycle-1', 'CONTENT');
  recorder.setProvider('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  recorder.addPhase('fillDurationMs', 120);
  recorder.setMeasurementStatus('batches', 'NOT_COLLECTED');
  recorder.finish(outcome, 4_000);
  return recorder.getReport();
}

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

describe('overlay live generation duration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (
      globalThis as typeof globalThis & {
        __answersensePerformance?: GenerationPerformanceReport;
      }
    ).__answersensePerformance;
    installChrome();
  });

  afterEach(() => {
    overlay?.close();
    overlay = null;
    runtimeListener = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    document.documentElement.replaceChildren(document.head, document.body);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (
      globalThis as typeof globalThis & {
        __answersensePerformance?: GenerationPerformanceReport;
      }
    ).__answersensePerformance;
  });

  it('starts the timer when generation begins', async () => {
    await mount();

    await startGeneration();

    expect(status()?.textContent).toBe('Generating · 0 ms');
    expect(duration()?.textContent).toBe(' · 0 ms');
    expect(progressText()?.textContent).toBe('Processing page…');
    expect(displayedDurationMs()).toBe(0);
    expect(vi.getTimerCount()).toBe(2);
  });

  it('updates the displayed duration while generation is active', async () => {
    await mount();
    await startGeneration();

    await vi.advanceTimersByTimeAsync(450);
    expect(status()?.textContent).toBe('Generating · 400 ms');

    await vi.advanceTimersByTimeAsync(550);
    expect(status()?.textContent).toBe('Generating · 1,000 ms');
  });

  it('shows the final duration on completion and matches the performance report', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(12_450);

    await settleGenerationWith(generationResult);

    expect(status()?.textContent).toBe('Completed · 12,450 ms');
    expect(displayedDurationMs()).toBe(12_450);
    expect(performanceReport()?.durationMs).toBe(12_450);
    expect(performanceReport()?.outcome).toBe('SUCCESS');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merges child context measurements without changing the overlay duration', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(5_000);
    const childReport = childPerformanceReport();

    runtimeListener?.({
      type: 'p7-state-updated',
      snapshot: {
        ...createSnapshot(),
        uiState: 'REVIEW',
        result: { ...generationResult, performance: childReport },
      },
    });
    await flush();

    expect(displayedDurationMs()).toBe(5_000);
    expect(performanceReport()).toMatchObject({
      correlationId: 'cycle-1',
      durationMs: 5_000,
      outcome: 'SUCCESS',
      providerId: 'nvidia',
      modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      phases: { fillDurationMs: 120 },
      measurementStatus: { batches: 'NOT_COLLECTED' },
    });
  });

  it('merges performance from a reused response', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(2_000);

    await settleGenerationWith({
      status: 'reused',
      pageId: 'page-1',
      performance: childPerformanceReport(),
    });

    expect(performanceReport()).toMatchObject({
      correlationId: 'cycle-1',
      durationMs: 2_000,
      outcome: 'SUCCESS',
      providerId: 'nvidia',
      phases: { fillDurationMs: 120 },
    });
  });

  it('merges performance from a terminal error snapshot', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(7_500);
    const childReport = childPerformanceReport('FAILURE');

    runtimeListener?.({
      type: 'p7-state-updated',
      snapshot: {
        ...createSnapshot(),
        uiState: 'ERROR',
        result: null,
        error: 'Generation failed.',
        performance: childReport,
      },
    });
    await flush();

    expect(status()?.textContent).toBe('Failed · 7,500 ms');
    expect(performanceReport()).toMatchObject({
      correlationId: 'cycle-1',
      durationMs: 7_500,
      outcome: 'FAILURE',
      providerId: 'nvidia',
      phases: { fillDurationMs: 120 },
    });
  });

  it('preserves the final duration after failure', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(27_757);

    pendingGenerations.at(-1)?.reject(new Error('Generation failed.'));
    await flush();

    expect(status()?.textContent).toBe('Failed · 27,757 ms');
    expect(performanceReport()?.durationMs).toBe(27_757);
    expect(performanceReport()?.outcome).toBe('FAILURE');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(status()?.textContent).toBe('Failed · 27,757 ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the final duration after cancellation and then cleans it up', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(cancelButton()?.hidden).toBe(false);
    cancelButton()?.click();
    await flush();

    expect(status()?.textContent).toBe('Cancelled · 20,000 ms');
    expect(performanceReport()?.durationMs).toBe(20_000);
    expect(performanceReport()?.outcome).toBe('CANCELLED');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(status()?.textContent).toBe('Ready to generate');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reset the timer across intermediate lifecycle snapshots', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(displayedDurationMs()).toBe(5_000);

    runtimeListener?.({
      type: 'p7-state-updated',
      snapshot: {
        ...createSnapshot(),
        uiState: 'GENERATING',
        generationOperationId: 'generation-1',
      },
    });
    await flush();
    expect(displayedDurationMs()).toBe(5_000);

    await vi.advanceTimersByTimeAsync(500);
    expect(displayedDurationMs()).toBe(5_500);
    expect(status()?.textContent).toBe('Generating · 5,500 ms');
  });

  it('stops the timer when a terminal lifecycle snapshot arrives', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(3_000);

    runtimeListener?.({
      type: 'p7-state-updated',
      snapshot: {
        ...createSnapshot(),
        uiState: 'REVIEW',
        result: generationResult,
      },
    });
    await flush();

    expect(status()?.textContent).toBe('Completed · 3,000 ms');
    expect(performanceReport()?.durationMs).toBe(3_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the duration timer when the overlay is destroyed', async () => {
    await mount();
    await startGeneration();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(2);

    overlay?.close();
    overlay = null;

    expect(document.querySelector('#answersense-overlay-host')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
