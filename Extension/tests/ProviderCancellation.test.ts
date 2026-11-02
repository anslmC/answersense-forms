import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/Generation/GeminiProvider';
import {
  NVIDIA_MODEL,
  NvidiaProvider,
  NvidiaProviderError,
} from '../src/Generation/NvidiaProvider';
import type { GenerationRequest } from '../src/Generation/Contract';

const request: GenerationRequest = {
  cycleId: 'cycle-cancel',
  pageId: 'page-1',
  questions: [
    {
      questionId: 'name',
      text: 'What is your name?',
      type: 'short-text',
      required: false,
      options: [],
    },
  ],
  settledContext: [],
};

function abortableFetch() {
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('Missing abort signal.'));
          return;
        }
        signals.push(signal);
        const rejectAborted = () =>
          reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener('abort', rejectAborted, { once: true });
      })
  );
  return { fetchImpl, signals };
}

describe('provider generation cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts an in-flight Gemini provider request when the generation is canceled', async () => {
    const { fetchImpl, signals } = abortableFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new GeminiProvider('test-key');
    const controller = new AbortController();
    const generation = provider.generate(request, controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);

    controller.abort();

    await expect(generation).rejects.toMatchObject({ safeCode: 'TIMEOUT' });
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight NVIDIA provider request when the generation is canceled', async () => {
    const { fetchImpl, signals } = abortableFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new NvidiaProvider('test-key', NVIDIA_MODEL);
    const controller = new AbortController();
    const generation = provider.generate(request, controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);

    controller.abort();

    await expect(generation).rejects.toBeInstanceOf(NvidiaProviderError);
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not wait for the provider when the cancel signal is already aborted', async () => {
    const { fetchImpl, signals } = abortableFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new GeminiProvider('test-key').generate(request, controller.signal)
    ).rejects.toMatchObject({ safeCode: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(true);
  });
});
