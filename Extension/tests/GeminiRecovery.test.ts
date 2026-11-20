import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
  type GenerationQuestion,
  type GenerationRequest,
  type GenerationResult,
} from '../src/Generation/Contract';
import {
  GEMINI_35_FLASH_LITE_MODEL,
  GEMINI_MODEL,
  GEMINI_REQUEST_TIMEOUT_MS,
  GeminiProvider,
  type GeminiTransport,
} from '../src/Generation/GeminiProvider';
import {
  GeminiRecoveryCancelledError,
  GeminiRecoveryDeadlineError,
  computeGeminiRecoveryBackoff,
  executeGeminiRecovery,
  type GeminiAttemptOutcome,
  type GeminiAttemptRunner,
  type GeminiRecoveryDisposition,
  type GeminiRecoveryOptions,
} from '../src/Generation/GeminiRecovery';

const TEST_KEY = 'test-key';
const FAST_RECOVERY: GeminiRecoveryOptions = {
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  random: () => 0,
  requestTimeoutMs: 1_000,
};

function makeQuestion(
  index: number,
  overrides: Partial<GenerationQuestion> = {}
): GenerationQuestion {
  return {
    questionId: `q-${index}`,
    text: `Question ${index}`,
    type: 'short-text',
    required: false,
    options: [],
    ...overrides,
  };
}

function makeRequest(
  count: number,
  settledContext: GenerationRequest['settledContext'] = []
): GenerationRequest {
  return {
    cycleId: 'cycle-recovery',
    pageId: 'page-recovery',
    questions: Array.from({ length: count }, (_, index) =>
      makeQuestion(index + 1)
    ),
    settledContext,
  };
}

function generatedResult(
  questionId: string,
  value = `answer-${questionId}`
): GenerationResult {
  return {
    questionId,
    status: 'GENERATED',
    answer: { questionId, value },
  };
}

function abstainedResult(questionId: string): GenerationResult {
  return {
    questionId,
    status: 'ABSTAINED',
    answer: null,
    reason: 'LOW_CONFIDENCE',
  };
}

function bodyFor(
  request: GenerationRequest,
  results: readonly GenerationResult[] = request.questions.map((question) =>
    generatedResult(question.questionId)
  )
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  cycleId: request.cycleId,
                  results,
                }),
              },
            ],
          },
        },
      ],
    },
  };
}

function bodyWithText(
  text: string,
  finishReason?: string
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      candidates: [
        {
          ...(finishReason ? { finishReason } : {}),
          content: { parts: [{ text }] },
        },
      ],
    },
  };
}

function requestFromBody(body: unknown): GenerationRequest {
  const payload = body as {
    contents: Array<{ parts: Array<{ text: string }> }>;
  };
  return JSON.parse(payload.contents[0].parts[0].text) as GenerationRequest;
}

function successOutcome(
  results: readonly GenerationResult[]
): GeminiAttemptOutcome {
  return { ok: true, results };
}

function failureOutcome(
  disposition: GeminiRecoveryDisposition = 'RETRY'
): GeminiAttemptOutcome {
  return {
    ok: false,
    error: new Error('provider request failed'),
    failure: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Provider request failed.',
    },
    disposition,
  };
}

function overflowFailureOutcome(): GeminiAttemptOutcome {
  return {
    ok: false,
    error: new Error('context overflow'),
    failure: {
      code: 'INVALID_REQUEST',
      message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
    },
    disposition: 'SPLIT',
    contextOverflow: true,
    overflowKind: 'UNKNOWN',
  };
}

describe('Gemini transport and retry recovery', () => {
  it('retries 503 for both Gemini models', async () => {
    for (const modelId of [GEMINI_MODEL, GEMINI_35_FLASH_LITE_MODEL]) {
      const request = makeRequest(1);
      let calls = 0;
      const transport: GeminiTransport = {
        async generate() {
          calls += 1;
          return calls === 1 ? { status: 503, body: {} } : bodyFor(request);
        },
      };
      const provider = new GeminiProvider(
        TEST_KEY,
        transport,
        modelId,
        FAST_RECOVERY
      );

      const response = await provider.generate(request);

      expect(response.results).toEqual([
        generatedResult(request.questions[0].questionId),
      ]);
      expect(calls).toBe(2);
    }
  });

  it('retries temporary 500, 408, and 504 responses', async () => {
    for (const status of [500, 408, 504]) {
      const request = makeRequest(1);
      let calls = 0;
      const provider = new GeminiProvider(
        TEST_KEY,
        {
          async generate() {
            calls += 1;
            return calls === 1 ? { status, body: {} } : bodyFor(request);
          },
        },
        GEMINI_MODEL,
        FAST_RECOVERY
      );

      await expect(provider.generate(request)).resolves.toMatchObject({
        cycleId: request.cycleId,
      });
      expect(calls).toBe(2);
    }
  });

  it('retries a network interruption', async () => {
    const request = makeRequest(1);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          if (calls === 1) {
            throw new TypeError('fetch failed');
          }
          return bodyFor(request);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).resolves.toMatchObject({
      cycleId: request.cycleId,
    });
    expect(calls).toBe(2);
  });

  it('honors temporary 429 retry guidance instead of full backoff', async () => {
    const request = makeRequest(1);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          if (calls === 1) {
            return {
              status: 429,
              headers: new Headers({ 'Retry-After': '0' }),
              body: { error: { status: 'RESOURCE_EXHAUSTED' } },
            };
          }
          return bodyFor(request);
        },
      },
      GEMINI_MODEL,
      {
        ...FAST_RECOVERY,
        baseBackoffMs: 5_000,
        maxBackoffMs: 5_000,
      }
    );
    const startedAt = Date.now();

    await expect(provider.generate(request)).resolves.toMatchObject({
      cycleId: request.cycleId,
    });
    expect(calls).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('times out while consuming the response body', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () =>
          ({
            status: 200,
            headers: new Headers(),
            json: () => new Promise<unknown>(() => undefined),
          }) as unknown as Response
      );
      vi.stubGlobal('fetch', fetchMock);
      const provider = new GeminiProvider(TEST_KEY, undefined, GEMINI_MODEL, {
        ...FAST_RECOVERY,
        maxExecutions: 1,
      });

      const generation = provider.generate(makeRequest(1));
      const rejection = generation.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(GEMINI_REQUEST_TIMEOUT_MS);

      expect(await rejection).toMatchObject({
        code: 'TIMEOUT',
        safeCode: 'TIMEOUT',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('treats hard quota exhaustion as terminal', async () => {
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          return {
            status: 429,
            body: { error: { status: 'RESOURCE_EXHAUSTED' } },
          };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(makeRequest(1))).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
    expect(calls).toBe(1);
  });

  it('splits question groups after 413 without changing the final order', async () => {
    const request = makeRequest(4);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          return subset.questions.length > 1
            ? { status: 413, body: {} }
            : bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([4, 2, 2, 1, 1, 1, 1]);
    expect(response.results.map((result) => result.questionId)).toEqual([
      'q-1',
      'q-2',
      'q-3',
      'q-4',
    ]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('terminates instead of splitting a single-question context overflow', async () => {
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );
    const request = makeRequest(1, [
      {
        questionId: 'context-1',
        questionText: 'A very large shared context',
        answer: 'Context answer',
      },
    ]);

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('shared context'),
    });
    expect(calls).toBe(1);
  });

  it('does not retry authentication or invalid-request failures', async () => {
    for (const [status, code] of [
      [401, 'AUTHENTICATION_FAILED'],
      [400, 'INVALID_REQUEST'],
    ] as const) {
      let calls = 0;
      const provider = new GeminiProvider(
        TEST_KEY,
        {
          async generate() {
            calls += 1;
            return { status, body: {} };
          },
        },
        GEMINI_MODEL,
        FAST_RECOVERY
      );

      await expect(provider.generate(makeRequest(1))).rejects.toMatchObject({
        code,
      });
      expect(calls).toBe(1);
    }
  });
});

describe('Gemini context overflow recovery', () => {
  const sharedContext: GenerationRequest['settledContext'] = [
    {
      questionId: 'context-1',
      questionText: 'A shared context item',
      answer: 'Context answer',
    },
  ];

  it('splits question-driven 413 responses when smaller groups succeed', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          return subset.questions.length > 1
            ? { status: 413, body: {} }
            : bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([4, 0, 2, 2, 1, 1, 1, 1]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('does not split when the provider identifies a shared-context overflow', async () => {
    const request = makeRequest(4, sharedContext);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          return {
            status: 413,
            body: {
              error: {
                message:
                  'The shared form context exceeds the model input limit.',
              },
            },
          };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('shared context'),
    });
    expect(calls).toBe(1);
  });

  it('stops after a bounded probe when an ambiguous 413 is shared-context driven', async () => {
    const request = makeRequest(8, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
    });
    expect(requestSizes).toEqual([8, 0]);
  });

  it('uses an accurate combined diagnostic when the 413 probe is inconclusive', async () => {
    const request = makeRequest(6, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 0) {
            throw new TypeError('probe network failure');
          }
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
    });
    expect(requestSizes).toEqual([6, 0]);
  });

  it('bounds ambiguous 413 amplification for large requests', async () => {
    const request = makeRequest(20, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          return {
            status: 413,
            body: {
              error: {
                message:
                  'The input token count exceeds the maximum number of tokens allowed.',
              },
            },
          };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(requestSizes).toEqual([20, 0]);
  });

  it('preserves accepted results when another branch reports a shared-context overflow', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 4) {
            return bodyFor(subset, [
              generatedResult('q-1'),
              generatedResult('q-2'),
            ]);
          }
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([4, 2, 0]);
    expect(response.results.slice(0, 2)).toEqual([
      generatedResult('q-1'),
      generatedResult('q-2'),
    ]);
    expect(response.results.slice(2)).toEqual([
      {
        questionId: 'q-3',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: {
          code: 'INVALID_REQUEST',
          message: expect.stringContaining('shared context'),
        },
      },
      {
        questionId: 'q-4',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: {
          code: 'INVALID_REQUEST',
          message: expect.stringContaining('shared context'),
        },
      },
    ]);
  });

  it('treats unrelated terminal probe failures as inconclusive without splitting', async () => {
    const failureCases = [
      { status: 400, body: {} },
      { status: 401, body: {} },
      { status: 403, body: {} },
      { status: 404, body: {} },
      { status: 422, body: {} },
      { status: 402, body: {} },
      {
        status: 429,
        body: {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exhausted.',
          },
        },
      },
      { status: 501, body: {} },
      { status: 503, body: {} },
      { status: 505, body: {} },
      { status: 506, body: {} },
    ];

    for (const failureCase of failureCases) {
      const request = makeRequest(4, sharedContext);
      const requestSizes: number[] = [];
      let calls = 0;
      const provider = new GeminiProvider(
        TEST_KEY,
        {
          async generate({ body }) {
            const subset = requestFromBody(body);
            requestSizes.push(subset.questions.length);
            calls += 1;
            if (calls === 1) {
              return { status: 413, body: {} };
            }
            return failureCase;
          },
        },
        GEMINI_MODEL,
        FAST_RECOVERY
      );

      await expect(provider.generate(request)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
      });
      expect(requestSizes).toEqual([4, 0]);
    }
  });

  it('treats a malformed 2xx probe response as inconclusive without splitting', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 0) {
            return bodyWithText('{malformed');
          }
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
    });
    expect(requestSizes).toEqual([4, 0]);
  });

  it('treats an unsafe 2xx probe response as inconclusive without splitting', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 0) {
            return bodyWithText(
              JSON.stringify({
                cycleId: request.cycleId,
                results: [],
                echo: TEST_KEY,
              })
            );
          }
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
    });
    expect(requestSizes).toEqual([4, 0]);
  });

  it('treats an accepted empty 2xx probe as question-payload overflow', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          calls += 1;
          if (calls === 1) {
            return { status: 413, body: {} };
          }
          return bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([4, 0, 2, 2]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('reuses one diagnostic probe across multiple ambiguous groups', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 4) {
            return { status: 413, body: {} };
          }
          if (subset.questions.length === 0) {
            return bodyFor(subset);
          }
          if (subset.questions.length === 2) {
            return { status: 413, body: {} };
          }
          return bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes.filter((size) => size === 0)).toHaveLength(1);
    expect(requestSizes).toEqual([4, 0, 2, 2, 1, 1, 1, 1]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('preserves accepted results when an unrelated probe failure is inconclusive', async () => {
    const request = makeRequest(4, sharedContext);
    const requestSizes: number[] = [];
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          requestSizes.push(subset.questions.length);
          if (subset.questions.length === 4) {
            return bodyFor(subset, [
              generatedResult('q-1'),
              generatedResult('q-2'),
            ]);
          }
          if (subset.questions.length === 0) {
            return { status: 400, body: {} };
          }
          return { status: 413, body: {} };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([4, 2, 0]);
    expect(response.results.slice(0, 2)).toEqual([
      generatedResult('q-1'),
      generatedResult('q-2'),
    ]);
    expect(response.results.slice(2)).toEqual([
      {
        questionId: 'q-3',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: {
          code: 'INVALID_REQUEST',
          message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
        },
      },
      {
        questionId: 'q-4',
        status: 'GENERATION_FAILED',
        answer: null,
        failure: {
          code: 'INVALID_REQUEST',
          message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
        },
      },
    ]);
  });
});

describe('Gemini partial-result salvage and correctness', () => {
  it('preserves partial results and retries only missing questions', async () => {
    const request = makeRequest(3);
    const requestSizes: number[] = [];
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          calls += 1;
          requestSizes.push(subset.questions.length);
          return calls === 1
            ? bodyFor(subset, [generatedResult('q-1'), abstainedResult('q-3')])
            : bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([3, 1]);
    expect(response.results.map((result) => result.questionId)).toEqual([
      'q-1',
      'q-2',
      'q-3',
    ]);
    expect(response.results.map((result) => result.status)).toEqual([
      'GENERATED',
      'GENERATED',
      'ABSTAINED',
    ]);
  });

  it('salvages valid results from malformed, truncated JSON', async () => {
    const request = makeRequest(3);
    let calls = 0;
    const truncatedText =
      `{"cycleId":"${request.cycleId}","results":[` +
      `${JSON.stringify(generatedResult('q-1'))},` +
      `${JSON.stringify(generatedResult('q-2'))}`;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          calls += 1;
          const subset = requestFromBody(body);
          return calls === 1
            ? { status: 200, body: bodyWithText(truncatedText).body }
            : bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(calls).toBe(2);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
    expect(response.results.map((result) => result.questionId)).toEqual([
      'q-1',
      'q-2',
      'q-3',
    ]);
  });

  it('treats finishReason truncation as recoverable and preserves completed results', async () => {
    const request = makeRequest(2);
    const requestSizes: number[] = [];
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          calls += 1;
          requestSizes.push(subset.questions.length);
          if (calls === 1) {
            return {
              status: 200,
              body: bodyWithText(
                JSON.stringify({
                  cycleId: request.cycleId,
                  results: [generatedResult('q-1')],
                }),
                'MAX_TOKENS'
              ).body,
            };
          }
          return bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([2, 1]);
    expect(response.results).toEqual([
      generatedResult('q-1'),
      generatedResult('q-2'),
    ]);
  });

  it('joins all non-thinking text parts before parsing', async () => {
    const request = makeRequest(1);
    const fullText = JSON.stringify({
      cycleId: request.cycleId,
      results: [generatedResult('q-1')],
    });
    const midpoint = Math.floor(fullText.length / 2);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: fullText.slice(0, midpoint) },
                      { text: fullText.slice(midpoint) },
                    ],
                  },
                },
              ],
            },
          };
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(calls).toBe(1);
    expect(response.results).toEqual([generatedResult('q-1')]);
  });

  it('ignores unknown question IDs and retries only valid missing questions', async () => {
    const request = makeRequest(2);
    const requestSizes: number[] = [];
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          calls += 1;
          requestSizes.push(subset.questions.length);
          return calls === 1
            ? bodyFor(subset, [
                generatedResult('q-1'),
                generatedResult('unknown-question'),
              ])
            : bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([2, 1]);
    expect(response.results.map((result) => result.questionId)).toEqual([
      'q-1',
      'q-2',
    ]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('ignores duplicate entries without discarding unrelated valid results', async () => {
    const request = makeRequest(2);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          calls += 1;
          return bodyFor(request, [
            generatedResult('q-1', 'First'),
            generatedResult('q-1', 'Duplicate'),
            generatedResult('q-2'),
          ]);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(calls).toBe(1);
    expect(response.results).toEqual([
      generatedResult('q-1', 'First'),
      generatedResult('q-2'),
    ]);
  });

  it('rejects wrong-cycle and API-key-echo responses without retrying', async () => {
    const request = makeRequest(1);
    let wrongCycleCalls = 0;
    const wrongCycle = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          wrongCycleCalls += 1;
          return bodyFor(request, [generatedResult('q-1')]);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );
    const wrongCycleRequest = { ...request, cycleId: 'different-cycle' };
    await expect(wrongCycle.generate(wrongCycleRequest)).rejects.toMatchObject({
      code: 'MALFORMED_PROVIDER_OUTPUT',
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_GENERATION_RESPONSE' },
    });
    expect(wrongCycleCalls).toBe(1);

    let echoCalls = 0;
    const echo = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          echoCalls += 1;
          return bodyFor(request, [
            {
              questionId: 'q-1',
              status: 'GENERATION_FAILED',
              answer: null,
              failure: { code: 'ECHO', message: TEST_KEY },
            },
          ]);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );
    await expect(echo.generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      safeCode: 'PROVIDER_FAILURE',
      diagnostics: { diagnostic: 'API_KEY_ECHO' },
    });
    expect(echoCalls).toBe(1);
  });

  it('never overwrites an accepted result with a later retry', async () => {
    const request = makeRequest(2);
    const requestSizes: number[] = [];
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          const subset = requestFromBody(body);
          calls += 1;
          requestSizes.push(subset.questions.length);
          if (calls === 1) {
            return bodyFor(subset, [generatedResult('q-1', 'First value')]);
          }
          return bodyFor(subset, [
            generatedResult('q-1', 'Second value'),
            generatedResult('q-2'),
          ]);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(requestSizes).toEqual([2, 1]);
    expect(response.results[0]).toEqual(generatedResult('q-1', 'First value'));
    expect(response.results[1]).toEqual(generatedResult('q-2'));
  });

  it('returns the final results in the original question order', async () => {
    const request = makeRequest(3);
    let calls = 0;
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate({ body }) {
          calls += 1;
          const subset = requestFromBody(body);
          if (calls === 1) {
            return bodyFor(subset, [
              generatedResult('q-3'),
              generatedResult('q-1'),
            ]);
          }
          return bodyFor(subset);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await provider.generate(request);

    expect(response.results.map((result) => result.questionId)).toEqual([
      'q-1',
      'q-2',
      'q-3',
    ]);
  });

  it('recovers model-declared recoverable failures and preserves permanent failures', async () => {
    const recoverableRequest = makeRequest(1);
    let recoverableCalls = 0;
    const recoverable = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          recoverableCalls += 1;
          if (recoverableCalls === 1) {
            return bodyFor(recoverableRequest, [
              {
                questionId: 'q-1',
                status: 'GENERATION_FAILED',
                answer: null,
                failure: {
                  code: 'RATE_LIMITED',
                  message: 'Provider rate limit reached.',
                },
              },
            ]);
          }
          return bodyFor(recoverableRequest);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    await expect(
      recoverable.generate(recoverableRequest)
    ).resolves.toMatchObject({
      results: [generatedResult('q-1')],
    });
    expect(recoverableCalls).toBe(2);

    const permanentRequest = makeRequest(1);
    let permanentCalls = 0;
    const permanent = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          permanentCalls += 1;
          return bodyFor(permanentRequest, [
            {
              questionId: 'q-1',
              status: 'GENERATION_FAILED',
              answer: null,
              failure: {
                code: 'CONTENT_POLICY',
                message: 'Provider rejected this question.',
              },
            },
          ]);
        },
      },
      GEMINI_MODEL,
      FAST_RECOVERY
    );

    const response = await permanent.generate(permanentRequest);
    expect(permanentCalls).toBe(1);
    expect(response.results[0]).toMatchObject({
      status: 'GENERATION_FAILED',
      failure: { code: 'CONTENT_POLICY' },
    });
  });

  it('retains safe diagnostics when every request fails', async () => {
    const provider = new GeminiProvider(
      TEST_KEY,
      {
        async generate() {
          return { status: 503, body: {} };
        },
      },
      GEMINI_MODEL,
      { ...FAST_RECOVERY, maxExecutions: 1 }
    );

    await expect(provider.generate(makeRequest(1))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeCode: 'PROVIDER_UNAVAILABLE',
      diagnostics: {
        diagnostic: 'HTTP_STATUS',
        httpStatus: 503,
        extractionOutcome: 'NOT_ATTEMPTED',
      },
    });
  });
});

describe('Gemini recovery policy and termination', () => {
  it('preserves 42 accepted results and fails only 8 unresolved questions in a 50-question request', async () => {
    const request = makeRequest(50);
    const requestSizes: number[] = [];
    let calls = 0;
    const runner: GeminiAttemptRunner = async (subset) => {
      calls += 1;
      requestSizes.push(subset.questions.length);
      if (calls === 1) {
        const generated = subset.questions
          .slice(0, 37)
          .map((question) => generatedResult(question.questionId));
        const abstained = subset.questions
          .slice(37, 42)
          .map((question) => abstainedResult(question.questionId));
        return successOutcome([...generated, ...abstained]);
      }
      return {
        ok: false,
        error: new Error('terminal provider failure'),
        failure: {
          code: 'PROVIDER_ERROR',
          message: 'Provider request failed.',
        },
        disposition: 'NONE',
      };
    };

    const response = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      requestTimeoutMs: 1_000,
    });

    expect(requestSizes).toEqual([50, 8]);
    expect(response.results).toHaveLength(50);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
    expect(
      response.results.filter((result) => result.status === 'GENERATED')
    ).toHaveLength(37);
    expect(
      response.results.filter((result) => result.status === 'ABSTAINED')
    ).toHaveLength(5);
    expect(
      response.results.filter((result) => result.status === 'GENERATION_FAILED')
    ).toHaveLength(8);
    expect(response.results.slice(42)).toEqual(
      request.questions.slice(42).map((question) => ({
        questionId: question.questionId,
        status: 'GENERATION_FAILED',
        answer: null,
        failure: {
          code: 'PROVIDER_ERROR',
          message: 'Provider request failed.',
        },
      }))
    );
  });

  it('recovers representative request sizes of 1 and 10 questions', async () => {
    for (const count of [1, 10]) {
      const request = makeRequest(count);
      let calls = 0;
      const runner: GeminiAttemptRunner = async (subset) => {
        calls += 1;
        if (calls === 1) {
          return successOutcome(
            subset.questions
              .slice(0, -1)
              .map((question) => generatedResult(question.questionId))
          );
        }
        return successOutcome(
          subset.questions.map((question) =>
            generatedResult(question.questionId)
          )
        );
      };

      const response = await executeGeminiRecovery(request, runner, {
        ...FAST_RECOVERY,
      });

      expect(calls).toBe(2);
      expect(
        response.results.every((result) => result.status === 'GENERATED')
      ).toBe(true);
      expect(response.results).toHaveLength(count);
    }
  });

  it('never exceeds two concurrent attempts and respects split depth', async () => {
    const request = makeRequest(8);
    const depths: number[] = [];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const runner: GeminiAttemptRunner = async (_subset, _signal, meta) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      depths.push(meta.splitDepth);
      await Promise.resolve();
      active -= 1;
      return failureOutcome('SPLIT');
    };

    await expect(
      executeGeminiRecovery(request, runner, {
        ...FAST_RECOVERY,
        maxExecutions: 1,
        maxSplitDepth: 2,
        concurrency: 2,
      })
    ).rejects.toBeInstanceOf(Error);

    expect(calls).toBe(7);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(Math.max(...depths)).toBeLessThanOrEqual(2);
  });

  it('respects the per-group execution limit', async () => {
    const request = makeRequest(1);
    let calls = 0;
    const runner: GeminiAttemptRunner = async () => {
      calls += 1;
      return failureOutcome('RETRY');
    };

    await expect(
      executeGeminiRecovery(request, runner, {
        ...FAST_RECOVERY,
        maxExecutions: 3,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(3);
  });

  it('gives split children a fresh allowance after releasing the parent group', async () => {
    const request = makeRequest(10);
    const executionsByGroup = new Map<string, number>();
    const runner: GeminiAttemptRunner = async (subset, _signal, meta) => {
      const key = `${meta.splitDepth}:${subset.questions
        .map((question) => question.questionId)
        .join(',')}`;
      executionsByGroup.set(key, (executionsByGroup.get(key) ?? 0) + 1);
      return failureOutcome('RETRY');
    };

    const outcome = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      maxSplitDepth: 2,
    }).catch((failure: unknown) => failure);

    expect(outcome).toBeInstanceOf(Error);
    expect([...executionsByGroup.values()].every((count) => count <= 3)).toBe(
      true
    );
    expect(
      executionsByGroup.get('0:q-1,q-2,q-3,q-4,q-5,q-6,q-7,q-8,q-9,q-10')
    ).toBe(2);
    expect(executionsByGroup.get('1:q-1,q-2,q-3,q-4,q-5')).toBe(2);
    expect(executionsByGroup.get('1:q-6,q-7,q-8,q-9,q-10')).toBe(2);
    for (const key of [
      '2:q-1,q-2,q-3',
      '2:q-4,q-5',
      '2:q-6,q-7,q-8',
      '2:q-9,q-10',
    ]) {
      expect(executionsByGroup.get(key)).toBe(3);
    }
  });

  it('bounds a repeated-failure 50-question request across nested splits', async () => {
    const request = makeRequest(50);
    let calls = 0;
    const executionsByGroup = new Map<string, number>();
    const runner: GeminiAttemptRunner = async (subset, _signal, meta) => {
      calls += 1;
      const key = `${meta.splitDepth}:${subset.questions
        .map((question) => question.questionId)
        .join(',')}`;
      executionsByGroup.set(key, (executionsByGroup.get(key) ?? 0) + 1);
      return failureOutcome('RETRY');
    };

    const outcome = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
    }).catch((failure: unknown) => failure);

    expect(outcome).toBeInstanceOf(Error);
    expect([...executionsByGroup.values()].every((count) => count <= 3)).toBe(
      true
    );
    expect(calls).toBeLessThan(500);
  });

  it('reports each task actual attempt in mixed-attempt waves', async () => {
    const request = makeRequest(4);
    const calls: Array<{
      questionIds: readonly string[];
      attempt: number;
      waveIndex: number;
    }> = [];
    const runner: GeminiAttemptRunner = async (subset, _signal, meta) => {
      const questionIds = subset.questions.map(
        (question) => question.questionId
      );
      calls.push({
        questionIds,
        attempt: meta.attempt,
        waveIndex: meta.waveIndex,
      });
      if (questionIds.length === 4) {
        return failureOutcome('SPLIT');
      }
      if (questionIds[0] === 'q-1') {
        return meta.attempt === 1
          ? failureOutcome('RETRY')
          : successOutcome(questionIds.map((id) => generatedResult(id)));
      }
      if (questionIds[0] === 'q-3' && questionIds.length === 2) {
        return failureOutcome('SPLIT');
      }
      return successOutcome(questionIds.map((id) => generatedResult(id)));
    };

    const response = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
    });

    expect(response.results).toEqual(
      request.questions.map((question) => generatedResult(question.questionId))
    );
    const attemptsByWave = new Map<number, number[]>();
    for (const call of calls) {
      const attempts = attemptsByWave.get(call.waveIndex) ?? [];
      attempts.push(call.attempt);
      attemptsByWave.set(call.waveIndex, attempts);
    }
    const mixedWave = [...attemptsByWave.entries()].find(
      ([, attempts]) => attempts.includes(1) && attempts.includes(2)
    );
    expect(mixedWave).toBeDefined();
    const mixedCalls = calls.filter(
      (call) => call.waveIndex === mixedWave?.[0]
    );
    expect(
      mixedCalls.find((call) => call.questionIds[0] === 'q-1')?.attempt
    ).toBe(2);
    expect(
      mixedCalls.find((call) => call.questionIds[0] === 'q-3')?.attempt
    ).toBe(1);
  });

  it('preserves accepted results when the overall deadline expires', async () => {
    const request = makeRequest(3);
    let calls = 0;
    const runner: GeminiAttemptRunner = async (_subset, signal) => {
      calls += 1;
      if (calls === 1) {
        return successOutcome([generatedResult('q-1'), generatedResult('q-2')]);
      }
      return new Promise<GeminiAttemptOutcome>((_resolve, reject) => {
        const abort = () => reject(new Error('deadline'));
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener('abort', abort, { once: true });
        }
      });
    };

    const response = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      deadlineMs: 200,
      requestTimeoutMs: 50,
    });

    expect(calls).toBe(2);
    expect(response.results).toHaveLength(3);
    expect(response.results[0]).toEqual(generatedResult('q-1'));
    expect(response.results[1]).toEqual(generatedResult('q-2'));
    expect(response.results[2]).toMatchObject({
      questionId: 'q-3',
      status: 'GENERATION_FAILED',
      failure: { code: 'TIMEOUT' },
    });
  });

  it('throws a deadline failure that retains unresolved question diagnostics', async () => {
    const request = makeRequest(1);
    const runner: GeminiAttemptRunner = async (_subset, signal) =>
      new Promise<GeminiAttemptOutcome>((_resolve, reject) => {
        const abort = () => reject(new Error('deadline'));
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener('abort', abort, { once: true });
        }
      });

    const error = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      deadlineMs: 80,
      requestTimeoutMs: 10,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GeminiRecoveryDeadlineError);
    expect(
      (error as GeminiRecoveryDeadlineError).unresolvedQuestionIds
    ).toEqual(['q-1']);
  });

  it('returns a deadline failure when the probe rejects after the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest(2, [
        {
          questionId: 'context-1',
          questionText: 'Context',
          answer: 'Answer',
        },
      ]);
      let calls = 0;
      const runner: GeminiAttemptRunner = async (subset, signal) => {
        calls += 1;
        if (subset.questions.length > 0) {
          return overflowFailureOutcome();
        }
        return new Promise<GeminiAttemptOutcome>((_resolve, reject) => {
          const abort = () => reject(new Error('deadline'));
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener('abort', abort, { once: true });
          }
        });
      };

      const generation = executeGeminiRecovery(request, runner, {
        ...FAST_RECOVERY,
        deadlineMs: 200,
        requestTimeoutMs: 50,
      }).catch((failure: unknown) => failure);

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(200);
      const error = await generation;

      expect(error).toBeInstanceOf(GeminiRecoveryDeadlineError);
      expect(
        (error as GeminiRecoveryDeadlineError).unresolvedQuestionIds
      ).toEqual(['q-1', 'q-2']);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start queued work without a full timeout window remaining', async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest(6);
      const calls: string[] = [];
      const releaseWave: Array<() => void> = [];
      let notifyOccupied: () => void = () => undefined;
      const occupied = new Promise<void>((resolve) => {
        notifyOccupied = resolve;
      });

      const runner: GeminiAttemptRunner = (subset) => {
        const ids = subset.questions.map((question) => question.questionId);
        calls.push(ids.join(','));
        if (ids.length === 6) {
          return Promise.resolve(failureOutcome('SPLIT'));
        }
        if (ids.length === 3 && ids[0] === 'q-1') {
          return Promise.resolve(failureOutcome('SPLIT'));
        }
        if (ids.length === 3) {
          return Promise.resolve(failureOutcome('RETRY'));
        }
        if (ids.join(',') === 'q-1,q-2' || ids.join(',') === 'q-3') {
          return new Promise<GeminiAttemptOutcome>((resolve) => {
            releaseWave.push(() =>
              resolve(successOutcome(ids.map((id) => generatedResult(id))))
            );
            if (releaseWave.length === 2) {
              notifyOccupied();
            }
          });
        }
        return Promise.resolve(
          successOutcome(ids.map((id) => generatedResult(id)))
        );
      };

      const generation = executeGeminiRecovery(request, runner, {
        ...FAST_RECOVERY,
        deadlineMs: 10_000,
        requestTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      await occupied;

      expect(calls).toEqual([
        'q-1,q-2,q-3,q-4,q-5,q-6',
        'q-1,q-2,q-3',
        'q-4,q-5,q-6',
        'q-1,q-2',
        'q-3',
      ]);

      await vi.advanceTimersByTimeAsync(9_500);
      for (const release of releaseWave) {
        release();
      }
      await vi.advanceTimersByTimeAsync(0);

      const response = await generation;

      expect(calls).toHaveLength(5);
      expect(
        response.results
          .slice(0, 3)
          .every((result) => result.status === 'GENERATED')
      ).toBe(true);
      expect(
        response.results
          .slice(3)
          .every(
            (result) =>
              result.status === 'GENERATION_FAILED' &&
              result.failure.code === 'TIMEOUT'
          )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes a retry as timed out when backoff cannot fit the deadline', async () => {
    const request = makeRequest(2);
    let calls = 0;
    const runner: GeminiAttemptRunner = async () => {
      calls += 1;
      return {
        ok: false,
        error: new Error('rate limited'),
        failure: { code: 'RATE_LIMITED', message: 'Temporarily unavailable.' },
        disposition: 'RETRY',
        retryAfterMs: 5_000,
      };
    };

    const error = await executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      deadlineMs: 3_000,
      requestTimeoutMs: 1_000,
      maxBackoffMs: 8_000,
    }).catch((failure: unknown) => failure);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(GeminiRecoveryDeadlineError);
    expect(
      (error as GeminiRecoveryDeadlineError).unresolvedQuestionIds
    ).toEqual(['q-1', 'q-2']);
  });

  it('stops immediately on caller cancellation without scheduling a retry', async () => {
    const request = makeRequest(1);
    const controller = new AbortController();
    let calls = 0;
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runner: GeminiAttemptRunner = async (_subset, signal) => {
      calls += 1;
      notifyStarted();
      return new Promise<GeminiAttemptOutcome>((_resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener('abort', abort, { once: true });
        }
      });
    };

    const generation = executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(generation).rejects.toBeInstanceOf(
      GeminiRecoveryCancelledError
    );
    expect(calls).toBe(1);
  });

  it('preserves caller cancellation when the probe is aborted', async () => {
    const request = makeRequest(2, [
      {
        questionId: 'context-1',
        questionText: 'Context',
        answer: 'Answer',
      },
    ]);
    const controller = new AbortController();
    let calls = 0;
    let notifyProbeStarted: () => void = () => undefined;
    const probeStarted = new Promise<void>((resolve) => {
      notifyProbeStarted = resolve;
    });
    const runner: GeminiAttemptRunner = async (subset, signal) => {
      calls += 1;
      if (subset.questions.length > 0) {
        return overflowFailureOutcome();
      }
      notifyProbeStarted();
      return new Promise<GeminiAttemptOutcome>((_resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener('abort', abort, { once: true });
        }
      });
    };

    const generation = executeGeminiRecovery(request, runner, {
      ...FAST_RECOVERY,
      deadlineMs: 10_000,
      requestTimeoutMs: 1_000,
      signal: controller.signal,
    }).catch((failure: unknown) => failure);
    await probeStarted;
    controller.abort();
    const error = await generation;

    expect(error).toBeInstanceOf(GeminiRecoveryCancelledError);
    expect(calls).toBe(2);
  });

  it('keeps exponential backoff bounded with jitter', () => {
    expect(computeGeminiRecoveryBackoff(1, 250, 8_000, () => 0)).toBe(200);
    expect(computeGeminiRecoveryBackoff(1, 250, 8_000, () => 1)).toBe(300);
    expect(computeGeminiRecoveryBackoff(100, 250, 8_000, () => 1)).toBe(8_000);
    expect(computeGeminiRecoveryBackoff(1, 250, 0, () => 1)).toBe(0);
  });
});
