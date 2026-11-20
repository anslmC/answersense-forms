import { describe, expect, it, vi } from 'vitest';
import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import {
  DEFAULT_NVIDIA_BATCH_LIMITS,
  NvidiaBatchLimitError,
  createNvidiaBatchRequest,
  planNvidiaBatches,
} from '../src/Generation/NvidiaBatchPlanning';
import {
  NVIDIA_BATCH_CONCURRENCY,
  NvidiaBatchCancellationError,
  NvidiaBatchDeadlineError,
  executeNvidiaBatches,
} from '../src/Generation/NvidiaBatchExecution';
import { assembleNvidiaBatchResponse } from '../src/Generation/NvidiaResponseAssembly';
import {
  estimateNvidiaRequestTokens,
  measureNvidiaRequest,
  serializeNvidiaPayload,
} from '../src/Generation/NvidiaRequest';
import { NVIDIA_SERVER_BUSY_MESSAGE } from '../src/Generation/ProviderIdentity';
import {
  NVIDIA_LIGHTNING_OVERALL_TIMEOUT_MS,
  NVIDIA_MODEL,
  NVIDIA_NEMOTRON_LIGHTNING_MODEL,
  NVIDIA_OVERALL_TIMEOUT_MS,
  NvidiaProvider,
  NvidiaProviderError,
  getNvidiaModelPolicy,
  validateNvidiaCredential,
} from '../src/Generation/NvidiaProvider';
import type { Form } from '../src/Models/Logical';
import { validateGenerationResponse } from '../src/Generation/Validation';
import {
  computeNvidiaOverallTimeoutMs,
  computeNvidiaRequestBudget,
  mergeNvidiaDeadlineResults,
} from '../src/Generation/NvidiaRecovery';

function makeQuestion(
  index: number,
  overrides: Partial<GenerationQuestion> = {}
): GenerationQuestion {
  return {
    questionId: `q-${index}`,
    text: `Question ${index}`,
    type: 'single-choice',
    required: true,
    options: ['A', 'B', 'C'],
    ...overrides,
  };
}

function makeRequest(
  count: number,
  overrides: Partial<GenerationRequest> = {}
): GenerationRequest {
  return {
    cycleId: 'batch-cycle',
    pageId: 'batch-page',
    questions: Array.from({ length: count }, (_, index) =>
      makeQuestion(index + 1)
    ),
    settledContext: [],
    ...overrides,
  };
}

function generatedResponse(request: GenerationRequest): GenerationResponse {
  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) => ({
      questionId: question.questionId,
      status: 'GENERATED',
      answer: {
        questionId: question.questionId,
        value: 'A',
      },
    })),
  };
}

function completion(content: string) {
  return {
    id: 'batch-completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function requestFromBody(body: BodyInit | null | undefined): GenerationRequest {
  const payload = JSON.parse(String(body));
  return JSON.parse(payload.messages[1].content) as GenerationRequest;
}

function successfulBatchFetch(
  options: { failQuestionId?: string; failStatus?: number } = {}
) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const batchRequest = requestFromBody(init?.body);
    if (
      options.failQuestionId &&
      batchRequest.questions.some(
        (question) => question.questionId === options.failQuestionId
      )
    ) {
      return new Response('provider failure', {
        status: options.failStatus ?? 500,
      });
    }
    return new Response(
      JSON.stringify(
        completion(JSON.stringify(generatedResponse(batchRequest)))
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });
}

function capturedBatches(
  fetchMock: ReturnType<typeof successfulBatchFetch>
): GenerationRequest[] {
  return (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(
    ([, init]) => requestFromBody(init.body)
  );
}

function firstQuestionNumber(request: GenerationRequest): number {
  return Number(request.questions[0].questionId.replace('q-', ''));
}

function makeForm(request: GenerationRequest): Form {
  return {
    formId: 'batch-form',
    activePageId: request.pageId,
    questions: request.questions.map((question) => ({
      id: question.questionId,
      text: question.text,
      type: question.type,
      required: question.required,
      options: question.options.map((label) => ({
        label,
        selected: false,
      })),
      existingInput: { value: null, hasValue: false },
      supported: true,
      unsupportedReason: null,
      ...(question.answerParts === undefined
        ? {}
        : { answerParts: question.answerParts }),
    })),
  };
}

describe('NVIDIA batch planning', () => {
  it.each([
    [1, 1],
    [10, 1],
    [25, 3],
    [50, 5],
  ])(
    'plans %i questions into %i batches without changing order',
    (questionCount, expectedBatchCount) => {
      const request = makeRequest(questionCount);
      const batches = planNvidiaBatches(request);

      expect(batches).toHaveLength(expectedBatchCount);
      expect(batches.every((batch) => batch.questions.length > 0)).toBe(true);
      expect(
        batches.flatMap((batch) =>
          batch.questions.map((question) => question.questionId)
        )
      ).toEqual(request.questions.map((question) => question.questionId));
    }
  );

  it('keeps each question whole when applying custom limits', () => {
    const request = makeRequest(10);
    const questionLimited = planNvidiaBatches(request, {
      ...DEFAULT_NVIDIA_BATCH_LIMITS,
      maxQuestionsPerBatch: 4,
    });
    expect(questionLimited.map((batch) => batch.questions.length)).toEqual([
      4, 4, 2,
    ]);

    const outputLimited = planNvidiaBatches(request, {
      ...DEFAULT_NVIDIA_BATCH_LIMITS,
      maxEstimatedOutputTokens: 100,
    });
    expect(outputLimited.map((batch) => batch.questions.length)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
  });

  it('applies planning-only reasoning reserves without expanding API budgets', () => {
    const request = makeRequest(10);
    const superPolicy = getNvidiaModelPolicy(NVIDIA_MODEL);
    const lightningPolicy = getNvidiaModelPolicy(
      NVIDIA_NEMOTRON_LIGHTNING_MODEL
    );
    expect(superPolicy).toBeDefined();
    expect(lightningPolicy).toBeDefined();

    const superBatches = planNvidiaBatches(request, superPolicy!.batchLimits, {
      payloadProfile: superPolicy!.payloadProfile,
      reasoningTokenReserve: superPolicy!.reasoningTokenReserve,
    });
    const lightningWithoutReserve = planNvidiaBatches(
      request,
      lightningPolicy!.batchLimits,
      {
        payloadProfile: lightningPolicy!.payloadProfile,
        reasoningTokenReserve: 0,
      }
    );
    const lightningBatches = planNvidiaBatches(
      request,
      lightningPolicy!.batchLimits,
      {
        payloadProfile: lightningPolicy!.payloadProfile,
        reasoningTokenReserve: lightningPolicy!.reasoningTokenReserve,
      }
    );

    expect(superBatches).toHaveLength(1);
    expect(lightningWithoutReserve).toHaveLength(1);
    expect(lightningBatches).toHaveLength(1);
    expect(lightningPolicy!.batchLimits.maxEstimatedOutputTokens).toBe(4_000);
    expect(lightningPolicy!.payloadProfile.maxTokens).toBe(32768);
    expect(
      lightningBatches[0].estimatedOutputTokens -
        lightningWithoutReserve[0].estimatedOutputTokens
    ).toBe(lightningPolicy!.reasoningTokenReserve);
    expect(superBatches[0].estimatedOutputTokens).toBeLessThanOrEqual(
      superPolicy!.batchLimits.maxEstimatedOutputTokens
    );
    expect(superBatches[0].estimatedOutputTokens).toBeLessThan(
      superPolicy!.payloadProfile.maxTokens
    );
  });

  it('measures payloads with each model response-format policy', () => {
    const request = makeRequest(1);
    const superPolicy = getNvidiaModelPolicy(NVIDIA_MODEL);
    const lightningPolicy = getNvidiaModelPolicy(
      NVIDIA_NEMOTRON_LIGHTNING_MODEL
    );
    expect(superPolicy).toBeDefined();
    expect(lightningPolicy).toBeDefined();

    const superSerialized = serializeNvidiaPayload(
      request,
      superPolicy!.payloadProfile
    );
    const lightningSerialized = serializeNvidiaPayload(
      request,
      lightningPolicy!.payloadProfile
    );

    expect(superSerialized).not.toContain('response_format');
    expect(lightningSerialized).toContain(
      '"response_format":{"type":"json_object"}'
    );
    expect(
      measureNvidiaRequest(request, lightningPolicy!.payloadProfile)
        .serializedBytes
    ).toBeGreaterThan(
      measureNvidiaRequest(request, superPolicy!.payloadProfile).serializedBytes
    );
  });

  it('rejects an oversized single question', () => {
    const request = makeRequest(1, {
      questions: [
        makeQuestion(1, {
          text: 'x'.repeat(20_000),
        }),
      ],
    });
    const contextEstimate = measureNvidiaRequest({
      ...request,
      questions: [],
    });
    const limits = {
      ...DEFAULT_NVIDIA_BATCH_LIMITS,
      maxEstimatedInputTokens: contextEstimate.estimatedInputTokens + 100,
      maxSerializedBytes: contextEstimate.serializedBytes + 100,
    };

    expect(() => planNvidiaBatches(request, limits)).toThrow(
      NvidiaBatchLimitError
    );
    try {
      planNvidiaBatches(request, limits);
    } catch (error) {
      expect(error).toMatchObject({
        reason: 'QUESTION',
        questionIds: ['q-1'],
      });
    }
  });

  it('uses the complete serialized request for byte and token estimates', () => {
    const request = makeRequest(10);
    const [batch] = planNvidiaBatches(request);
    const fullRequest = {
      ...request,
      questions: [...batch.questions],
    };
    const userOnly = JSON.stringify({
      questions: batch.questions,
      settledContext: request.settledContext,
    });
    const fullSerialized = serializeNvidiaPayload(fullRequest);

    expect(batch.serializedBytes).toBe(
      new TextEncoder().encode(fullSerialized).byteLength
    );
    expect(batch.serializedBytes).toBeGreaterThan(
      new TextEncoder().encode(userOnly).byteLength
    );
    expect(batch.estimatedInputTokens).toBeGreaterThan(
      estimateNvidiaRequestTokens(userOnly)
    );
  });

  it('estimates non-ASCII text conservatively', () => {
    expect(estimateNvidiaRequestTokens('漢'.repeat(1_000))).toBeGreaterThan(
      estimateNvidiaRequestTokens('a'.repeat(1_000))
    );
  });

  it('rejects oversized settled context', () => {
    const request = makeRequest(1, {
      settledContext: [
        {
          questionId: 'context-question',
          questionText: 'Context question',
          answer: 'x'.repeat(50_000),
        },
      ],
    });

    expect(() => planNvidiaBatches(request)).toThrow(NvidiaBatchLimitError);
    try {
      planNvidiaBatches(request);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'CONTEXT', questionIds: [] });
    }
  });

  it('rejects an oversized question alongside normal questions', () => {
    const request = makeRequest(3);
    request.questions[1] = makeQuestion(2, { text: 'x'.repeat(50_000) });

    expect(() => planNvidiaBatches(request)).toThrow(NvidiaBatchLimitError);
    try {
      planNvidiaBatches(request);
    } catch (error) {
      expect(error).toMatchObject({
        reason: 'QUESTION',
        questionIds: ['q-2'],
      });
    }
  });

  it('applies multiple limits while keeping each question whole', () => {
    const request = makeRequest(12);
    const contextEstimate = measureNvidiaRequest({
      ...request,
      questions: [],
    });
    const limits = {
      maxQuestionsPerBatch: 5,
      maxEstimatedInputTokens: contextEstimate.estimatedInputTokens + 1_000,
      maxEstimatedOutputTokens: 200,
      maxSerializedBytes: contextEstimate.serializedBytes + 3_000,
    };
    const batches = planNvidiaBatches(request, limits);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.questions.length).toBeLessThanOrEqual(
        limits.maxQuestionsPerBatch
      );
      expect(batch.estimatedInputTokens).toBeLessThanOrEqual(
        limits.maxEstimatedInputTokens
      );
      expect(batch.estimatedOutputTokens).toBeLessThanOrEqual(
        limits.maxEstimatedOutputTokens
      );
      expect(batch.serializedBytes).toBeLessThanOrEqual(
        limits.maxSerializedBytes
      );
    }
    expect(
      batches.flatMap((batch) =>
        batch.questions.map((question) => question.questionId)
      )
    ).toEqual(request.questions.map((question) => question.questionId));
  });

  it('preserves referenced same-page question context across batch boundaries', () => {
    const request = makeRequest(25);
    request.questions[14] = makeQuestion(15, {
      text: 'Use the answers to question 5 and question 1 to choose.',
    });
    const batches = planNvidiaBatches(request);
    const batch = batches.find((candidate) =>
      candidate.questions.some((question) => question.questionId === 'q-15')
    );
    expect(batch).toBeDefined();

    const batchRequest = createNvidiaBatchRequest(request, batch!);
    expect(batchRequest.samePageContext).toEqual([
      {
        questionId: 'q-1',
        questionText: 'Question 1',
        type: 'single-choice',
        options: ['A', 'B', 'C'],
      },
      {
        questionId: 'q-5',
        questionText: 'Question 5',
        type: 'single-choice',
        options: ['A', 'B', 'C'],
      },
    ]);
  });

  it('creates batch requests that preserve request metadata', () => {
    const request = makeRequest(12, {
      settledContext: [
        {
          questionId: 'context-question',
          questionText: 'Context question',
          answer: 'A',
        },
      ],
    });
    const batch = planNvidiaBatches(request)[1];
    const batchRequest = createNvidiaBatchRequest(request, batch);

    expect(batchRequest.cycleId).toBe(request.cycleId);
    expect(batchRequest.pageId).toBe(request.pageId);
    expect(batchRequest.settledContext).toBe(request.settledContext);
    expect(batchRequest.questions).toEqual(batch.questions);
    expect(batchRequest.questions[0]).not.toBe(batch.questions[0]);
    expect(batchRequest.questions[0].options).not.toBe(
      batch.questions[0].options
    );
  });
});

describe('NVIDIA batch provider integration', () => {
  it('keeps a ten-question form on a single request', async () => {
    const request = makeRequest(10);
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.results).toHaveLength(10);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(131072);
  });

  it('splits a 25-question form into three ordered requests', async () => {
    const request = makeRequest(25);
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const batches = capturedBatches(fetchMock).sort(
      (left, right) => firstQuestionNumber(left) - firstQuestionNumber(right)
    );
    expect(batches.map((batch) => batch.questions.length)).toEqual([10, 10, 5]);
    expect(
      batches.flatMap((batch) =>
        batch.questions.map((question) => question.questionId)
      )
    ).toEqual(request.questions.map((question) => question.questionId));
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
  });

  it('splits a 50-question form into five ordered requests', async () => {
    const request = makeRequest(50);
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const batches = capturedBatches(fetchMock);
    expect(batches.every((batch) => batch.questions.length === 10)).toBe(true);
    expect(response.results).toHaveLength(50);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
  });

  it('preserves successful batches when one batch fails', async () => {
    const request = makeRequest(25);
    const fetchMock = successfulBatchFetch({
      failQuestionId: 'q-11',
    });
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);
    const failedIds = new Set(
      Array.from({ length: 10 }, (_, index) => `q-${index + 11}`)
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
    expect(
      new Set(response.results.map((result) => result.questionId)).size
    ).toBe(25);
    expect(
      response.results.filter((result) => result.status === 'GENERATED')
    ).toHaveLength(15);
    expect(
      response.results.filter((result) => result.status === 'GENERATION_FAILED')
    ).toHaveLength(10);
    for (const result of response.results) {
      if (failedIds.has(result.questionId)) {
        expect(result).toEqual({
          questionId: result.questionId,
          status: 'GENERATION_FAILED',
          answer: null,
          failure: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'Provider unavailable.',
          },
        });
      }
    }

    const questionResults = validateGenerationResponse(
      response,
      makeForm(request),
      request.cycleId
    );
    expect(
      questionResults.filter((result) => result.status === 'GENERATION_FAILED')
    ).toHaveLength(10);
  });

  it('preserves the server-busy message for failed 503 questions', async () => {
    const request = makeRequest(25);
    const fetchMock = successfulBatchFetch({
      failQuestionId: 'q-11',
      failStatus: 503,
    });
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);
    const failedIds = new Set(
      Array.from({ length: 10 }, (_, index) => `q-${index + 11}`)
    );
    const failedResults = response.results.filter(
      (result) => result.status === 'GENERATION_FAILED'
    );

    expect(failedResults).toHaveLength(10);
    for (const result of failedResults) {
      expect(failedIds.has(result.questionId)).toBe(true);
      expect(result).toMatchObject({
        failure: {
          code: 'PROVIDER_UNAVAILABLE',
          message: NVIDIA_SERVER_BUSY_MESSAGE,
        },
      });
    }
    expect(
      response.results.filter((result) => result.status === 'GENERATED')
    ).toHaveLength(15);
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED', 3],
    [500, 'PROVIDER_UNAVAILABLE', 9],
  ] as const)(
    'propagates an all-batch %i failure as %s',
    async (status, safeCode, expectedCalls) => {
      const request = makeRequest(25);
      const fetchMock = vi.fn(
        async () => new Response('private provider failure', { status })
      );
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        fetchMock
      );

      const thrown = await provider
        .generate(request)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(NvidiaProviderError);
      expect(thrown).toMatchObject({ safeCode });
      expect((thrown as Error).message).not.toContain('private');
      expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    }
  );

  it('returns an empty response without contacting NVIDIA', async () => {
    const request = makeRequest(0);
    const fetchMock = vi.fn();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await expect(provider.generate(request)).resolves.toEqual({
      cycleId: request.cycleId,
      results: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate question IDs before planning or sending', async () => {
    const request = makeRequest(12);
    request.questions[5] = makeQuestion(6, { questionId: 'q-1' });
    const fetchMock = vi.fn();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      safeCode: 'INVALID_REQUEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a single oversized question',
      makeRequest(1, {
        questions: [makeQuestion(1, { text: 'x'.repeat(50_000) })],
      }),
    ],
    [
      'an oversized question alongside normal questions',
      makeRequest(3, {
        questions: [
          makeQuestion(1),
          makeQuestion(2, { text: 'x'.repeat(50_000) }),
          makeQuestion(3),
        ],
      }),
    ],
    [
      'oversized settled context',
      makeRequest(1, {
        settledContext: [
          {
            questionId: 'context-question',
            questionText: 'Context question',
            answer: 'x'.repeat(50_000),
          },
        ],
      }),
    ],
  ])('rejects %s without a provider request', async (_name, request) => {
    const fetchMock = vi.fn();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      safeCode: 'INVALID_REQUEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends referenced same-page questions as compact context', async () => {
    const request = makeRequest(25);
    request.questions[14] = makeQuestion(15, {
      text: 'Use the answer to question 1 to choose.',
    });
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await provider.generate(request);

    const batch = capturedBatches(fetchMock).find((candidate) =>
      candidate.questions.some((question) => question.questionId === 'q-15')
    ) as (GenerationRequest & { samePageContext?: unknown }) | undefined;
    expect(batch?.samePageContext).toEqual([
      {
        questionId: 'q-1',
        questionText: 'Question 1',
        type: 'single-choice',
        options: ['A', 'B', 'C'],
      },
    ]);
  });

  it('uses model-specific settings for Lightning batch requests', async () => {
    const request = makeRequest(25);
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      const payload = JSON.parse(String(init.body));
      expect(payload.model).toBe(NVIDIA_NEMOTRON_LIGHTNING_MODEL);
      expect(payload.chat_template_kwargs).toEqual({
        enable_thinking: true,
      });
      expect(payload.reasoning_budget).toBe(450);
      expect(payload).not.toHaveProperty('reasoning_effort');
      expect(payload.response_format).toEqual({ type: 'json_object' });
      expect(payload.max_tokens).toBe(32768);
    }
  });

  it('propagates an overall batch deadline as a timeout', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest(25);
      const fetchMock = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          })
      );
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        fetchMock as unknown as typeof fetch,
        undefined,
        100
      );

      const generation = provider
        .generate(request)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);

      await expect(generation).resolves.toMatchObject({ safeCode: 'TIMEOUT' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(NVIDIA_OVERALL_TIMEOUT_MS).toBe(90_000);
      expect(NVIDIA_LIGHTNING_OVERALL_TIMEOUT_MS).toBe(180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates credentials with one direct request', async () => {
    const fetchMock = successfulBatchFetch();

    await validateNvidiaCredential(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [batchRequest] = capturedBatches(fetchMock);
    expect(batchRequest.questions).toHaveLength(1);
  });

  it('maps direct request cancellation to provider unavailable', async () => {
    const request = makeRequest(3);
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const generation = provider.generate(request, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(generation).rejects.toMatchObject({
      safeCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('cancels in-flight batches without starting new requests', async () => {
    const request = makeRequest(50);
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
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
          signal.addEventListener('abort', rejectAborted, {
            once: true,
          });
        })
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const generation = provider.generate(request, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(generation).rejects.toMatchObject({
      safeCode: 'PROVIDER_UNAVAILABLE',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('NVIDIA batch execution', () => {
  it('runs at most two batches concurrently', async () => {
    const request = makeRequest(50);
    const batches = planNvidiaBatches(request);
    let active = 0;
    let maximum = 0;
    const pending: Array<() => void> = [];
    const runBatch = vi.fn((batchRequest: GenerationRequest) => {
      active += 1;
      maximum = Math.max(maximum, active);
      return new Promise<GenerationResponse>((resolve) => {
        pending.push(() => {
          active -= 1;
          resolve(generatedResponse(batchRequest));
        });
      });
    });

    const execution = executeNvidiaBatches(request, batches, runBatch, {
      concurrency: 10,
    });
    await vi.waitFor(() => expect(runBatch).toHaveBeenCalledTimes(2));
    while (runBatch.mock.calls.length < batches.length || pending.length > 0) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()?.();
      await Promise.resolve();
    }
    const outcomes = await execution;

    expect(maximum).toBe(NVIDIA_BATCH_CONCURRENCY);
    expect(runBatch).toHaveBeenCalledTimes(5);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it('stops scheduling batches when execution is cancelled', async () => {
    const request = makeRequest(50);
    const batches = planNvidiaBatches(request);
    const controller = new AbortController();
    const runBatch = vi.fn(
      (_batchRequest: GenerationRequest, signal?: AbortSignal) =>
        new Promise<GenerationResponse>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );

    const execution = executeNvidiaBatches(request, batches, runBatch, {
      signal: controller.signal,
      overallTimeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(runBatch).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(execution).rejects.toBeInstanceOf(
      NvidiaBatchCancellationError
    );
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  it('retains safe batch failure metadata for phase 2', async () => {
    const request = makeRequest(25);
    const batches = planNvidiaBatches(request);
    const runBatch = vi.fn(async (batchRequest: GenerationRequest) => {
      if (firstQuestionNumber(batchRequest) === 1) {
        throw new NvidiaProviderError('AUTHENTICATION_FAILED');
      }
      throw new Error('private raw error');
    });

    const outcomes = await executeNvidiaBatches(request, batches, runBatch, {
      concurrency: 1,
    });

    expect(outcomes[0]).toMatchObject({
      ok: false,
      metadata: {
        batchIndex: 0,
        questionIds: [
          'q-1',
          'q-2',
          'q-3',
          'q-4',
          'q-5',
          'q-6',
          'q-7',
          'q-8',
          'q-9',
          'q-10',
        ],
        safeCode: 'AUTHENTICATION_FAILED',
        category: 'AUTHENTICATION',
        retryable: false,
        message: 'Credential invalid.',
      },
    });
    expect(outcomes[1]).toMatchObject({
      ok: false,
      metadata: {
        batchIndex: 1,
        safeCode: 'PROVIDER_FAILURE',
        category: 'PROVIDER_FAILURE',
        retryable: false,
        message: 'Provider request failed.',
      },
    });
    expect(JSON.stringify(outcomes)).not.toContain('private raw error');
  });

  it('stops active and queued batches at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest(50);
      const batches = planNvidiaBatches(request);
      const signals: AbortSignal[] = [];
      const runBatch = vi.fn(
        (_batchRequest: GenerationRequest, signal?: AbortSignal) =>
          new Promise<GenerationResponse>((_resolve, reject) => {
            if (signal) {
              signals.push(signal);
            }
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          })
      );

      const execution = executeNvidiaBatches(request, batches, runBatch, {
        overallTimeoutMs: 100,
      }).catch((reason: unknown) => reason);
      expect(runBatch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(100);

      await expect(execution).resolves.toBeInstanceOf(NvidiaBatchDeadlineError);
      expect(runBatch).toHaveBeenCalledTimes(2);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains completed successes internally when the deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest(25);
      const batches = planNvidiaBatches(request);
      const runBatch = vi.fn(
        (batchRequest: GenerationRequest, signal?: AbortSignal) => {
          if (firstQuestionNumber(batchRequest) <= 20) {
            return Promise.resolve(generatedResponse(batchRequest));
          }
          return new Promise<GenerationResponse>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          });
        }
      );

      const execution = executeNvidiaBatches(request, batches, runBatch, {
        overallTimeoutMs: 100,
      }).catch((reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(100);
      const error = await execution;

      expect(error).toBeInstanceOf(NvidiaBatchDeadlineError);
      expect(
        (error as NvidiaBatchDeadlineError).completedOutcomes
      ).toHaveLength(2);
      expect(runBatch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NVIDIA single-batch recovery parity', () => {
  it('salvages a partial single-batch response and retries only the missing question', async () => {
    const request = makeRequest(5);
    let calls = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const batchRequest = requestFromBody(init?.body);
      const answered =
        calls === 1
          ? batchRequest.questions.slice(0, 4)
          : batchRequest.questions;
      return new Response(
        JSON.stringify(
          completion(
            JSON.stringify({
              cycleId: batchRequest.cycleId,
              results: answered.map((question) => ({
                questionId: question.questionId,
                status: 'GENERATED',
                answer: { questionId: question.questionId, value: 'A' },
              })),
            })
          )
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    const response = await provider.generate(request);
    const batches = (
      fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    ).map(([, init]) => requestFromBody(init.body));

    expect(batches.map((batch) => batch.questions.length)).toEqual([5, 1]);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('preserves request context for a single-batch request', async () => {
    const settledContext = [
      {
        questionId: 'settled-1',
        questionText: 'Settled question',
        answer: 'A',
      },
    ];
    const request = makeRequest(2, { settledContext });
    const fetchMock = successfulBatchFetch();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [batch] = capturedBatches(fetchMock);
    expect(batch.cycleId).toBe(request.cycleId);
    expect(batch.settledContext).toEqual(settledContext);
    expect(batch.questions.map((question) => question.questionId)).toEqual([
      'q-1',
      'q-2',
    ]);
  });

  it('reports truncated provider responses as retryable malformed responses', async () => {
    const request = makeRequest(2);
    const batches = planNvidiaBatches(request);
    const runBatch = vi.fn(async () => {
      throw new NvidiaProviderError('INCOMPLETE_PROVIDER_RESPONSE');
    });

    const outcomes = await executeNvidiaBatches(request, batches, runBatch, {
      concurrency: 1,
    });

    expect(outcomes[0]).toMatchObject({
      ok: false,
      metadata: {
        safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
        category: 'MALFORMED_RESPONSE',
        retryable: true,
      },
    });
  });

  it('budgets the complete bounded workload for a ten-question batch', () => {
    const options = {
      initialBatchQuestionCounts: [10],
      concurrency: 2,
      requestTimeoutMs: 60_000,
      minimumTimeoutMs: 180_000,
    };

    expect(computeNvidiaRequestBudget(options)).toEqual({
      structuralRequests: 19,
      leafRetryRequests: 20,
      rootTimeoutRetryRequests: 1,
      totalRequests: 40,
    });
    // 40 requests and 21 bounded backoffs at the maximum 8-second backoff,
    // divided across two workers, plus the longest dependency chain.
    expect(computeNvidiaOverallTimeoutMs(options)).toBe(1_502_000);
  });

  it('budgets the complete bounded workload for sixty-four questions', () => {
    const options = {
      initialBatchQuestionCounts: [10, 10, 10, 10, 10, 10, 4],
      concurrency: 2,
      requestTimeoutMs: 60_000,
      minimumTimeoutMs: 180_000,
    };

    expect(computeNvidiaRequestBudget(options)).toEqual({
      structuralRequests: 121,
      leafRetryRequests: 128,
      rootTimeoutRetryRequests: 7,
      totalRequests: 256,
    });
    // Total request and backoff work divided across two workers, plus the
    // longest dependency chain.
    expect(computeNvidiaOverallTimeoutMs(options)).toBe(8_438_000);
  });

  it('includes leaf retries and timeout-triggered root retries', () => {
    const options = {
      initialBatchQuestionCounts: [10],
      concurrency: 2,
      requestTimeoutMs: 60_000,
      minimumTimeoutMs: 180_000,
    };

    expect(
      computeNvidiaRequestBudget({ ...options, maxAttempts: 1 })
    ).toMatchObject({ leafRetryRequests: 0, rootTimeoutRetryRequests: 0 });
    expect(
      computeNvidiaRequestBudget({ ...options, maxAttempts: 3 })
    ).toMatchObject({ leafRetryRequests: 20, rootTimeoutRetryRequests: 1 });
  });

  it('reflects concurrency and backoff in the overall deadline', () => {
    const options = {
      initialBatchQuestionCounts: [10],
      requestTimeoutMs: 60_000,
      minimumTimeoutMs: 180_000,
    };
    expect(computeNvidiaOverallTimeoutMs({ ...options, concurrency: 2 })).toBe(
      1_502_000
    );
    expect(computeNvidiaOverallTimeoutMs({ ...options, concurrency: 1 })).toBe(
      2_568_000
    );
    expect(
      computeNvidiaOverallTimeoutMs({
        ...options,
        concurrency: 2,
        maxBackoffMs: 0,
      })
    ).toBe(1_410_000);
  });

  it('does not truncate large workloads at the previous ten-minute cap', () => {
    expect(
      computeNvidiaOverallTimeoutMs({
        initialBatchQuestionCounts: [10, 10, 10, 10, 10, 10, 4],
        concurrency: 2,
        requestTimeoutMs: 60_000,
        minimumTimeoutMs: 180_000,
      })
    ).toBeGreaterThan(600_000);
  });

  it('merges successful completed outcomes at a batch deadline without duplicates', () => {
    const request = makeRequest(3);
    const batches = planNvidiaBatches(request);
    const results = new Map<
      string,
      ReturnType<typeof generatedResponse>['results'][number]
    >();
    results.set('q-1', {
      questionId: 'q-1',
      status: 'GENERATED',
      answer: { questionId: 'q-1', value: 'B' },
    });

    const merged = mergeNvidiaDeadlineResults(
      [
        {
          ok: true,
          batch: batches[0],
          response: {
            cycleId: request.cycleId,
            results: [
              {
                questionId: 'q-1',
                status: 'GENERATED',
                answer: { questionId: 'q-1', value: 'A' },
              },
              {
                questionId: 'q-2',
                status: 'GENERATED',
                answer: { questionId: 'q-2', value: 'A' },
              },
              {
                questionId: 'q-3',
                status: 'GENERATION_FAILED',
                answer: null,
                failure: { code: 'TIMEOUT', message: 'Provider timed out.' },
              },
            ],
          },
        },
        {
          ok: false,
          batch: batches[0],
          error: new NvidiaProviderError('TIMEOUT'),
          metadata: {
            batchIndex: 0,
            questionIds: ['q-1', 'q-2', 'q-3'],
            safeCode: 'TIMEOUT',
            category: 'TIMEOUT',
            retryable: true,
            message: 'Provider request timed out.',
          },
        },
      ],
      results
    );

    expect(merged.map((result) => result.questionId)).toEqual(['q-2']);
    expect(results.get('q-1')).toMatchObject({ answer: { value: 'B' } });
    expect(results.get('q-2')).toMatchObject({ status: 'GENERATED' });
    expect(results.has('q-3')).toBe(false);
  });
});

describe('NVIDIA batch response assembly', () => {
  it('keeps successful results and fills missing results in order', () => {
    const request = makeRequest(3);
    const batches = planNvidiaBatches(request);
    const response = assembleNvidiaBatchResponse(
      request,
      [
        {
          ok: true,
          batch: batches[0],
          response: {
            cycleId: request.cycleId,
            results: [
              {
                questionId: 'q-2',
                status: 'GENERATED',
                answer: { questionId: 'q-2', value: 'A' },
              },
              {
                questionId: 'q-2',
                status: 'GENERATED',
                answer: { questionId: 'q-2', value: 'B' },
              },
            ],
          },
        },
      ],
      () => ({ code: 'BATCH_FAILED', message: 'Batch failed.' })
    );

    expect(response.cycleId).toBe(request.cycleId);
    expect(response.results).toEqual([
      {
        questionId: 'q-1',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: { code: 'BATCH_FAILED', message: 'Batch failed.' },
      },
      {
        questionId: 'q-2',
        status: 'GENERATED',
        answer: { questionId: 'q-2', value: 'A' },
      },
      {
        questionId: 'q-3',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: { code: 'BATCH_FAILED', message: 'Batch failed.' },
      },
    ]);
  });
});
