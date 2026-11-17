import { describe, expect, it, vi } from 'vitest';
import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResponse,
  GenerationResult,
} from '../src/Generation/Contract';
import { NvidiaBatchCancellationError } from '../src/Generation/NvidiaBatchExecution';
import {
  createNvidiaQuestionBatch,
  planNvidiaBatches,
} from '../src/Generation/NvidiaBatchPlanning';
import {
  NvidiaProvider,
  NvidiaProviderError,
} from '../src/Generation/NvidiaProvider';
import {
  NvidiaRecoveryDeadlineError,
  computeNvidiaRecoveryBackoff,
  executeNvidiaRecovery,
} from '../src/Generation/NvidiaRecovery';
import { parseNvidiaSalvageObjects } from '../src/Generation/NvidiaSalvage';

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

function makeRequest(count: number): GenerationRequest {
  return {
    cycleId: 'recovery-cycle',
    pageId: 'recovery-page',
    questions: Array.from({ length: count }, (_, index) =>
      makeQuestion(index + 1)
    ),
    settledContext: [],
  };
}

function generatedResult(
  questionId: string,
  value: string | string[]
): GenerationResult {
  return {
    questionId,
    status: 'GENERATED',
    answer: { questionId, value },
  };
}

function generatedResponse(request: GenerationRequest): GenerationResponse {
  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) =>
      generatedResult(question.questionId, 'A')
    ),
  };
}

function completion(content: string) {
  return {
    id: 'recovery-completion',
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

function successfulResponse(request: GenerationRequest): Response {
  return new Response(
    JSON.stringify(completion(JSON.stringify(generatedResponse(request)))),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

describe('NVIDIA partial-response salvage', () => {
  it('keeps valid results and reports duplicate, invalid, unknown, and failed results', () => {
    const request = makeRequest(6);
    request.questions[2] = makeQuestion(3, {
      type: 'multiple-choice',
      options: ['A', 'B'],
    });
    const salvage = parseNvidiaSalvageObjects(
      [
        { cycleId: 'other-cycle', results: [] },
        {
          cycleId: request.cycleId,
          results: [
            generatedResult('q-1', 'A'),
            generatedResult('q-1', 'B'),
            generatedResult('q-2', 'Z'),
            generatedResult('q-3', ['A', 'A']),
            {
              questionId: 'q-4',
              status: 'ABSTAINED',
              answer: null,
              reason: 'LOW_CONFIDENCE',
            },
            {
              questionId: 'q-5',
              status: 'GENERATION_FAILED',
              answer: null,
              failure: {
                code: 'RATE_LIMITED',
                message: 'Provider rate limit reached.',
              },
            },
            generatedResult('q-6', 'A'),
            generatedResult('unknown-question', 'A'),
          ],
        },
      ],
      request
    );

    expect(salvage.acceptedQuestionIds).toEqual(['q-1', 'q-4', 'q-6']);
    expect(salvage.failedQuestionIds).toEqual(['q-5']);
    expect(salvage.invalidQuestionIds).toEqual(['q-2', 'q-3']);
    expect(salvage.duplicateQuestionIds).toEqual(['q-1']);
    expect(salvage.unknownQuestionIds).toEqual(['unknown-question']);
    expect(salvage.missingQuestionIds).toEqual([]);
    expect(salvage.candidateCount).toBe(1);
    expect(salvage.hasUsableResult).toBe(true);
    expect(
      salvage.results.map((result) => [result.questionId, result.status])
    ).toEqual([
      ['q-1', 'GENERATED'],
      ['q-4', 'ABSTAINED'],
      ['q-5', 'GENERATION_FAILED'],
      ['q-6', 'GENERATED'],
    ]);
    expect(salvage.results[0]).toEqual(generatedResult('q-1', 'A'));
  });

  it('requires all answer parts before accepting a generated answer', () => {
    const request = makeRequest(1);
    request.questions[0] = makeQuestion(1, {
      type: 'paragraph',
      answerParts: 2,
    });

    const incomplete = parseNvidiaSalvageObjects(
      [
        {
          cycleId: request.cycleId,
          results: [generatedResult('q-1', 'Only one part')],
        },
      ],
      request
    );
    const complete = parseNvidiaSalvageObjects(
      [
        {
          cycleId: request.cycleId,
          results: [generatedResult('q-1', 'First part, second part')],
        },
      ],
      request
    );

    expect(incomplete.hasUsableResult).toBe(false);
    expect(incomplete.invalidQuestionIds).toEqual(['q-1']);
    expect(complete.acceptedQuestionIds).toEqual(['q-1']);
  });
});

describe('NVIDIA recovery orchestration', () => {
  it('retries only unresolved questions after a partial response', async () => {
    const request = makeRequest(20);
    const initialBatches = planNvidiaBatches(request);
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        const ids = batchRequest.questions.map(
          (question) => question.questionId
        );
        calls.push(ids);
        if (ids[0] === 'q-11') {
          return {
            cycleId: request.cycleId,
            results: ids.slice(0, 9).map((id) => generatedResult(id, 'A')),
          };
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        random: () => 0,
      }
    );

    expect(calls.map((ids) => ids.length)).toEqual([10, 10, 1]);
    expect(calls[0]).toEqual(
      request.questions.slice(0, 10).map((question) => question.questionId)
    );
    expect(calls[1]).toEqual(
      request.questions.slice(10).map((question) => question.questionId)
    );
    expect(calls[2]).toEqual(['q-20']);
    expect(response.results.map((result) => result.status)).toEqual(
      Array.from({ length: 20 }, () => 'GENERATED')
    );
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
  });

  it('preserves abstained results instead of retrying them', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        const ids = batchRequest.questions.map(
          (question) => question.questionId
        );
        calls.push(ids);
        if (calls.length === 1) {
          return {
            cycleId: request.cycleId,
            results: [
              {
                questionId: 'q-1',
                status: 'ABSTAINED',
                answer: null,
                reason: 'LOW_CONFIDENCE',
              },
            ],
          };
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls).toEqual([['q-1', 'q-2'], ['q-2']]);
    expect(response.results[0]).toMatchObject({
      questionId: 'q-1',
      status: 'ABSTAINED',
      reason: 'LOW_CONFIDENCE',
    });
    expect(response.results[1]).toMatchObject({
      questionId: 'q-2',
      status: 'GENERATED',
    });
  });

  it('retries a missing question up to the attempt limit without overwriting accepted results', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        calls.push(
          batchRequest.questions.map((question) => question.questionId)
        );
        return calls.length === 1
          ? {
              cycleId: request.cycleId,
              results: [generatedResult('q-1', 'A')],
            }
          : { cycleId: request.cycleId, results: [] };
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        maxAttempts: 3,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls).toEqual([['q-1', 'q-2'], ['q-2'], ['q-2']]);
    expect(response.results[0]).toEqual(generatedResult('q-1', 'A'));
    expect(response.results[1]).toMatchObject({
      questionId: 'q-2',
      status: 'GENERATION_FAILED',
      failure: {
        code: 'MALFORMED_PROVIDER_RESPONSE',
      },
    });
  });

  it('splits structurally malformed batches while preserving order and context', async () => {
    const request = makeRequest(10);
    const settledContext = [
      {
        questionId: 'settled-1',
        questionText: 'Settled question',
        answer: 'A',
      },
    ];
    request.settledContext = settledContext;
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const requests: GenerationRequest[] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        const ids = batchRequest.questions.map(
          (question) => question.questionId
        );
        calls.push(ids);
        requests.push(batchRequest);
        if (ids.length === 10) {
          throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls.map((ids) => ids.length)).toEqual([10, 5, 5]);
    expect(calls[1]).toEqual(
      request.questions.slice(0, 5).map((question) => question.questionId)
    );
    expect(calls[2]).toEqual(
      request.questions.slice(5).map((question) => question.questionId)
    );
    expect(
      requests.every(
        (batchRequest) =>
          batchRequest.pageId === request.pageId &&
          batchRequest.settledContext === request.settledContext
      )
    ).toBe(true);
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
  });

  it('retries a retryable model failure for only that question', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        const ids = batchRequest.questions.map(
          (question) => question.questionId
        );
        calls.push(ids);
        if (calls.length === 1) {
          return {
            cycleId: request.cycleId,
            results: [
              generatedResult('q-2', 'A'),
              {
                questionId: 'q-1',
                status: 'GENERATION_FAILED',
                answer: null,
                failure: {
                  code: 'RATE_LIMITED',
                  message: 'Provider rate limit reached.',
                },
              },
            ],
          };
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls).toEqual([['q-1', 'q-2'], ['q-1']]);
    expect(response.results).toEqual([
      generatedResult('q-1', 'A'),
      generatedResult('q-2', 'A'),
    ]);
  });

  it('retries a timed-out batch once before splitting it', async () => {
    const request = makeRequest(10);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        const ids = batchRequest.questions.map(
          (question) => question.questionId
        );
        calls.push(ids);
        if (ids.length === 10 && calls.length <= 2) {
          throw new NvidiaProviderError('TIMEOUT');
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls.map((ids) => ids.length)).toEqual([10, 10, 5, 5]);
    expect(response.results).toHaveLength(10);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('cancels an in-flight backoff delay', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const controller = new AbortController();
    const runner = vi.fn(async () => {
      throw new NvidiaProviderError('RATE_LIMITED');
    });
    const pending = executeNvidiaRecovery(request, initialBatches, runner, {
      signal: controller.signal,
      concurrency: 1,
      baseBackoffMs: 50,
      maxBackoffMs: 50,
      random: () => 0.5,
    });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toBeInstanceOf(NvidiaBatchCancellationError);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('retries transient network failures before succeeding', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const calls: string[][] = [];
    const runner = vi.fn(
      async (batchRequest: GenerationRequest): Promise<GenerationResponse> => {
        calls.push(
          batchRequest.questions.map((question) => question.questionId)
        );
        if (calls.length === 1) {
          throw new NvidiaProviderError('NETWORK_FAILURE');
        }
        return generatedResponse(batchRequest);
      }
    );

    const response = await executeNvidiaRecovery(
      request,
      initialBatches,
      runner,
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      }
    );

    expect(calls).toEqual([
      ['q-1', 'q-2'],
      ['q-1', 'q-2'],
    ]);
    expect(
      response.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('does not retry fatal authentication failures', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const authenticationError = new NvidiaProviderError(
      'AUTHENTICATION_FAILED'
    );
    const runner = vi.fn(async () => {
      throw authenticationError;
    });

    await expect(
      executeNvidiaRecovery(request, initialBatches, runner, {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      })
    ).rejects.toBe(authenticationError);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects caller cancellation', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn(async (batchRequest: GenerationRequest) =>
      generatedResponse(batchRequest)
    );

    await expect(
      executeNvidiaRecovery(request, initialBatches, runner, {
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(NvidiaBatchCancellationError);
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails with a deadline error and aborts an active attempt', async () => {
    const request = makeRequest(2);
    const initialBatches = [
      createNvidiaQuestionBatch(request, request.questions, 0),
    ];
    const runner = vi.fn(
      async (_batchRequest: GenerationRequest, signal?: AbortSignal) =>
        new Promise<GenerationResponse>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new NvidiaBatchCancellationError()),
            { once: true }
          );
        })
    );

    await expect(
      executeNvidiaRecovery(request, initialBatches, runner, {
        concurrency: 1,
        overallTimeoutMs: 20,
      })
    ).rejects.toBeInstanceOf(NvidiaRecoveryDeadlineError);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('computes capped, jittered exponential backoff', () => {
    expect(computeNvidiaRecoveryBackoff(1, 250, 8_000, () => 0)).toBe(200);
    expect(computeNvidiaRecoveryBackoff(1, 250, 8_000, () => 1)).toBe(300);
    expect(computeNvidiaRecoveryBackoff(5, 250, 8_000, () => 0.5)).toBe(4_000);
    expect(computeNvidiaRecoveryBackoff(8, 250, 1_000, () => 1)).toBe(1_000);
  });
});

describe('NVIDIA provider recovery integration', () => {
  it('salvages successful batches and splits a malformed batch', async () => {
    const request = makeRequest(25);
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit): Promise<Response> => {
        const batchRequest = requestFromBody(init?.body);
        const firstQuestionId = batchRequest.questions[0].questionId;
        if (
          firstQuestionId === 'q-11' &&
          batchRequest.questions.length === 10
        ) {
          return new Response(JSON.stringify(completion('not json')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return successfulResponse(batchRequest);
      }
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      undefined,
      fetchMock
    );

    const response = await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(response.results).toHaveLength(25);
    expect(response.results.map((result) => result.status)).toEqual(
      Array.from({ length: 25 }, () => 'GENERATED')
    );
    expect(response.results.map((result) => result.questionId)).toEqual(
      request.questions.map((question) => question.questionId)
    );
  });

  it('honors Retry-After for a rate-limited batch', async () => {
    const request = makeRequest(11);
    let callCount = 0;
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit): Promise<Response> => {
        callCount += 1;
        if (callCount === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        return successfulResponse(requestFromBody(init?.body));
      }
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      undefined,
      fetchMock
    );

    const response = await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.results.map((result) => result.status)).toEqual(
      Array.from({ length: 11 }, () => 'GENERATED')
    );
  });
});
