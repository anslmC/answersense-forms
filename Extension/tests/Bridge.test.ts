import { describe, expect, it, vi } from 'vitest';
import { BACKEND_GENERATE_URL, requestBackendGeneration } from '../src/Background/Bridge';
import type { GenerationRequest } from '../src/Generation/Contract';

const request: GenerationRequest = {
  cycleId: 'cycle-bridge',
  pageId: 'page-1',
  questions: [{
    questionId: 'name',
    text: 'Name',
    type: 'short-text',
    required: false,
    options: [],
  }],
  settledContext: [],
};

describe('P7 backend bridge', () => {
  it('posts the existing request contract and returns the backend response', async () => {
    const response = { cycleId: 'cycle-bridge', results: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestBackendGeneration(request)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(BACKEND_GENERATE_URL, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(request),
    }));
    vi.unstubAllGlobals();
  });

  it('surfaces backend failures to the workflow boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(requestBackendGeneration(request)).rejects.toThrow('Backend generation failed');
    vi.unstubAllGlobals();
  });
});
