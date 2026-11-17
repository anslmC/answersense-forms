import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResponse,
  GenerationResult,
  ProviderErrorCode,
} from './Contract';
import {
  NVIDIA_BATCH_CONCURRENCY,
  NvidiaBatchCancellationError,
  NvidiaBatchDeadlineError,
  executeNvidiaBatches,
  nvidiaFailureDetails,
  type NvidiaBatchFailure,
  type NvidiaBatchOutcome,
} from './NvidiaBatchExecution';
import {
  DEFAULT_NVIDIA_BATCH_LIMITS,
  createNvidiaQuestionBatch,
  isNvidiaBatchWithinLimits,
  normalizeNvidiaBatchLimits,
  type NvidiaBatchLimits,
  type NvidiaQuestionBatch,
} from './NvidiaBatchPlanning';
import {
  DEFAULT_NVIDIA_MEASUREMENT_PROFILE,
  type NvidiaGenerationRequest,
  type NvidiaPayloadProfile,
} from './NvidiaRequest';
import type { NvidiaBatchFailureDescriptor } from './NvidiaResponseAssembly';
import { nvidiaResultFailureDetails } from './NvidiaSalvage';

export const NVIDIA_RECOVERY_MAX_ATTEMPTS = 3;
export const NVIDIA_RECOVERY_MAX_SPLIT_DEPTH = 3;
export const NVIDIA_RECOVERY_BASE_BACKOFF_MS = 250;
export const NVIDIA_RECOVERY_MAX_BACKOFF_MS = 8_000;

export class NvidiaRecoveryDeadlineError extends Error {
  constructor(
    public readonly acceptedResults: readonly GenerationResult[],
    public readonly unresolvedQuestionIds: readonly string[]
  ) {
    super('NVIDIA generation recovery exceeded its overall deadline.');
    this.name = 'NvidiaRecoveryDeadlineError';
  }
}

export class NvidiaRecoveryExhaustedError extends Error {
  public readonly safeCode: ProviderErrorCode = 'PROVIDER_FAILURE';

  constructor() {
    super(
      'NVIDIA generation recovery failed without a usable provider result.'
    );
    this.name = 'NvidiaRecoveryExhaustedError';
  }
}

export type NvidiaRecoveryRunner = (
  request: NvidiaGenerationRequest,
  signal?: AbortSignal
) => Promise<GenerationResponse>;

export interface NvidiaRecoveryOptions {
  readonly maxAttempts?: number;
  readonly maxSplitDepth?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly overallTimeoutMs?: number;
  readonly limits?: NvidiaBatchLimits;
  readonly payloadProfile?: NvidiaPayloadProfile;
}

interface NormalizedRecoveryOptions {
  readonly maxAttempts: number;
  readonly maxSplitDepth: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly random: () => number;
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number | null;
  readonly limits: NvidiaBatchLimits;
  readonly payloadProfile: NvidiaPayloadProfile;
}

interface RecoveryTask {
  readonly batch: NvidiaQuestionBatch;
  readonly splitDepth: number;
  readonly notBefore: number;
}

type RetryMode = 'RETRY' | 'SPLIT';

const DEFAULT_FAILURE: NvidiaBatchFailureDescriptor = {
  code: 'PROVIDER_FAILURE',
  message: nvidiaFailureDetails('PROVIDER_FAILURE').message,
};

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizeOptions(
  options: NvidiaRecoveryOptions
): NormalizedRecoveryOptions {
  const baseBackoffMs = normalizeNonNegativeInteger(
    options.baseBackoffMs,
    NVIDIA_RECOVERY_BASE_BACKOFF_MS
  );
  const maxBackoffMs = Math.max(
    baseBackoffMs,
    normalizeNonNegativeInteger(
      options.maxBackoffMs,
      NVIDIA_RECOVERY_MAX_BACKOFF_MS
    )
  );
  const overallTimeoutMs =
    options.overallTimeoutMs !== undefined &&
    Number.isFinite(options.overallTimeoutMs) &&
    options.overallTimeoutMs > 0
      ? Math.max(1, Math.floor(options.overallTimeoutMs))
      : null;
  return {
    maxAttempts: normalizePositiveInteger(
      options.maxAttempts,
      NVIDIA_RECOVERY_MAX_ATTEMPTS
    ),
    maxSplitDepth: normalizeNonNegativeInteger(
      options.maxSplitDepth,
      NVIDIA_RECOVERY_MAX_SPLIT_DEPTH
    ),
    baseBackoffMs,
    maxBackoffMs,
    random: options.random ?? Math.random,
    concurrency: Math.min(
      normalizePositiveInteger(options.concurrency, NVIDIA_BATCH_CONCURRENCY),
      NVIDIA_BATCH_CONCURRENCY
    ),
    ...(options.signal ? { signal: options.signal } : {}),
    deadlineAt:
      overallTimeoutMs === null ? null : Date.now() + overallTimeoutMs,
    limits: normalizeNvidiaBatchLimits(
      options.limits ?? DEFAULT_NVIDIA_BATCH_LIMITS
    ),
    payloadProfile:
      options.payloadProfile ?? DEFAULT_NVIDIA_MEASUREMENT_PROFILE,
  };
}

export function computeNvidiaRecoveryBackoff(
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(maxBackoffMs, Math.max(0, Math.round(exponential * jitter)));
}

function questionKey(questions: readonly GenerationQuestion[]): string {
  return questions.map((question) => question.questionId).join('\u0000');
}

function failureDescriptorForCode(
  code: ProviderErrorCode
): NvidiaBatchFailureDescriptor {
  return {
    code,
    message: nvidiaFailureDetails(code).message,
  };
}

function retryAfterMsFor(
  outcome: NvidiaBatchFailure,
  maxBackoffMs: number
): number | null {
  const metadataRetryAfter = outcome.metadata.retryAfterMs;
  if (
    typeof metadataRetryAfter === 'number' &&
    Number.isFinite(metadataRetryAfter) &&
    metadataRetryAfter >= 0
  ) {
    return Math.min(maxBackoffMs, Math.floor(metadataRetryAfter));
  }
  const error = outcome.error;
  const diagnostics =
    typeof error === 'object' &&
    error !== null &&
    'diagnostics' in error &&
    typeof error.diagnostics === 'object' &&
    error.diagnostics !== null
      ? (error.diagnostics as Record<string, unknown>)
      : null;
  return typeof diagnostics?.retryAfterMs === 'number' &&
    Number.isFinite(diagnostics.retryAfterMs) &&
    diagnostics.retryAfterMs >= 0
    ? Math.min(maxBackoffMs, Math.floor(diagnostics.retryAfterMs))
    : null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal.aborted
      ? Promise.reject(new Error('aborted'))
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function executeNvidiaRecovery(
  request: GenerationRequest,
  initialBatches: readonly NvidiaQuestionBatch[],
  runAttempt: NvidiaRecoveryRunner,
  options: NvidiaRecoveryOptions = {}
): Promise<GenerationResponse> {
  const normalized = normalizeOptions(options);
  if (normalized.signal?.aborted) {
    throw new NvidiaBatchCancellationError();
  }
  if (initialBatches.length === 0) {
    return { cycleId: request.cycleId, results: [] };
  }

  const questionById = new Map(
    request.questions.map((question) => [question.questionId, question])
  );
  const results = new Map<string, GenerationResult>();
  const lastFailureById = new Map<string, NvidiaBatchFailureDescriptor>();
  const attempts = new Map<string, number>();
  const timeoutCounts = new Map<string, number>();
  const providerResultIds = new Set<string>();
  const controller = new AbortController();
  let currentConcurrency = normalized.concurrency;
  let transientFailureCount = 0;
  let cancelled = false;
  let deadlineExpired = false;
  let firstError: unknown;
  let nextBatchIndex = initialBatches.reduce(
    (maximum, batch) => Math.max(maximum, batch.index + 1),
    0
  );

  const acceptedResults = () =>
    [...results.values()].filter(
      (result) => result.status === 'GENERATED' || result.status === 'ABSTAINED'
    );
  const unresolvedQuestionIds = () =>
    request.questions.flatMap((question) =>
      results.has(question.questionId) ? [] : [question.questionId]
    );
  const deadlineError = () =>
    new NvidiaRecoveryDeadlineError(acceptedResults(), unresolvedQuestionIds());
  const failureDescriptor = (
    descriptor: NvidiaBatchFailureDescriptor
  ): NvidiaBatchFailureDescriptor => ({ ...descriptor });

  const finalizeQuestion = (questionId: string): void => {
    if (results.has(questionId)) {
      return;
    }
    const descriptor = lastFailureById.get(questionId) ?? DEFAULT_FAILURE;
    results.set(questionId, {
      questionId,
      status: 'GENERATION_FAILED',
      answer: null,
      failure: failureDescriptor(descriptor),
    });
  };

  const isExhausted = (questionId: string): boolean =>
    (attempts.get(questionId) ?? 0) >= normalized.maxAttempts;

  const rememberError = (error: unknown): void => {
    if (firstError === undefined) {
      firstError = error;
    }
  };

  const markAttempt = (questions: readonly GenerationQuestion[]): void => {
    for (const question of questions) {
      attempts.set(
        question.questionId,
        (attempts.get(question.questionId) ?? 0) + 1
      );
    }
  };

  const abortFromCaller = () => {
    cancelled = true;
    controller.abort();
  };
  normalized.signal?.addEventListener('abort', abortFromCaller, {
    once: true,
  });

  if (normalized.deadlineAt !== null && Date.now() >= normalized.deadlineAt) {
    normalized.signal?.removeEventListener('abort', abortFromCaller);
    throw deadlineError();
  }
  const deadlineTimer =
    normalized.deadlineAt === null
      ? undefined
      : setTimeout(
          () => {
            deadlineExpired = true;
            controller.abort();
          },
          Math.max(0, normalized.deadlineAt - Date.now())
        );

  const remainingMs = (): number | undefined => {
    if (normalized.deadlineAt === null) {
      return undefined;
    }
    const remaining = normalized.deadlineAt - Date.now();
    if (remaining <= 0) {
      deadlineExpired = true;
      throw deadlineError();
    }
    return Math.max(1, Math.floor(remaining));
  };

  const pending: RecoveryTask[] = initialBatches.map((batch) => ({
    batch,
    splitDepth: 0,
    notBefore: Date.now(),
  }));

  const enqueueQuestions = (
    questions: readonly GenerationQuestion[],
    splitDepth: number,
    notBefore: number
  ): void => {
    const unresolved = questions.filter(
      (question) => !results.has(question.questionId)
    );
    if (unresolved.length === 0) {
      return;
    }
    const retryable = unresolved.filter((question) => {
      if (isExhausted(question.questionId)) {
        finalizeQuestion(question.questionId);
        return false;
      }
      return true;
    });
    if (retryable.length === 0) {
      return;
    }

    const batch = createNvidiaQuestionBatch(
      request,
      retryable,
      nextBatchIndex,
      { payloadProfile: normalized.payloadProfile }
    );
    if (isNvidiaBatchWithinLimits(batch, normalized.limits)) {
      nextBatchIndex += 1;
      pending.push({ batch, splitDepth, notBefore });
      return;
    }
    if (retryable.length === 1 || splitDepth >= normalized.maxSplitDepth) {
      const descriptor = failureDescriptorForCode('INVALID_REQUEST');
      for (const question of retryable) {
        lastFailureById.set(question.questionId, descriptor);
        finalizeQuestion(question.questionId);
      }
      return;
    }
    const midpoint = Math.ceil(retryable.length / 2);
    enqueueQuestions(retryable.slice(0, midpoint), splitDepth + 1, notBefore);
    enqueueQuestions(retryable.slice(midpoint), splitDepth + 1, notBefore);
  };

  const scheduleRetry = (
    questions: readonly GenerationQuestion[],
    splitDepth: number,
    mode: RetryMode,
    delayMs: number
  ): void => {
    const unresolved = questions.filter(
      (question) => !results.has(question.questionId)
    );
    if (unresolved.length === 0) {
      return;
    }
    const notBefore = Date.now() + Math.max(0, delayMs);
    if (
      mode === 'SPLIT' &&
      unresolved.length > 1 &&
      splitDepth < normalized.maxSplitDepth
    ) {
      const midpoint = Math.ceil(unresolved.length / 2);
      enqueueQuestions(
        unresolved.slice(0, midpoint),
        splitDepth + 1,
        notBefore
      );
      enqueueQuestions(unresolved.slice(midpoint), splitDepth + 1, notBefore);
      return;
    }
    enqueueQuestions(unresolved, splitDepth, notBefore);
  };

  const handleSuccess = (
    task: RecoveryTask,
    response: GenerationResponse
  ): void => {
    const taskIds = new Set(
      task.batch.questions.map((question) => question.questionId)
    );
    for (const result of response.results) {
      if (!taskIds.has(result.questionId)) {
        continue;
      }
      providerResultIds.add(result.questionId);
      if (results.has(result.questionId)) {
        continue;
      }
      if (result.status === 'GENERATED' || result.status === 'ABSTAINED') {
        results.set(result.questionId, result);
        lastFailureById.delete(result.questionId);
        continue;
      }
      const details = nvidiaResultFailureDetails(result);
      const descriptor = {
        code: details.code,
        message: details.message,
      };
      lastFailureById.set(result.questionId, descriptor);
      if (!details.retryable || isExhausted(result.questionId)) {
        results.set(result.questionId, result);
      }
    }

    const unresolved = task.batch.questions.filter(
      (question) => !results.has(question.questionId)
    );
    for (const question of unresolved) {
      if (!lastFailureById.has(question.questionId)) {
        lastFailureById.set(
          question.questionId,
          failureDescriptorForCode('MALFORMED_PROVIDER_RESPONSE')
        );
      }
    }
    scheduleRetry(unresolved, task.splitDepth, 'RETRY', 0);
  };

  const handleFailure = (
    task: RecoveryTask,
    outcome: NvidiaBatchFailure
  ): void => {
    rememberError(outcome.error);
    const descriptor = {
      code: outcome.metadata.safeCode,
      message: outcome.metadata.message,
    };
    const unresolved = task.batch.questions.filter(
      (question) => !results.has(question.questionId)
    );
    for (const question of unresolved) {
      lastFailureById.set(question.questionId, descriptor);
    }
    const retryDelay = computeNvidiaRecoveryBackoff(
      Math.max(
        1,
        ...unresolved.map((question) => attempts.get(question.questionId) ?? 1)
      ),
      normalized.baseBackoffMs,
      normalized.maxBackoffMs,
      normalized.random
    );
    const retryAfter = retryAfterMsFor(outcome, normalized.maxBackoffMs);

    switch (outcome.metadata.category) {
      case 'AUTHENTICATION':
      case 'PERMISSION':
      case 'INVALID_REQUEST':
      case 'PROVIDER_FAILURE':
        for (const question of unresolved) {
          finalizeQuestion(question.questionId);
        }
        return;
      case 'RATE_LIMIT': {
        currentConcurrency = 1;
        scheduleRetry(
          unresolved,
          task.splitDepth,
          'RETRY',
          retryAfter ?? retryDelay
        );
        return;
      }
      case 'TIMEOUT': {
        for (const question of unresolved) {
          timeoutCounts.set(
            question.questionId,
            (timeoutCounts.get(question.questionId) ?? 0) + 1
          );
        }
        const split =
          unresolved.length > 1 &&
          task.splitDepth < normalized.maxSplitDepth &&
          unresolved.some(
            (question) => (timeoutCounts.get(question.questionId) ?? 0) >= 2
          );
        scheduleRetry(
          unresolved,
          task.splitDepth,
          split ? 'SPLIT' : 'RETRY',
          split ? 0 : retryDelay
        );
        return;
      }
      case 'NETWORK':
      case 'PROVIDER_UNAVAILABLE': {
        transientFailureCount += 1;
        if (transientFailureCount >= 2) {
          currentConcurrency = 1;
        }
        scheduleRetry(
          unresolved,
          task.splitDepth,
          'RETRY',
          retryAfter ?? retryDelay
        );
        return;
      }
      case 'MALFORMED_RESPONSE':
        scheduleRetry(unresolved, task.splitDepth, 'SPLIT', 0);
        return;
      default:
        for (const question of unresolved) {
          finalizeQuestion(question.questionId);
        }
    }
  };

  try {
    while (true) {
      if (deadlineExpired) {
        throw deadlineError();
      }
      if (cancelled || normalized.signal?.aborted) {
        throw new NvidiaBatchCancellationError();
      }
      const now = Date.now();
      if (normalized.deadlineAt !== null && now >= normalized.deadlineAt) {
        deadlineExpired = true;
        throw deadlineError();
      }

      const readyIndexes = pending.flatMap((task, index) =>
        task.notBefore <= now ? [index] : []
      );
      if (readyIndexes.length === 0) {
        if (pending.length === 0) {
          break;
        }
        const nextReadyAt = Math.min(...pending.map((task) => task.notBefore));
        try {
          await delay(Math.max(0, nextReadyAt - Date.now()), controller.signal);
        } catch {
          if (deadlineExpired) {
            throw deadlineError();
          }
          if (cancelled || normalized.signal?.aborted) {
            throw new NvidiaBatchCancellationError();
          }
          throw new NvidiaRecoveryExhaustedError();
        }
        continue;
      }

      const waveTasks = readyIndexes.map((index) => pending[index]);
      const readySet = new Set(readyIndexes);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (readySet.has(index)) {
          pending.splice(index, 1);
        }
      }
      const taskByKey = new Map(
        waveTasks.map((task) => [questionKey(task.batch.questions), task])
      );
      const batches = waveTasks.map((task) => task.batch);
      const runner = async (
        batchRequest: GenerationRequest,
        signal?: AbortSignal
      ): Promise<GenerationResponse> => {
        const task = taskByKey.get(questionKey(batchRequest.questions));
        if (task) {
          markAttempt(task.batch.questions);
        }
        return runAttempt(batchRequest as NvidiaGenerationRequest, signal);
      };

      let outcomes: readonly NvidiaBatchOutcome[];
      try {
        outcomes = await executeNvidiaBatches(request, batches, runner, {
          concurrency: currentConcurrency,
          signal: controller.signal,
          overallTimeoutMs: remainingMs(),
        });
      } catch (error) {
        if (error instanceof NvidiaBatchDeadlineError) {
          deadlineExpired = true;
          throw deadlineError();
        }
        if (error instanceof NvidiaBatchCancellationError) {
          if (deadlineExpired) {
            throw deadlineError();
          }
          if (cancelled || normalized.signal?.aborted) {
            throw new NvidiaBatchCancellationError();
          }
        }
        throw error;
      }

      const taskByBatchIndex = new Map(
        waveTasks.map((task) => [task.batch.index, task])
      );
      for (const outcome of outcomes) {
        const task = taskByBatchIndex.get(outcome.batch.index);
        if (!task) {
          continue;
        }
        if (outcome.ok) {
          handleSuccess(task, outcome.response);
        } else {
          handleFailure(task, outcome);
        }
      }
    }
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    normalized.signal?.removeEventListener('abort', abortFromCaller);
  }

  if (deadlineExpired) {
    throw deadlineError();
  }
  if (cancelled || normalized.signal?.aborted) {
    throw new NvidiaBatchCancellationError();
  }
  if (providerResultIds.size === 0) {
    if (firstError !== undefined) {
      throw firstError;
    }
    throw new NvidiaRecoveryExhaustedError();
  }

  for (const question of request.questions) {
    if (
      !results.has(question.questionId) &&
      questionById.has(question.questionId)
    ) {
      finalizeQuestion(question.questionId);
    }
  }

  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) => {
      const result = results.get(question.questionId);
      if (!result) {
        throw new NvidiaRecoveryExhaustedError();
      }
      return result;
    }),
  };
}
