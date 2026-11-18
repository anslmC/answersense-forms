import { describe, expect, it, vi } from 'vitest';
import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { executeNvidiaBatches } from '../src/Generation/NvidiaBatchExecution';
import {
  planNvidiaBatches,
  type NvidiaQuestionBatch,
} from '../src/Generation/NvidiaBatchPlanning';
import { NvidiaProvider } from '../src/Generation/NvidiaProvider';
import { executeNvidiaRecovery } from '../src/Generation/NvidiaRecovery';
import {
  GenerationPerformanceRecorder,
  attachPerformanceToError,
  elapsedSince,
  monotonicNow,
  readPerformanceReport,
} from '../src/Shared/Performance';

function makeQuestion(index: number): GenerationQuestion {
  return {
    questionId: `q-${index}`,
    text: `Private question ${index}`,
    type: 'single-choice',
    required: true,
    options: ['A', 'B', 'C'],
  };
}

function makeRequest(count: number): GenerationRequest {
  return {
    cycleId: 'performance-cycle',
    pageId: 'performance-page',
    questions: Array.from({ length: count }, (_, index) =>
      makeQuestion(index + 1)
    ),
    settledContext: [],
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
    id: 'performance-completion',
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

function successfulFetch() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const request = JSON.parse(
      payload.messages[1].content
    ) as GenerationRequest;
    return new Response(
      JSON.stringify(completion(JSON.stringify(generatedResponse(request)))),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });
}

describe('GenerationPerformanceRecorder', () => {
  it('records phases, counts, browser events, and exposes measurements', () => {
    const performance = new GenerationPerformanceRecorder(
      'cycle-1',
      'CONTENT',
      100
    );

    expect(performance.hasMeasurements).toBe(false);
    performance.addPhase('preflightMs', 12.4);
    performance.addPhase('preflightMs', 2.6);
    performance.addCount('questionCount', 3);
    performance.observeConcurrency(2, 4);
    performance.recordBrowser({
      phase: 'fill',
      durationMs: 8,
      questionCount: 3,
      filledCount: 2,
      failedCount: 1,
      attemptCount: null,
    });
    performance.finish('SUCCESS');

    const report = performance.getReport();
    expect(performance.hasMeasurements).toBe(true);
    expect(report.correlationId).toBe('cycle-1');
    expect(report.context).toBe('CONTENT');
    expect(report.outcome).toBe('SUCCESS');
    expect(report.phases.preflightMs).toBe(15);
    expect(report.counts.questionCount).toBe(3);
    expect(report.counts.maxObservedConcurrency).toBe(2);
    expect(report.counts.maxQueuedBatches).toBe(4);
    expect(report.browser).toEqual([
      {
        phase: 'fill',
        durationMs: 8,
        questionCount: 3,
        filledCount: 2,
        failedCount: 1,
        attemptCount: null,
      },
    ]);
  });

  it('computes result-processing totals from the recorded phases', () => {
    const performance = new GenerationPerformanceRecorder('cycle-2');
    performance.setResultProcessing({
      responseValidationMs: 5,
      salvageMs: 7,
      assemblyMs: 11,
      strictValidationMs: 13,
      expectedQuestionCount: 4,
      returnedResultCount: 4,
    });

    expect(performance.getReport().resultProcessing).toMatchObject({
      responseValidationMs: 5,
      salvageMs: 7,
      assemblyMs: 11,
      strictValidationMs: 13,
      totalProcessingMs: 36,
      expectedQuestionCount: 4,
      returnedResultCount: 4,
    });
  });

  it('sanitizes correlation ids and supports adopting the cycle id', () => {
    const performance = new GenerationPerformanceRecorder(
      'ui\n\u0000temporary',
      'UI'
    );
    performance.correlate('cycle-\u0007final');
    performance.finish('STALE');

    const report = performance.getReport();
    expect(report.correlationId).toBe('cycle-final');
    expect(report.context).toBe('UI');
    expect(report.outcome).toBe('STALE');
  });

  it('never throws on malformed measurement values', () => {
    const performance = new GenerationPerformanceRecorder('cycle-safe');
    expect(() => {
      performance.addPhase('bad', Number.NaN);
      performance.addPhase('negative', -5);
      performance.addCount('bad-count', Number.POSITIVE_INFINITY);
      performance.recordBrowser({
        phase: 'fill',
        durationMs: Number.NaN,
        questionCount: -1,
        filledCount: Number.NaN,
        failedCount: null,
        attemptCount: null,
      });
    }).not.toThrow();

    const report = performance.getReport();
    expect(report.phases.bad).toBe(0);
    expect(report.phases.negative).toBe(0);
    expect(report.counts['bad-count']).toBeUndefined();
    expect(report.browser[0]).toMatchObject({
      durationMs: 0,
      questionCount: 0,
      filledCount: null,
    });
  });

  it('measures elapsed time monotonically', () => {
    const startedAt = monotonicNow();
    expect(elapsedSince(startedAt, startedAt - 10)).toBe(0);
  });

  it('exposes live elapsed time and freezes an explicit final duration', () => {
    vi.useFakeTimers();
    try {
      const startedAt = monotonicNow();
      const performance = new GenerationPerformanceRecorder(
        'cycle-duration',
        'UI',
        startedAt
      );

      vi.advanceTimersByTime(1_234);
      expect(performance.elapsedMs).toBe(1_234);

      performance.finish('SUCCESS', 987.6);
      vi.advanceTimersByTime(5_000);

      expect(performance.elapsedMs).toBe(6_234);
      expect(performance.getReport().durationMs).toBe(988);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cross-context performance assembly', () => {
  function childReport(): ReturnType<
    GenerationPerformanceRecorder['getReport']
  > {
    const child = new GenerationPerformanceRecorder('cycle-merged', 'CONTENT');
    child.setProvider('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b');
    child.addPhase('fillDurationMs', 25);
    child.recordBatch({
      batchIndex: 0,
      batchCount: 1,
      questionCount: 2,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      waveIndex: 0,
      attempt: 1,
      splitDepth: 0,
      queueWaitMs: 0,
      requestStartedAtMs: 0,
      requestDurationMs: 15,
      totalBatchDurationMs: 15,
      outcome: 'SUCCESS',
      failureCategory: null,
      activeConcurrency: 1,
      queuedBatches: 0,
      modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      usage: null,
    });
    child.finish('SUCCESS', 40);
    return child.getReport();
  }

  it('merges child reports once and adopts their correlation and provider', () => {
    const parent = new GenerationPerformanceRecorder('ui-temporary', 'UI');
    parent.addPhase('uiPhaseMs', 5);
    const child = childReport();

    parent.mergeChildReport(child);
    parent.mergeChildReport(child);
    parent.finish('SUCCESS', 250);

    const report = parent.getReport();
    expect(report.correlationId).toBe('cycle-merged');
    expect(report.durationMs).toBe(250);
    expect(report.outcome).toBe('SUCCESS');
    expect(report.providerId).toBe('nvidia');
    expect(report.modelId).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(report.phases).toMatchObject({
      uiPhaseMs: 5,
      fillDurationMs: 25,
    });
    expect(report.batches).toHaveLength(1);
    expect(report.measurementStatus.batches).toBe('MEASURED');
    expect(report.provider?.context).toBe('CONTENT');
  });

  it('reads and attaches performance to thrown errors', () => {
    const child = childReport();
    const error = attachPerformanceToError(new Error('failed'), child);

    expect(readPerformanceReport(error)).toBe(child);
  });
});

describe('Nvidia batch execution performance instrumentation', () => {
  it('records batch concurrency, queue state, and durations', async () => {
    const request = makeRequest(2);
    const batches: NvidiaQuestionBatch[] = request.questions.map(
      (question, index) => ({
        index,
        questions: [question],
        estimatedInputTokens: 10,
        estimatedOutputTokens: 10,
        serializedBytes: 100,
      })
    );
    const performance = new GenerationPerformanceRecorder(
      'batch-performance',
      'BACKGROUND'
    );

    const outcomes = await executeNvidiaBatches(
      request,
      batches,
      async (batchRequest) => generatedResponse(batchRequest),
      { concurrency: 1, performance }
    );

    const report = performance.getReport();
    expect(outcomes).toHaveLength(2);
    expect(report.batches).toHaveLength(2);
    expect(report.batches.map((batch) => batch.outcome)).toEqual([
      'SUCCESS',
      'SUCCESS',
    ]);
    expect(report.counts.configuredBatchConcurrency).toBe(1);
    expect(report.counts.maxObservedConcurrency).toBe(1);
    expect(report.counts.maxQueuedBatches).toBe(1);
    expect(report.counts.batchStartedCount).toBe(2);
    expect(report.counts.batchNotStartedCount).toBe(0);
    expect(report.phases.batchWaveExecutionMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Nvidia recovery performance instrumentation', () => {
  it('records retries, waves, and recovery summaries', async () => {
    const request = makeRequest(20);
    const batches = planNvidiaBatches(request);
    const performance = new GenerationPerformanceRecorder(
      'recovery-performance',
      'BACKGROUND'
    );

    await executeNvidiaRecovery(
      request,
      batches,
      async (batchRequest) => {
        const response = generatedResponse(batchRequest);
        if (batchRequest.questions[0]?.questionId === 'q-1') {
          return {
            cycleId: response.cycleId,
            results: response.results.slice(0, 9),
          };
        }
        return response;
      },
      {
        concurrency: 1,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        random: () => 0,
        performance,
      }
    );

    const report = performance.getReport();
    if (!report.recovery) {
      throw new Error('Expected a recovery summary.');
    }
    expect(report.recovery.retryCount).toBe(1);
    expect(report.recovery.retryReasons.MISSING_RESULT).toBe(1);
    expect(report.recovery.recoveredCount).toBe(1);
    expect(report.recovery.unresolvedCount).toBe(0);
    expect(report.recovery.initialExecutionMs).toBeGreaterThanOrEqual(0);
    expect(report.recoveryEvents).toEqual([
      expect.objectContaining({
        type: 'RETRY',
        questionCount: 1,
        reason: 'MISSING_RESULT',
      }),
    ]);
    expect(report.counts.recoveryWaveCount).toBe(2);
    expect(report.counts.batchStartedCount).toBe(3);
    expect(report.counts.batchNotStartedCount).toBe(0);
  });
});

describe('NvidiaProvider performance instrumentation', () => {
  it('reports provider, transport, batch, usage, and result metrics', async () => {
    const performance = new GenerationPerformanceRecorder(
      'performance-cycle',
      'BACKGROUND'
    );
    const provider = new NvidiaProvider(
      'secret-key',
      undefined,
      successfulFetch()
    );

    await provider.generate(makeRequest(2), undefined, performance);

    const report = performance.getReport();
    expect(report.outcome).toBe('SUCCESS');
    expect(report.modelId).toContain('nvidia');
    expect(report.counts.expectedQuestionCount).toBe(2);
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]).toMatchObject({
      batchIndex: 0,
      batchCount: 1,
      questionCount: 2,
      attempt: 1,
      outcome: 'SUCCESS',
      activeConcurrency: 1,
      queuedBatches: 0,
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      },
    });
    expect(report.batches[0].modelId).toBe(report.modelId);
    expect(report.transports).toHaveLength(1);
    expect(report.transports[0]).toMatchObject({
      batchIndex: 0,
      httpStatus: 200,
      outcome: 'SUCCESS',
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      },
    });
    expect(report.resultProcessing).toMatchObject({
      expectedQuestionCount: 2,
      returnedResultCount: 2,
      generatedCount: 2,
      abstainedCount: 0,
      failedCount: 0,
    });
    expect(report.resultProcessing.totalProcessingMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toContain('Private question');
    expect(JSON.stringify(report)).not.toContain('secret-key');
  });

  it('records failed transports and a failed provider outcome', async () => {
    const performance = new GenerationPerformanceRecorder(
      'performance-failure',
      'BACKGROUND'
    );
    const fetchMock = vi.fn(
      async () =>
        new Response('provider failure', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        })
    );
    const provider = new NvidiaProvider('secret-key', undefined, fetchMock);

    await expect(
      provider.generate(makeRequest(1), undefined, performance)
    ).rejects.toBeTruthy();

    const report = performance.getReport();
    expect(report.outcome).toBe('FAILURE');
    expect(report.transports[0]).toMatchObject({
      httpStatus: 500,
      outcome: 'FAILURE',
      usage: null,
    });
    expect(report.batches[0]).toMatchObject({
      outcome: 'FAILURE',
      failureCategory: 'PROVIDER_UNAVAILABLE',
    });
  });
});
