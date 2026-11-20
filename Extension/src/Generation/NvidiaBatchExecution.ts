import {
  isProviderSafeMessageCode,
  type GenerationRequest,
  type GenerationResponse,
  type ProviderErrorCode,
  type ProviderSafeMessageCode,
} from './Contract';
import {
  NVIDIA_PROVIDER_ID,
  NVIDIA_SERVER_BUSY_MESSAGE,
} from './ProviderIdentity';
import {
  createNvidiaBatchRequest,
  type NvidiaQuestionBatch,
} from './NvidiaBatchPlanning';
import {
  elapsedSince,
  monotonicNow,
  type GenerationPerformanceRecorder,
} from '../Shared/Performance';

export const NVIDIA_BATCH_CONCURRENCY = 2;

export type NvidiaBatchFailureCategory =
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'INVALID_REQUEST'
  | 'RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK'
  | 'PROVIDER_FAILURE';

export interface NvidiaBatchFailureMetadata {
  readonly batchIndex: number;
  readonly questionIds: readonly string[];
  readonly safeCode: ProviderErrorCode;
  readonly safeMessageCode?: ProviderSafeMessageCode;
  readonly providerId?: string;
  readonly category: NvidiaBatchFailureCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly httpStatus?: number | null;
  readonly retryAfterMs?: number | null;
}

export interface NvidiaBatchSuccess {
  readonly ok: true;
  readonly batch: NvidiaQuestionBatch;
  readonly response: GenerationResponse;
}

export interface NvidiaBatchFailure {
  readonly ok: false;
  readonly batch: NvidiaQuestionBatch;
  readonly error: unknown;
  readonly metadata: NvidiaBatchFailureMetadata;
}

export type NvidiaBatchOutcome = NvidiaBatchSuccess | NvidiaBatchFailure;

export class NvidiaBatchCancellationError extends Error {
  constructor() {
    super('NVIDIA batch generation was cancelled.');
    this.name = 'NvidiaBatchCancellationError';
  }
}

export class NvidiaBatchDeadlineError extends Error {
  constructor(
    public readonly completedOutcomes: readonly NvidiaBatchOutcome[]
  ) {
    super('NVIDIA batch generation exceeded its overall deadline.');
    this.name = 'NvidiaBatchDeadlineError';
  }
}

export type NvidiaBatchRunner = (
  request: GenerationRequest,
  signal?: AbortSignal
) => Promise<GenerationResponse>;

export interface NvidiaBatchPerformanceMetadata {
  readonly waveIndex: number;
  readonly attempt: number;
  readonly splitDepth: number;
}

export interface NvidiaBatchExecutionOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly overallTimeoutMs?: number;
  readonly performance?: GenerationPerformanceRecorder;
  readonly batchMetadata?: ReadonlyMap<number, NvidiaBatchPerformanceMetadata>;
}

export type NvidiaRecoveryDisposition = 'RETRY' | 'SPLIT' | 'NONE';

export interface NvidiaFailureDetails {
  readonly category: NvidiaBatchFailureCategory;
  /** True only when resending can plausibly change the outcome. Never null. */
  readonly retryable: boolean;
  /** How recovery should act: resend, narrow structurally, or stop. */
  readonly disposition: NvidiaRecoveryDisposition;
  readonly message: string;
}

export const NVIDIA_FAILURE_DETAILS: Record<
  ProviderErrorCode,
  NvidiaFailureDetails
> = {
  AUTHENTICATION_FAILED: {
    category: 'AUTHENTICATION',
    retryable: false,
    disposition: 'NONE',
    message: 'Credential invalid.',
  },
  PERMISSION_DENIED: {
    category: 'PERMISSION',
    retryable: false,
    disposition: 'NONE',
    message: 'Provider access denied.',
  },
  INVALID_REQUEST: {
    category: 'INVALID_REQUEST',
    retryable: false,
    disposition: 'NONE',
    message: 'Provider request was invalid.',
  },
  RATE_LIMITED: {
    category: 'RATE_LIMIT',
    retryable: true,
    disposition: 'RETRY',
    message: 'Provider rate limit reached.',
  },
  PROVIDER_UNAVAILABLE: {
    category: 'PROVIDER_UNAVAILABLE',
    retryable: true,
    disposition: 'RETRY',
    message: 'Provider unavailable.',
  },
  TIMEOUT: {
    category: 'TIMEOUT',
    retryable: true,
    disposition: 'RETRY',
    message: 'Provider request timed out.',
  },
  // Truncated or malformed output is recoverable, but only by narrowing the
  // request: the same batch is likely to fail the same way again.
  INCOMPLETE_PROVIDER_RESPONSE: {
    category: 'MALFORMED_RESPONSE',
    retryable: true,
    disposition: 'SPLIT',
    message: 'NVIDIA response was truncated before completion.',
  },
  MALFORMED_PROVIDER_RESPONSE: {
    category: 'MALFORMED_RESPONSE',
    retryable: true,
    disposition: 'SPLIT',
    message: 'Provider returned an invalid response.',
  },
  NETWORK_FAILURE: {
    category: 'NETWORK',
    retryable: true,
    disposition: 'RETRY',
    message: 'Provider network request failed.',
  },
  PROVIDER_FAILURE: {
    category: 'PROVIDER_FAILURE',
    retryable: false,
    disposition: 'NONE',
    message: 'Provider request failed.',
  },
};

export function isNvidiaProviderErrorCode(
  value: unknown
): value is ProviderErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(NVIDIA_FAILURE_DETAILS, value)
  );
}

export function nvidiaFailureDetails(
  code: ProviderErrorCode
): NvidiaFailureDetails {
  return NVIDIA_FAILURE_DETAILS[code];
}

function safeFailureMetadata(
  batch: NvidiaQuestionBatch,
  error: unknown
): NvidiaBatchFailureMetadata {
  const safeCode =
    typeof error === 'object' &&
    error !== null &&
    'safeCode' in error &&
    isNvidiaProviderErrorCode(error.safeCode)
      ? error.safeCode
      : 'PROVIDER_FAILURE';
  const details = nvidiaFailureDetails(safeCode);
  const safeMessageCode =
    typeof error === 'object' &&
    error !== null &&
    'safeMessageCode' in error &&
    isProviderSafeMessageCode(error.safeMessageCode)
      ? error.safeMessageCode
      : undefined;
  const providerId =
    typeof error === 'object' &&
    error !== null &&
    'providerId' in error &&
    error.providerId === NVIDIA_PROVIDER_ID
      ? NVIDIA_PROVIDER_ID
      : undefined;
  const serverBusy =
    safeCode === 'PROVIDER_UNAVAILABLE' &&
    safeMessageCode === 'SERVER_BUSY' &&
    providerId === NVIDIA_PROVIDER_ID;
  const diagnostics =
    typeof error === 'object' &&
    error !== null &&
    'diagnostics' in error &&
    typeof error.diagnostics === 'object' &&
    error.diagnostics !== null
      ? (error.diagnostics as Record<string, unknown>)
      : null;
  const httpStatus =
    typeof diagnostics?.httpStatus === 'number' &&
    Number.isSafeInteger(diagnostics.httpStatus)
      ? diagnostics.httpStatus
      : null;
  const retryAfterMs =
    typeof diagnostics?.retryAfterMs === 'number' &&
    Number.isFinite(diagnostics.retryAfterMs) &&
    diagnostics.retryAfterMs >= 0
      ? diagnostics.retryAfterMs
      : null;
  return {
    batchIndex: batch.index,
    questionIds: batch.questions.map((question) => question.questionId),
    safeCode,
    ...(serverBusy
      ? { safeMessageCode: 'SERVER_BUSY' as const, providerId }
      : {}),
    category: details.category,
    retryable: details.retryable,
    message: serverBusy ? NVIDIA_SERVER_BUSY_MESSAGE : details.message,
    ...(httpStatus !== null ? { httpStatus } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  };
}

function resolveConcurrency(
  value: number | undefined,
  batchCount: number
): number {
  const requested =
    value !== undefined && Number.isFinite(value)
      ? Math.floor(value)
      : NVIDIA_BATCH_CONCURRENCY;
  return Math.min(Math.max(1, requested), batchCount, NVIDIA_BATCH_CONCURRENCY);
}

function resolveOverallTimeout(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : null;
}

export async function executeNvidiaBatches(
  request: GenerationRequest,
  batches: readonly NvidiaQuestionBatch[],
  runBatch: NvidiaBatchRunner,
  options: NvidiaBatchExecutionOptions = {}
): Promise<readonly NvidiaBatchOutcome[]> {
  if (batches.length === 0) {
    return [];
  }
  if (options.signal?.aborted) {
    throw new NvidiaBatchCancellationError();
  }

  const outcomes = new Array<NvidiaBatchOutcome | undefined>(batches.length);
  const controller = new AbortController();
  const overallTimeoutMs = resolveOverallTimeout(options.overallTimeoutMs);
  const executionStartedAt = options.performance ? monotonicNow() : 0;
  let nextIndex = 0;
  let activeCount = 0;
  let startedCount = 0;
  let cancelled = false;
  let deadlineExpired = false;

  const abortFromCaller = () => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const deadlineTimer =
    overallTimeoutMs === null
      ? undefined
      : setTimeout(() => {
          deadlineExpired = true;
          controller.abort();
        }, overallTimeoutMs);

  const worker = async () => {
    while (true) {
      if (cancelled || deadlineExpired) {
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) {
        return;
      }

      const batch = batches[index];
      const batchStartedAt = options.performance ? monotonicNow() : 0;
      activeCount += 1;
      startedCount += 1;
      const activeConcurrency = activeCount;
      const queuedBatches = Math.max(0, batches.length - nextIndex);
      const queueWaitMs = options.performance
        ? elapsedSince(executionStartedAt, batchStartedAt)
        : 0;
      const metadata = options.batchMetadata?.get(batch.index);
      options.performance?.observeConcurrency(activeConcurrency, queuedBatches);
      try {
        const response = await runBatch(
          createNvidiaBatchRequest(request, batch),
          controller.signal
        );
        if (cancelled || deadlineExpired) {
          options.performance?.recordBatch({
            batchIndex: batch.index,
            batchCount: batches.length,
            questionCount: batch.questions.length,
            estimatedInputTokens: batch.estimatedInputTokens,
            estimatedOutputTokens: batch.estimatedOutputTokens,
            waveIndex: metadata?.waveIndex ?? 0,
            attempt: metadata?.attempt ?? null,
            splitDepth: metadata?.splitDepth ?? 0,
            queueWaitMs,
            requestStartedAtMs: queueWaitMs,
            requestDurationMs: elapsedSince(batchStartedAt),
            totalBatchDurationMs: elapsedSince(batchStartedAt),
            outcome: deadlineExpired ? 'DEADLINE' : 'CANCELLED',
            failureCategory: null,
            activeConcurrency,
            queuedBatches,
            modelId: null,
            usage: null,
          });
          return;
        }
        outcomes[index] = { ok: true, batch, response };
        options.performance?.recordBatch({
          batchIndex: batch.index,
          batchCount: batches.length,
          questionCount: batch.questions.length,
          estimatedInputTokens: batch.estimatedInputTokens,
          estimatedOutputTokens: batch.estimatedOutputTokens,
          waveIndex: metadata?.waveIndex ?? 0,
          attempt: metadata?.attempt ?? null,
          splitDepth: metadata?.splitDepth ?? 0,
          queueWaitMs,
          requestStartedAtMs: queueWaitMs,
          requestDurationMs: elapsedSince(batchStartedAt),
          totalBatchDurationMs: queueWaitMs + elapsedSince(batchStartedAt),
          outcome: 'SUCCESS',
          failureCategory: null,
          activeConcurrency,
          queuedBatches,
          modelId: null,
          usage: null,
        });
      } catch (error) {
        if (cancelled || deadlineExpired || controller.signal.aborted) {
          options.performance?.recordBatch({
            batchIndex: batch.index,
            batchCount: batches.length,
            questionCount: batch.questions.length,
            estimatedInputTokens: batch.estimatedInputTokens,
            estimatedOutputTokens: batch.estimatedOutputTokens,
            waveIndex: metadata?.waveIndex ?? 0,
            attempt: metadata?.attempt ?? null,
            splitDepth: metadata?.splitDepth ?? 0,
            queueWaitMs,
            requestStartedAtMs: queueWaitMs,
            requestDurationMs: elapsedSince(batchStartedAt),
            totalBatchDurationMs: queueWaitMs + elapsedSince(batchStartedAt),
            outcome: deadlineExpired ? 'DEADLINE' : 'CANCELLED',
            failureCategory: null,
            activeConcurrency,
            queuedBatches,
            modelId: null,
            usage: null,
          });
          return;
        }
        const failure = safeFailureMetadata(batch, error);
        outcomes[index] = {
          ok: false,
          batch,
          error,
          metadata: failure,
        };
        options.performance?.recordBatch({
          batchIndex: batch.index,
          batchCount: batches.length,
          questionCount: batch.questions.length,
          estimatedInputTokens: batch.estimatedInputTokens,
          estimatedOutputTokens: batch.estimatedOutputTokens,
          waveIndex: metadata?.waveIndex ?? 0,
          attempt: metadata?.attempt ?? null,
          splitDepth: metadata?.splitDepth ?? 0,
          queueWaitMs,
          requestStartedAtMs: queueWaitMs,
          requestDurationMs: elapsedSince(batchStartedAt),
          totalBatchDurationMs: queueWaitMs + elapsedSince(batchStartedAt),
          outcome: 'FAILURE',
          failureCategory: failure.category,
          activeConcurrency,
          queuedBatches,
          modelId: null,
          usage: null,
        });
      } finally {
        activeCount -= 1;
      }
    }
  };

  const workerCount = resolveConcurrency(options.concurrency, batches.length);
  options.performance?.setCount('configuredBatchConcurrency', workerCount);
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    options.signal?.removeEventListener('abort', abortFromCaller);
    options.performance?.addCount('batchStartedCount', startedCount);
    options.performance?.addCount(
      'batchNotStartedCount',
      batches.length - startedCount
    );
    options.performance?.addPhase(
      'batchWaveExecutionMs',
      elapsedSince(executionStartedAt)
    );
  }

  const completedOutcomes = outcomes.filter(
    (outcome): outcome is NvidiaBatchOutcome => outcome !== undefined
  );
  if (cancelled || options.signal?.aborted) {
    throw new NvidiaBatchCancellationError();
  }
  if (deadlineExpired) {
    throw new NvidiaBatchDeadlineError(completedOutcomes);
  }
  if (completedOutcomes.length !== batches.length) {
    throw new NvidiaBatchCancellationError();
  }

  return completedOutcomes;
}
