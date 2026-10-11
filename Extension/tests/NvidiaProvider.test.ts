import { describe, expect, it, vi } from 'vitest';
import {
  NVIDIA_ENDPOINT,
  NVIDIA_GPT_OSS_MODEL,
  NVIDIA_MODEL,
  NvidiaProvider,
  NvidiaProviderError,
  NVIDIA_REQUEST_TIMEOUT_MS,
  validateNvidiaCredential,
} from '../src/Generation/NvidiaProvider';
import type { GenerationRequest } from '../src/Generation/Contract';
import { systemInstruction } from '../src/Generation/SystemInstructions';

const request: GenerationRequest = {
  cycleId: 'nvidia-cycle',
  pageId: 'nvidia-page',
  questions: [{
    questionId: 'garden-tools',
    text: 'Why label shared garden tools?',
    type: 'short-text',
    required: true,
    options: [],
  }],
  settledContext: [],
};

function validGenerationResponse(cycleId = request.cycleId) {
  return {
    cycleId,
    results: [{
      questionId: request.questions[0].questionId,
      status: 'GENERATED',
      answer: {
        questionId: request.questions[0].questionId,
        value: 'Labels help return tools to their shared storage location.',
      },
    }],
  };
}

function completion(content: string, finishReason: unknown = 'stop') {
  return {
    id: 'completion-id',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  };
}

function completionWithRole(content: string, role: string) {
  const value = completion(content);
  return {
    ...value,
    choices: [{
      ...value.choices[0],
      message: { ...value.choices[0].message, role },
    }],
  };
}

function successfulFetch(content: string, finishReason: unknown = 'stop') {
  return vi.fn(async () => new Response(
    JSON.stringify(completion(content, finishReason)),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  ));
}

describe('NVIDIA Nemotron provider', () => {
  it('sends the fixed endpoint, Bearer authentication, and tested request settings', async () => {
    const fetchMock = successfulFetch(JSON.stringify(validGenerationResponse()));
    const provider = new NvidiaProvider('synthetic-test-key', NVIDIA_MODEL, fetchMock);

    await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(NVIDIA_ENDPOINT);
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer synthetic-test-key'
    );
    const payload = JSON.parse(String(init.body));
    expect(Object.keys(payload).sort()).toEqual([
      'max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'temperature', 'top_p',
    ]);
    expect(payload.model).toBe(NVIDIA_MODEL);
    expect(payload.stream).toBe(false);
    expect(payload.reasoning_effort).toBe('low');
    expect(payload.max_tokens).toBe(16384);
  });

  it('uses GPT-OSS model-specific request settings', async () => {
    const fetchMock = successfulFetch(JSON.stringify(validGenerationResponse()));
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_GPT_OSS_MODEL,
      fetchMock
    );

    await provider.generate(request);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe(NVIDIA_GPT_OSS_MODEL);
    expect(payload.max_tokens).toBe(4096);
    expect(payload.reasoning_effort).toBe('low');
  });

  it('sends the unchanged system instruction and explicit response-contract directions', async () => {
    const fetchMock = successfulFetch(JSON.stringify(validGenerationResponse()));
    const provider = new NvidiaProvider('synthetic-test-key', NVIDIA_MODEL, fetchMock);

    await provider.generate(request);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.messages[0]).toEqual({ role: 'system', content: systemInstruction });
    const userMessage = JSON.parse(payload.messages[1].content);
    expect(userMessage.cycleId).toBe(request.cycleId);
    expect(userMessage.questions).toEqual(request.questions);
    expect(userMessage.responseContract.requiredTopLevelFields).toEqual([
      'cycleId', 'results',
    ]);
    expect(userMessage.responseContract.results).toMatch(/exactly one result/u);
    expect(userMessage.responseContract.resultVariants).toHaveProperty('GENERATED');
    expect(userMessage.responseContract.resultVariants).toHaveProperty('ABSTAINED');
    expect(userMessage.responseContract.resultVariants).toHaveProperty('GENERATION_FAILED');
    expect(userMessage.responseContract.answerRules).toMatch(/supplied option/u);
  });

  it('parses assistant completion content into the shared generation response shape', async () => {
    const expected = validGenerationResponse();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      successfulFetch(JSON.stringify(expected))
    );

    await expect(provider.generate(request)).resolves.toEqual(expected);
  });

  it.each([
    ['invalid completion JSON', '{not-json'],
    ['missing choices', JSON.stringify({ id: 'id', choices: [] })],
    ['non-array choices', JSON.stringify({ id: 'id', choices: null })],
    ['missing message content', JSON.stringify({
      id: 'id', choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
    })],
    ['empty message content', JSON.stringify(completion(''))],
    ['non-assistant message', JSON.stringify(completionWithRole(
      JSON.stringify(validGenerationResponse()),
      'user'
    ))],
    ['invalid generated JSON', JSON.stringify(completion('{not-json'))],
    ['invalid response structure', JSON.stringify(completion(JSON.stringify({ results: {} })))],
  ])('rejects %s without exposing response content', async (_name, responseBody) => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      vi.fn(async () => new Response(String(responseBody), { status: 200 }))
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it.each([
    ['valid content', JSON.stringify(validGenerationResponse())],
    ['empty content', ''],
  ])('classifies finish_reason length as an incomplete response with %s', async (_label, content) => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      successfulFetch(content, 'length')
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
    });
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [408, 'TIMEOUT'],
    [422, 'INVALID_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [202, 'PROVIDER_UNAVAILABLE'],
  ] as const)('classifies HTTP %i as %s without exposing the provider body', async (status, safeCode) => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      vi.fn(async () => new Response('private provider error body', { status }))
    );

    const thrown = await provider.generate(request).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NvidiaProviderError);
    expect(thrown).toMatchObject({ safeCode });
    expect((thrown as Error).message).not.toContain('private');
    expect((thrown as Error).message).not.toContain('synthetic-test-key');
  });

  it('classifies network failures and does not expose exception details', async () => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      vi.fn(async () => { throw new TypeError('private network details'); })
    );

    const thrown = await provider.generate(request).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ safeCode: 'NETWORK_FAILURE' });
    expect((thrown as Error).message).not.toContain('private');
  });

  it.each(['headers', 'body'] as const)('times out while waiting for response %s', async (phase) => {
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      if (phase === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('private timeout details', 'AbortError'));
          });
        });
      }
      return Promise.resolve({
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('private body timeout details', 'AbortError'));
          });
        }),
      } as Response);
    });
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock as unknown as typeof fetch,
      5
    );

    const thrown = await provider.generate(request).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ safeCode: 'TIMEOUT' });
    expect((thrown as Error).message).not.toContain('private');
  });

  it('rejects a response that echoes the API key with a safe error', async () => {
    const echoed = validGenerationResponse();
    echoed.results[0].answer.value = 'synthetic-test-key';
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      successfulFetch(JSON.stringify(echoed))
    );

    const thrown = await provider.generate(request).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ safeCode: 'PROVIDER_FAILURE' });
    expect((thrown as Error).message).not.toContain('synthetic-test-key');
  });

  it('validates credentials with a bounded synthetic chat probe and does not require a particular answer', async () => {
    const fetchMock = successfulFetch(JSON.stringify({
      cycleId: 'nvidia-credential-validation',
      results: [{
        questionId: 'nvidia-validation-question',
        status: 'GENERATED',
        answer: {
          questionId: 'nvidia-validation-question',
          value: 'Labels make it easier to return tools.',
        },
      }],
    }));

    await expect(
      validateNvidiaCredential('synthetic-test-key', NVIDIA_MODEL, fetchMock)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(NVIDIA_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts GPT-OSS for the bounded credential validation probe', async () => {
    const fetchMock = successfulFetch(JSON.stringify({
      cycleId: 'nvidia-credential-validation',
      results: [{
        questionId: 'nvidia-validation-question',
        status: 'GENERATED',
        answer: {
          questionId: 'nvidia-validation-question',
          value: 'Labels help return tools.',
        },
      }],
    }));

    await expect(
      validateNvidiaCredential(
        'synthetic-test-key',
        NVIDIA_GPT_OSS_MODEL,
        fetchMock
      )
    ).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe(NVIDIA_GPT_OSS_MODEL);
    expect(payload.max_tokens).toBe(4096);
    expect(payload.reasoning_effort).toBe('low');
  });

  it('rejects validation for a non-registered model without making a request', async () => {
    const fetchMock = vi.fn();
    await expect(
      validateNvidiaCredential('synthetic-test-key', 'attacker/model', fetchMock)
    ).rejects.toMatchObject({ safeCode: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});