import type {
  GenerationRequest,
  GenerationResponse,
  ProviderErrorCode,
} from './Contract';
import {
  createNvidiaBatchRequest,
  type NvidiaQuestionBatch,
} from './NvidiaBatchPlanning';

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
  readonly category: NvidiaBatchFailureCategory;
  readonly retryable: boolean | null;
  readonly message: string;
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

export interface NvidiaBatchExecutionOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly overallTimeoutMs?: number;
}

const FAILURE_DETAILS: Record<
  ProviderErrorCode,
  {
    readonly category: NvidiaBatchFailureCategory;
    readonly retryable: boolean | null;
    readonly message: string;
  }
> = {
  AUTHENTICATION_FAILED: {
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Credential invalid.',
  },
  PERMISSION_DENIED: {
    category: 'PERMISSION',
    retryable: false,
    message: 'Provider access denied.',
  },
  INVALID_REQUEST: {
    category: 'INVALID_REQUEST',
    retryable: false,
    message: 'Provider request was invalid.',
  },
  RATE_LIMITED: {
    category: 'RATE_LIMIT',
    retryable: true,
    message: 'Provider rate limit reached.',
  },
  PROVIDER_UNAVAILABLE: {
    category: 'PROVIDER_UNAVAILABLE',
    retryable: true,
    message: 'Provider unavailable.',
  },
  TIMEOUT: {
    category: 'TIMEOUT',
    retryable: true,
    message: 'Provider request timed out.',
  },
  INCOMPLETE_PROVIDER_RESPONSE: {
    category: 'MALFORMED_RESPONSE',
    retryable: null,
    message: 'NVIDIA response was truncated before completion.',
  },
  MALFORMED_PROVIDER_RESPONSE: {
    category: 'MALFORMED_RESPONSE',
    retryable: null,
    message: 'Provider returned an invalid response.',
  },
  NETWORK_FAILURE: {
    category: 'NETWORK',
    retryable: true,
    message: 'Provider network request failed.',
  },
  PROVIDER_FAILURE: {
    category: 'PROVIDER_FAILURE',
    retryable: null,
    message: 'Provider request failed.',
  },
};

function isSafeProviderCode(value: unknown): value is ProviderErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(FAILURE_DETAILS, value)
  );
}

function safeFailureMetadata(
  batch: NvidiaQuestionBatch,
  error: unknown
): NvidiaBatchFailureMetadata {
  const safeCode =
    typeof error === 'object' &&
    error !== null &&
    'safeCode' in error &&
    isSafeProviderCode(error.safeCode)
      ? error.safeCode
      : 'PROVIDER_FAILURE';
  const details = FAILURE_DETAILS[safeCode];
  return {
    batchIndex: batch.index,
    questionIds: batch.questions.map((question) => question.questionId),
    safeCode,
    category: details.category,
    retryable: details.retryable,
    message: details.message,
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
  let nextIndex = 0;
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
      try {
        const response = await runBatch(
          createNvidiaBatchRequest(request, batch),
          controller.signal
        );
        if (cancelled || deadlineExpired) {
          return;
        }
        outcomes[index] = { ok: true, batch, response };
      } catch (error) {
        if (cancelled || deadlineExpired || controller.signal.aborted) {
          return;
        }
        outcomes[index] = {
          ok: false,
          batch,
          error,
          metadata: safeFailureMetadata(batch, error),
        };
      }
    }
  };

  const workerCount = resolveConcurrency(options.concurrency, batches.length);
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    options.signal?.removeEventListener('abort', abortFromCaller);
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
