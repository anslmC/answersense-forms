import {
  isProviderSafeMessageCode,
  type GenerationQuestion,
  type GenerationRequest,
  type GenerationResponse,
  type GenerationResult,
  type ProviderErrorCode,
  type ProviderSafeMessageCode,
} from './Contract';
import {
  NVIDIA_BATCH_CONCURRENCY,
  NvidiaBatchCancellationError,
  NvidiaBatchDeadlineError,
  executeNvidiaBatches,
  isNvidiaProviderErrorCode,
  nvidiaFailureDetails,
  type NvidiaBatchFailure,
  type NvidiaBatchOutcome,
} from './NvidiaBatchExecution';
import { NVIDIA_PROVIDER_ID } from './ProviderIdentity';
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
import {
  elapsedSince,
  monotonicNow,
  type GenerationPerformanceRecorder,
} from '../Shared/Performance';

export const NVIDIA_RECOVERY_MAX_ATTEMPTS = 3;
// The 10-question batch cap needs four ceil-halving splits to reach a single
// question: 10 → 5 → 3 → 2 → 1.
export const NVIDIA_RECOVERY_MAX_SPLIT_DEPTH = 4;
export const NVIDIA_RECOVERY_BASE_BACKOFF_MS = 250;
export const NVIDIA_RECOVERY_MAX_BACKOFF_MS = 8_000;
export const NVIDIA_RECOVERY_DEADLINE_MESSAGE =
  'Generation timed out before all answers were produced.';
// The batch executor owns the outcomes that complete inside a wave. Give its
// deadline a one-millisecond head start so it can report those outcomes before
// the outer recovery deadline fires.
const NVIDIA_BATCH_DEADLINE_MARGIN_MS = 1;

export interface NvidiaOverallTimeoutOptions {
  readonly initialBatchQuestionCounts: readonly number[];
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly minimumTimeoutMs: number;
  readonly maxAttempts?: number;
  readonly maxSplitDepth?: number;
  readonly maxBackoffMs?: number;
}

export interface NvidiaRequestBudget {
  readonly structuralRequests: number;
  readonly leafRetryRequests: number;
  readonly rootTimeoutRetryRequests: number;
  readonly totalRequests: number;
}

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function normalizeBudgetInputs(options: NvidiaOverallTimeoutOptions): {
  readonly batchQuestionCounts: readonly number[];
  readonly maxAttempts: number;
  readonly maxSplitDepth: number;
} {
  return {
    batchQuestionCounts: options.initialBatchQuestionCounts.map((count) =>
      finiteFloor(count, 0)
    ),
    maxAttempts: Math.max(
      1,
      finiteFloor(options.maxAttempts ?? NVIDIA_RECOVERY_MAX_ATTEMPTS, 1)
    ),
    maxSplitDepth: finiteFloor(
      options.maxSplitDepth ?? NVIDIA_RECOVERY_MAX_SPLIT_DEPTH,
      0
    ),
  };
}

// A structurally failing batch may narrow through a full binary split tree.
// The request count is the number of nodes in that tree, bounded by the
// configured split depth.
function maxStructuralRequests(
  questionCount: number,
  splitDepth: number,
  maxSplitDepth: number
): number {
  if (questionCount <= 0) {
    return 0;
  }
  if (questionCount === 1 || splitDepth >= maxSplitDepth) {
    return 1;
  }
  const left = Math.ceil(questionCount / 2);
  return (
    1 +
    maxStructuralRequests(left, splitDepth + 1, maxSplitDepth) +
    maxStructuralRequests(questionCount - left, splitDepth + 1, maxSplitDepth)
  );
}

/**
 * Counts the worst-case provider requests for the planned batches. Every
 * question can be charged at most `maxAttempts - 1` retries (splits release
 * the parent attempt), and a timed-out initial batch can retry once at its
 * root before the timeout policy narrows it.
 */
export function computeNvidiaRequestBudget(
  options: NvidiaOverallTimeoutOptions
): NvidiaRequestBudget {
  const { batchQuestionCounts, maxAttempts, maxSplitDepth } =
    normalizeBudgetInputs(options);
  const totalQuestions = batchQuestionCounts.reduce(
    (total, count) => total + count,
    0
  );
  const structuralRequests = batchQuestionCounts.reduce(
    (total, count) => total + maxStructuralRequests(count, 0, maxSplitDepth),
    0
  );
  const leafRetryRequests = totalQuestions * Math.max(0, maxAttempts - 1);
  const rootTimeoutRetryRequests =
    maxAttempts > 1
      ? batchQuestionCounts.filter((count) => count > 0).length
      : 0;
  return {
    structuralRequests,
    leafRetryRequests,
    rootTimeoutRetryRequests,
    totalRequests:
      structuralRequests + leafRetryRequests + rootTimeoutRetryRequests,
  };
}

/**
 * Sizes the overall generation deadline from the bounded request workload.
 * Requests run at the configured concurrency, but split branches are
 * sequential, so the schedule also reserves the longest dependency chain.
 * Retries can wait for up to the configured backoff, and the whole allowance
 * is added to the schedule. The result is finite and is never silently capped
 * below the calculated requirement.
 */
export function computeNvidiaOverallTimeoutMs(
  options: NvidiaOverallTimeoutOptions
): number {
  const concurrency = Math.max(1, finiteFloor(options.concurrency, 1));
  const requestTimeoutMs = Math.max(
    1,
    finiteFloor(options.requestTimeoutMs, 1)
  );
  const minimumTimeoutMs = Math.max(
    1,
    finiteFloor(options.minimumTimeoutMs, 1)
  );
  const maxBackoffMs = Math.max(
    0,
    finiteFloor(options.maxBackoffMs ?? NVIDIA_RECOVERY_MAX_BACKOFF_MS, 0)
  );
  const { maxAttempts, maxSplitDepth } = normalizeBudgetInputs(options);
  const budget = computeNvidiaRequestBudget(options);
  if (budget.totalRequests === 0) {
    return minimumTimeoutMs;
  }

  const retryCount = budget.leafRetryRequests + budget.rootTimeoutRetryRequests;
  const retryAllowancePerPath = Math.max(0, maxAttempts - 1);
  const criticalPathMs =
    (maxSplitDepth + 1) * requestTimeoutMs +
    retryAllowancePerPath * (requestTimeoutMs + maxBackoffMs);
  const totalWorkMs =
    budget.totalRequests * requestTimeoutMs + retryCount * maxBackoffMs;
  const scheduledMs = totalWorkMs + (concurrency - 1) * criticalPathMs;
  const requiredMs = Math.ceil(scheduledMs / concurrency);
  return Math.max(
    minimumTimeoutMs,
    Math.min(Number.MAX_SAFE_INTEGER, requiredMs)
  );
}

/**
 * Merges answers that finished just before a batch deadline fired. Results
 * already accepted by recovery win, and only successful statuses are merged;
 * unresolved questions stay unresolved for the timeout diagnostic.
 */
export function mergeNvidiaDeadlineResults(
  completedOutcomes: readonly NvidiaBatchOutcome[],
  results: Map<string, GenerationResult>
): readonly GenerationResult[] {
  const merged: GenerationResult[] = [];
  for (const outcome of completedOutcomes) {
    if (!outcome.ok) {
      continue;
    }
    const taskQuestionIds = new Set(
      outcome.batch.questions.map((question) => question.questionId)
    );
    for (const result of outcome.response.results) {
      if (
        !taskQuestionIds.has(result.questionId) ||
        results.has(result.questionId) ||
        (result.status !== 'GENERATED' && result.status !== 'ABSTAINED')
      ) {
        continue;
      }
      results.set(result.questionId, result);
      merged.push(result);
    }
  }
  return merged;
}

export class NvidiaRecoveryDeadlineError extends Error {
  constructor(
    public readonly acceptedResults: readonly GenerationResult[],
    public readonly unresolvedQuestionIds: readonly string[],
    public readonly completedResults: readonly GenerationResult[] = [
      ...acceptedResults,
    ]
  ) {
    super('NVIDIA generation recovery exceeded its overall deadline.');
    this.name = 'NvidiaRecoveryDeadlineError';
  }
}

interface NvidiaRecoveryFailureMetadata {
  safeCode: ProviderErrorCode;
  safeMessageCode?: ProviderSafeMessageCode;
  providerId?: string;
  diagnostics?: unknown;
}

function recoveryFailureMetadata(
  error: unknown
): NvidiaRecoveryFailureMetadata {
  if (typeof error !== 'object' || error === null) {
    return { safeCode: 'PROVIDER_FAILURE' };
  }
  return {
    safeCode:
      'safeCode' in error && isNvidiaProviderErrorCode(error.safeCode)
        ? error.safeCode
        : 'PROVIDER_FAILURE',
    ...('safeMessageCode' in error &&
    isProviderSafeMessageCode(error.safeMessageCode)
      ? { safeMessageCode: error.safeMessageCode }
      : {}),
    ...('providerId' in error && error.providerId === NVIDIA_PROVIDER_ID
      ? { providerId: NVIDIA_PROVIDER_ID }
      : {}),
    ...('diagnostics' in error ? { diagnostics: error.diagnostics } : {}),
  };
}

export class NvidiaRecoveryExhaustedError extends Error {
  constructor(
    public readonly safeCode: ProviderErrorCode = 'PROVIDER_FAILURE',
    public readonly safeMessageCode?: ProviderSafeMessageCode,
    public readonly providerId?: string,
    public readonly diagnostics?: unknown
  ) {
    super(
      'NVIDIA generation recovery failed without a usable provider result.'
    );
    this.name = 'NvidiaRecoveryExhaustedError';
  }
}

export interface NvidiaRecoveryAttemptContext {
  readonly batchIndex: number;
  readonly waveIndex: number;
  readonly attempt: number;
  readonly splitDepth: number;
}

export type NvidiaRecoveryRunner = (
  request: NvidiaGenerationRequest,
  signal?: AbortSignal,
  context?: NvidiaRecoveryAttemptContext
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
  readonly reasoningTokenReserve?: number;
  readonly performance?: GenerationPerformanceRecorder;
  readonly onResultsFinalized?: (finalizedQuestionCount: number) => void;
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
  readonly reasoningTokenReserve: number;
  readonly performance?: GenerationPerformanceRecorder;
  readonly onResultsFinalized?: (finalizedQuestionCount: number) => void;
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
    reasoningTokenReserve: normalizeNonNegativeInteger(
      options.reasoningTokenReserve,
      0
    ),
    ...(options.performance ? { performance: options.performance } : {}),
    ...(options.onResultsFinalized
      ? { onResultsFinalized: options.onResultsFinalized }
      : {}),
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
  const notifyFinalized = (): void => {
    normalized.onResultsFinalized?.(results.size);
  };
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
  const performance = normalized.performance;
  const recoveryStartedAt = performance ? monotonicNow() : 0;
  let waveIndex = 0;
  let initialExecutionMs = 0;
  let initialExecutionCompleted = false;
  let retryCount = 0;
  let splitCount = 0;
  let maxSplitDepth = 0;
  let concurrencyReductionCount = 0;
  let retryEligibilityWaitMs = 0;
  let backoffWaitMs = 0;
  const retryReasons: Record<string, number> = {};
  const everFailedQuestionIds = new Set<string>();
  const recoveredQuestionIds = new Set<string>();

  const acceptedResults = () =>
    [...results.values()].filter(
      (result) => result.status === 'GENERATED' || result.status === 'ABSTAINED'
    );
  const unresolvedQuestionIds = () =>
    request.questions.flatMap((question) =>
      results.has(question.questionId) ? [] : [question.questionId]
    );
  const completedResults = () =>
    request.questions.flatMap((question) => {
      const result = results.get(question.questionId);
      return result ? [result] : [];
    });
  const deadlineError = () =>
    new NvidiaRecoveryDeadlineError(
      acceptedResults(),
      unresolvedQuestionIds(),
      completedResults()
    );
  const failureDescriptor = (
    descriptor: NvidiaBatchFailureDescriptor
  ): NvidiaBatchFailureDescriptor => ({ ...descriptor });

  const recordConcurrencyReduction = (reason: string): void => {
    if (currentConcurrency <= 1) {
      return;
    }
    currentConcurrency = 1;
    concurrencyReductionCount += 1;
    performance?.recordRecoveryEvent({
      type: 'CONCURRENCY_REDUCED',
      waveIndex,
      questionCount: 0,
      attempt: null,
      splitDepth: 0,
      reason,
      delayMs: null,
      backoffMs: null,
      concurrency: currentConcurrency,
    });
  };

  const recordRetry = (
    type: 'RETRY' | 'SPLIT',
    questionCount: number,
    splitDepth: number,
    delayMs: number,
    backoffMs: number | null,
    reason: string
  ): void => {
    retryCount += 1;
    retryReasons[reason] = (retryReasons[reason] ?? 0) + 1;
    retryEligibilityWaitMs += delayMs;
    if (backoffMs !== null) {
      backoffWaitMs += backoffMs;
    }
    if (type === 'SPLIT') {
      splitCount += 1;
      maxSplitDepth = Math.max(maxSplitDepth, splitDepth);
    }
    performance?.recordRecoveryEvent({
      type,
      waveIndex,
      questionCount,
      attempt: null,
      splitDepth,
      reason,
      delayMs,
      backoffMs,
      concurrency: currentConcurrency,
    });
  };

  const recordSplit = (
    questionCount: number,
    splitDepth: number,
    reason: string
  ): void => {
    retryCount += 1;
    retryReasons[reason] = (retryReasons[reason] ?? 0) + 1;
    splitCount += 1;
    maxSplitDepth = Math.max(maxSplitDepth, splitDepth);
    performance?.recordRecoveryEvent({
      type: 'SPLIT',
      waveIndex,
      questionCount,
      attempt: null,
      splitDepth,
      reason,
      delayMs: null,
      backoffMs: null,
      concurrency: currentConcurrency,
    });
  };

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
    notifyFinalized();
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

  // A split is a structural narrowing step, not a retry of the same request.
  // Release the attempt charged for the parent execution so narrowing cannot
  // exhaust the per-question budget before a single-question request is tried.
  const releaseAttempt = (questions: readonly GenerationQuestion[]): void => {
    for (const question of questions) {
      attempts.set(
        question.questionId,
        Math.max(0, (attempts.get(question.questionId) ?? 1) - 1)
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
  ): boolean => {
    const unresolved = questions.filter(
      (question) => !results.has(question.questionId)
    );
    if (unresolved.length === 0) {
      return false;
    }
    const retryable = unresolved.filter((question) => {
      if (isExhausted(question.questionId)) {
        finalizeQuestion(question.questionId);
        return false;
      }
      return true;
    });
    if (retryable.length === 0) {
      return false;
    }

    const batch = createNvidiaQuestionBatch(
      request,
      retryable,
      nextBatchIndex,
      {
        payloadProfile: normalized.payloadProfile,
        reasoningTokenReserve: normalized.reasoningTokenReserve,
      }
    );
    if (
      isNvidiaBatchWithinLimits(
        batch,
        normalized.limits,
        normalized.reasoningTokenReserve
      )
    ) {
      nextBatchIndex += 1;
      pending.push({ batch, splitDepth, notBefore });
      return true;
    }
    if (retryable.length === 1 || splitDepth >= normalized.maxSplitDepth) {
      const descriptor = failureDescriptorForCode('INVALID_REQUEST');
      for (const question of retryable) {
        lastFailureById.set(question.questionId, descriptor);
        finalizeQuestion(question.questionId);
      }
      return false;
    }
    const midpoint = Math.ceil(retryable.length / 2);
    const left = enqueueQuestions(
      retryable.slice(0, midpoint),
      splitDepth + 1,
      notBefore
    );
    const right = enqueueQuestions(
      retryable.slice(midpoint),
      splitDepth + 1,
      notBefore
    );
    if (left || right) {
      recordSplit(retryable.length, splitDepth + 1, 'BATCH_LIMIT');
    }
    return left || right;
  };

  const scheduleRetry = (
    questions: readonly GenerationQuestion[],
    splitDepth: number,
    mode: RetryMode,
    delayMs: number,
    backoffMs: number | null = null,
    reason = 'RETRY'
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
      releaseAttempt(unresolved);
      const midpoint = Math.ceil(unresolved.length / 2);
      const left = enqueueQuestions(
        unresolved.slice(0, midpoint),
        splitDepth + 1,
        notBefore
      );
      const right = enqueueQuestions(
        unresolved.slice(midpoint),
        splitDepth + 1,
        notBefore
      );
      if (left || right) {
        recordRetry(
          'SPLIT',
          unresolved.length,
          splitDepth + 1,
          delayMs,
          backoffMs,
          reason
        );
      }
      return;
    }
    const enqueued = enqueueQuestions(unresolved, splitDepth, notBefore);
    if (enqueued) {
      recordRetry(
        'RETRY',
        unresolved.length,
        splitDepth,
        delayMs,
        backoffMs,
        reason
      );
    }
  };

  const handleSuccess = (
    task: RecoveryTask,
    response: GenerationResponse
  ): void => {
    const taskIds = new Set(
      task.batch.questions.map((question) => question.questionId)
    );
    let structuralModelFailureRequested = false;
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
        notifyFinalized();
        lastFailureById.delete(result.questionId);
        if (everFailedQuestionIds.has(result.questionId)) {
          recoveredQuestionIds.add(result.questionId);
        }
        continue;
      }
      everFailedQuestionIds.add(result.questionId);
      const details = nvidiaResultFailureDetails(result);
      lastFailureById.set(result.questionId, {
        code: details.code,
        message: details.message,
      });
      if (details.disposition === 'SPLIT') {
        structuralModelFailureRequested = true;
      }
      if (details.disposition === 'NONE' || isExhausted(result.questionId)) {
        results.set(result.questionId, result);
        notifyFinalized();
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
    for (const question of unresolved) {
      everFailedQuestionIds.add(question.questionId);
    }
    scheduleRetry(
      unresolved,
      task.splitDepth,
      structuralModelFailureRequested ? 'SPLIT' : 'RETRY',
      0,
      null,
      'MISSING_RESULT'
    );
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
      everFailedQuestionIds.add(question.questionId);
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

    const details = nvidiaFailureDetails(outcome.metadata.safeCode);
    if (details.disposition === 'NONE') {
      for (const question of unresolved) {
        finalizeQuestion(question.questionId);
      }
      return;
    }

    switch (outcome.metadata.category) {
      case 'RATE_LIMIT': {
        recordConcurrencyReduction('RATE_LIMIT');
        scheduleRetry(
          unresolved,
          task.splitDepth,
          'RETRY',
          retryAfter ?? retryDelay,
          retryDelay,
          'RATE_LIMIT'
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
          split ? 0 : retryDelay,
          retryDelay,
          'TIMEOUT'
        );
        return;
      }
      case 'NETWORK':
      case 'PROVIDER_UNAVAILABLE': {
        transientFailureCount += 1;
        if (transientFailureCount >= 2) {
          recordConcurrencyReduction('TRANSIENT_FAILURE');
        }
        scheduleRetry(
          unresolved,
          task.splitDepth,
          'RETRY',
          retryAfter ?? retryDelay,
          retryDelay,
          outcome.metadata.category
        );
        return;
      }
      case 'MALFORMED_RESPONSE':
        scheduleRetry(
          unresolved,
          task.splitDepth,
          'SPLIT',
          0,
          null,
          'MALFORMED_RESPONSE'
        );
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
      waveIndex += 1;
      const waveStartedAt = performance ? monotonicNow() : 0;
      performance?.addCount('recoveryWaveCount');
      const batchMetadata = new Map(
        waveTasks.map((task) => [
          task.batch.index,
          {
            waveIndex,
            attempt:
              Math.max(
                0,
                ...task.batch.questions.map(
                  (question) => attempts.get(question.questionId) ?? 0
                )
              ) + 1,
            splitDepth: task.splitDepth,
          },
        ])
      );
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
        let attempt = 1;
        if (task) {
          markAttempt(task.batch.questions);
          attempt =
            Math.max(
              1,
              ...task.batch.questions.map(
                (question) => attempts.get(question.questionId) ?? 1
              )
            ) ?? 1;
        }
        return runAttempt(
          batchRequest as NvidiaGenerationRequest,
          signal,
          task
            ? {
                batchIndex: task.batch.index,
                waveIndex,
                attempt,
                splitDepth: task.splitDepth,
              }
            : undefined
        );
      };

      let outcomes: readonly NvidiaBatchOutcome[];
      try {
        outcomes = await executeNvidiaBatches(request, batches, runner, {
          concurrency: currentConcurrency,
          signal: controller.signal,
          overallTimeoutMs:
            normalized.deadlineAt === null
              ? undefined
              : Math.max(
                  1,
                  (remainingMs() ?? 1) - NVIDIA_BATCH_DEADLINE_MARGIN_MS
                ),
          ...(performance ? { performance } : {}),
          batchMetadata,
        });
      } catch (error) {
        if (error instanceof NvidiaBatchDeadlineError) {
          deadlineExpired = true;
          // The batch executor can finish requests just before its deadline
          // fires. Keep those answers instead of regenerating them.
          for (const result of mergeNvidiaDeadlineResults(
            error.completedOutcomes,
            results
          )) {
            providerResultIds.add(result.questionId);
            lastFailureById.delete(result.questionId);
            if (everFailedQuestionIds.has(result.questionId)) {
              recoveredQuestionIds.add(result.questionId);
            }
            notifyFinalized();
          }
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
      } finally {
        const waveDurationMs = performance ? elapsedSince(waveStartedAt) : 0;
        performance?.addPhase('recoveryWaveExecutionMs', waveDurationMs);
        if (!initialExecutionCompleted) {
          initialExecutionMs = waveDurationMs;
          initialExecutionCompleted = true;
        }
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
    if (performance) {
      const totalRecoveryDurationMs = elapsedSince(recoveryStartedAt);
      performance.setRecoverySummary({
        initialExecutionMs,
        recoveryDurationMs: Math.max(
          0,
          totalRecoveryDurationMs - initialExecutionMs
        ),
        totalRecoveryDurationMs,
        retryCount,
        retryReasons: { ...retryReasons },
        splitCount,
        maxSplitDepth,
        recoveredCount: recoveredQuestionIds.size,
        unresolvedCount: request.questions.filter(
          (question) => !results.has(question.questionId)
        ).length,
        concurrencyReductionCount,
        retryEligibilityWaitMs,
        backoffWaitMs,
        deadlineReached: deadlineExpired,
        cancelled: cancelled || normalized.signal?.aborted === true,
      });
      performance.addPhase('recoveryTotalDurationMs', totalRecoveryDurationMs);
    }
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
        const metadata = recoveryFailureMetadata(firstError);
        throw new NvidiaRecoveryExhaustedError(
          metadata.safeCode,
          metadata.safeMessageCode,
          metadata.providerId,
          metadata.diagnostics
        );
      }
      return result;
    }),
  };
}
