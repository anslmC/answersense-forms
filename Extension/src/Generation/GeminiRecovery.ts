import {
  PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
  type FailedQuestionResult,
  type GenerationRequest,
  type GenerationResponse,
  type GenerationResult,
  type ProviderProgressObserver,
} from './Contract';
import type { GenerationPerformanceRecorder } from '../Shared/Performance';

export const GEMINI_RECOVERY_MAX_EXECUTIONS = 3;
export const GEMINI_RECOVERY_MAX_SPLIT_DEPTH = 6;
export const GEMINI_RECOVERY_MAX_CONCURRENCY = 2;
export const GEMINI_RECOVERY_BASE_BACKOFF_MS = 250;
export const GEMINI_RECOVERY_MAX_BACKOFF_MS = 8_000;
export const GEMINI_RECOVERY_DEADLINE_MS = 180_000;
export const GEMINI_RECOVERY_REQUEST_TIMEOUT_MS = 30_000;
export const GEMINI_RECOVERY_DEADLINE_MESSAGE =
  'Generation timed out before all answers were produced.';

export type GeminiRecoveryDisposition = 'RETRY' | 'SPLIT' | 'NONE';

export type GeminiOverflowKind =
  'SHARED_CONTEXT' | 'QUESTION_PAYLOAD' | 'UNKNOWN';

export interface GeminiFailureDescriptor {
  readonly code: string;
  readonly message: string;
}

export interface GeminiAttemptMeta {
  readonly attempt: number;
  readonly splitDepth: number;
  readonly questionCount: number;
  readonly waveIndex: number;
}

export type GeminiAttemptOutcome =
  | {
      readonly ok: true;
      readonly results: readonly GenerationResult[];
      readonly truncated?: boolean;
      readonly diagnosticFailure?: GeminiFailureDescriptor;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly failure: GeminiFailureDescriptor;
      readonly disposition: GeminiRecoveryDisposition;
      readonly retryAfterMs?: number | null;
      readonly contextOverflow?: boolean;
      readonly overflowKind?: GeminiOverflowKind;
      readonly acceptedEmptyResponse?: boolean;
    };

export type GeminiAttemptRunner = (
  request: GenerationRequest,
  signal: AbortSignal | undefined,
  meta: GeminiAttemptMeta
) => Promise<GeminiAttemptOutcome>;

export interface GeminiRecoveryOptions {
  readonly maxExecutions?: number;
  readonly maxSplitDepth?: number;
  readonly deadlineMs?: number;
  readonly concurrency?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly requestTimeoutMs?: number;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly performance?: GenerationPerformanceRecorder;
  readonly onProgress?: ProviderProgressObserver;
}

interface NormalizedRecoveryOptions {
  readonly maxExecutions: number;
  readonly maxSplitDepth: number;
  readonly deadlineMs: number;
  readonly concurrency: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly requestTimeoutMs: number;
  readonly random: () => number;
  readonly signal?: AbortSignal;
  readonly performance?: GenerationPerformanceRecorder;
  readonly onProgress?: ProviderProgressObserver;
}

interface PendingGroup {
  readonly questionIds: readonly string[];
  readonly depth: number;
  readonly notBefore: number;
  readonly executions: number;
}

interface FailureDetails {
  readonly descriptor: GeminiFailureDescriptor;
  readonly disposition: GeminiRecoveryDisposition;
}

const DEFAULT_FAILURE: GeminiFailureDescriptor = {
  code: 'PROVIDER_FAILURE',
  message: 'Provider request failed.',
};

const DEADLINE_FAILURE: GeminiFailureDescriptor = {
  code: 'TIMEOUT',
  message: GEMINI_RECOVERY_DEADLINE_MESSAGE,
};

const SHARED_CONTEXT_FAILURE: GeminiFailureDescriptor = {
  code: 'INVALID_REQUEST',
  message:
    'The provider rejected the request because the shared context exceeds the model input limit.',
};

const CONTEXT_OVERFLOW_FAILURE: GeminiFailureDescriptor = {
  code: 'INVALID_REQUEST',
  message: PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
};

const RECOVERABLE_MODEL_FAILURE_CODES = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_FAILURE',
  'TIMEOUT',
]);

const SPLIT_MODEL_FAILURE_CODES = new Set([
  'INCOMPLETE_PROVIDER_RESPONSE',
  'MALFORMED_PROVIDER_RESPONSE',
]);

export class GeminiRecoveryCancelledError extends Error {
  constructor() {
    super('Gemini generation was cancelled.');
    this.name = 'GeminiRecoveryCancelledError';
  }
}

export class GeminiRecoveryDeadlineError extends Error {
  constructor(public readonly unresolvedQuestionIds: readonly string[]) {
    super(GEMINI_RECOVERY_DEADLINE_MESSAGE);
    this.name = 'GeminiRecoveryDeadlineError';
  }
}

export class GeminiRecoveryExhaustedError extends Error {
  constructor(public readonly failure: GeminiFailureDescriptor) {
    super(failure.message);
    this.name = 'GeminiRecoveryExhaustedError';
  }
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function normalizeOptions(
  options: GeminiRecoveryOptions
): NormalizedRecoveryOptions {
  const baseBackoffMs = normalizeInteger(
    options.baseBackoffMs,
    GEMINI_RECOVERY_BASE_BACKOFF_MS,
    0,
    GEMINI_RECOVERY_MAX_BACKOFF_MS
  );
  const maxBackoffMs = Math.max(
    baseBackoffMs,
    normalizeInteger(
      options.maxBackoffMs,
      GEMINI_RECOVERY_MAX_BACKOFF_MS,
      0,
      GEMINI_RECOVERY_MAX_BACKOFF_MS
    )
  );
  return {
    maxExecutions: normalizeInteger(
      options.maxExecutions,
      GEMINI_RECOVERY_MAX_EXECUTIONS,
      1,
      GEMINI_RECOVERY_MAX_EXECUTIONS
    ),
    maxSplitDepth: normalizeInteger(
      options.maxSplitDepth,
      GEMINI_RECOVERY_MAX_SPLIT_DEPTH,
      0,
      GEMINI_RECOVERY_MAX_SPLIT_DEPTH
    ),
    deadlineMs: normalizeInteger(
      options.deadlineMs,
      GEMINI_RECOVERY_DEADLINE_MS,
      1,
      GEMINI_RECOVERY_DEADLINE_MS
    ),
    concurrency: normalizeInteger(
      options.concurrency,
      GEMINI_RECOVERY_MAX_CONCURRENCY,
      1,
      GEMINI_RECOVERY_MAX_CONCURRENCY
    ),
    baseBackoffMs,
    maxBackoffMs,
    requestTimeoutMs: normalizeInteger(
      options.requestTimeoutMs,
      GEMINI_RECOVERY_REQUEST_TIMEOUT_MS,
      1,
      GEMINI_RECOVERY_REQUEST_TIMEOUT_MS
    ),
    random: options.random ?? Math.random,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.performance ? { performance: options.performance } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}

export function computeGeminiRecoveryBackoff(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function boundedMessage(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 512
    ? `${trimmed.slice(0, 509).trimEnd()}...`
    : trimmed;
}

function modelFailureDetails(result: FailedQuestionResult): FailureDetails {
  const code = result.failure.code.trim();
  const message =
    boundedMessage(result.failure.message) || 'Provider request failed.';
  if (code.length === 0) {
    return { descriptor: DEFAULT_FAILURE, disposition: 'NONE' };
  }
  const upperCode = code.toUpperCase();
  if (RECOVERABLE_MODEL_FAILURE_CODES.has(upperCode)) {
    return { descriptor: { code, message }, disposition: 'RETRY' };
  }
  if (SPLIT_MODEL_FAILURE_CODES.has(upperCode)) {
    return { descriptor: { code, message }, disposition: 'SPLIT' };
  }
  return { descriptor: { code, message }, disposition: 'NONE' };
}

function failureDescriptorFromError(error: unknown): GeminiFailureDescriptor {
  if (isRecord(error)) {
    const code = error.code;
    const message = error.message;
    if (
      typeof code === 'string' &&
      code.trim().length > 0 &&
      typeof message === 'string'
    ) {
      return {
        code: code.trim().slice(0, 128),
        message: boundedMessage(message) || DEFAULT_FAILURE.message,
      };
    }
  }
  return DEFAULT_FAILURE;
}

function failedResult(
  questionId: string,
  descriptor: GeminiFailureDescriptor
): GenerationResult {
  return {
    questionId,
    status: 'GENERATION_FAILED',
    answer: null,
    failure: { ...descriptor },
  };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal.aborted
      ? Promise.reject(new GeminiRecoveryCancelledError())
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new GeminiRecoveryCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Runs Gemini generation with bounded retry, split recovery, and partial-result
 * preservation. Both Gemini models use this same path from GeminiProvider.
 */
export async function executeGeminiRecovery(
  request: GenerationRequest,
  runAttempt: GeminiAttemptRunner,
  options: GeminiRecoveryOptions = {}
): Promise<GenerationResponse> {
  if (request.questions.length === 0) {
    return { cycleId: request.cycleId, results: [] };
  }

  const normalized = normalizeOptions(options);
  if (normalized.signal?.aborted) {
    throw new GeminiRecoveryCancelledError();
  }

  const questionById = new Map(
    request.questions.map((question) => [question.questionId, question])
  );
  if (questionById.size !== request.questions.length) {
    throw new GeminiRecoveryExhaustedError({
      code: 'INVALID_REQUEST',
      message: 'Provider request was invalid.',
    });
  }

  const results = new Map<string, GenerationResult>();
  const acceptedIds = new Set<string>();
  const lastFailureById = new Map<string, GeminiFailureDescriptor>();
  const everFailedIds = new Set<string>();
  const recoveredIds = new Set<string>();
  const deadlineFinalizedIds = new Set<string>();
  const controller = new AbortController();
  const startedAt = normalized.performance
    ? (globalThis.performance?.now?.() ?? Date.now())
    : 0;
  const deadlineAt = Date.now() + normalized.deadlineMs;
  const hasSharedContext = request.settledContext.length > 0;

  let pending: PendingGroup[] = [
    {
      questionIds: request.questions.map((question) => question.questionId),
      depth: 0,
      notBefore: Date.now(),
      executions: 0,
    },
  ];
  let waveIndex = 0;
  let cancelled = false;
  let deadlineExpired = false;
  let deadlineAdmissionExhausted = false;
  let overflowProbeState:
    'NOT_RUN' | 'SHARED_CONTEXT' | 'QUESTION_PAYLOAD' | 'INCONCLUSIVE' =
    'NOT_RUN';
  let firstWaveCompleted = false;
  let initialExecutionMs = 0;
  let lastRequestFailure: unknown = null;
  let retryCount = 0;
  let splitCount = 0;
  let maxSplitDepthSeen = 0;
  let retryWaitMs = 0;
  let backoffWaitMs = 0;
  const retryReasons: Record<string, number> = {};

  const notifyFinalized = (): void => {
    normalized.onProgress?.(results.size);
  };

  const unresolvedQuestionIds = (): string[] =>
    request.questions.flatMap((question) =>
      results.has(question.questionId) ? [] : [question.questionId]
    );

  const finalizeQuestion = (
    questionId: string,
    descriptor?: GeminiFailureDescriptor
  ): void => {
    if (results.has(questionId)) {
      return;
    }
    const failure =
      descriptor ?? lastFailureById.get(questionId) ?? DEFAULT_FAILURE;
    results.set(questionId, failedResult(questionId, failure));
    notifyFinalized();
  };

  const finalizeQuestions = (
    questionIds: readonly string[],
    descriptor?: GeminiFailureDescriptor
  ): void => {
    for (const questionId of questionIds) {
      finalizeQuestion(questionId, descriptor);
    }
  };

  const finalizeDeadlineQuestions = (questionIds: readonly string[]): void => {
    for (const questionId of questionIds) {
      if (!results.has(questionId)) {
        deadlineFinalizedIds.add(questionId);
      }
    }
    finalizeQuestions(questionIds, DEADLINE_FAILURE);
  };

  const storeAccepted = (result: GenerationResult): void => {
    if (results.has(result.questionId)) {
      return;
    }
    results.set(result.questionId, result);
    acceptedIds.add(result.questionId);
    lastFailureById.delete(result.questionId);
    if (everFailedIds.has(result.questionId)) {
      recoveredIds.add(result.questionId);
    }
    notifyFinalized();
  };

  const storeTerminal = (result: GenerationResult): void => {
    if (results.has(result.questionId)) {
      return;
    }
    results.set(result.questionId, result);
    notifyFinalized();
  };

  const recordRetry = (
    questionCount: number,
    splitDepth: number,
    delayMs: number,
    backoffMs: number,
    reason: string
  ): void => {
    retryCount += 1;
    retryReasons[reason] = (retryReasons[reason] ?? 0) + 1;
    retryWaitMs += delayMs;
    backoffWaitMs += backoffMs;
    normalized.performance?.recordRecoveryEvent({
      type: 'RETRY',
      waveIndex,
      questionCount,
      attempt: null,
      splitDepth,
      reason,
      delayMs,
      backoffMs,
      concurrency: normalized.concurrency,
    });
  };

  const recordSplit = (
    questionCount: number,
    splitDepth: number,
    delayMs: number,
    reason: string
  ): void => {
    retryCount += 1;
    splitCount += 1;
    maxSplitDepthSeen = Math.max(maxSplitDepthSeen, splitDepth);
    retryReasons[reason] = (retryReasons[reason] ?? 0) + 1;
    retryWaitMs += delayMs;
    normalized.performance?.recordRecoveryEvent({
      type: 'SPLIT',
      waveIndex,
      questionCount,
      attempt: null,
      splitDepth,
      reason,
      delayMs,
      backoffMs: null,
      concurrency: normalized.concurrency,
    });
  };

  const enqueue = (
    questionIds: readonly string[],
    depth: number,
    notBefore: number,
    executions: number
  ): boolean => {
    const unresolved = questionIds.filter(
      (questionId) => !results.has(questionId)
    );
    if (unresolved.length === 0) {
      return false;
    }
    if (executions >= normalized.maxExecutions) {
      finalizeQuestions(unresolved);
      return false;
    }
    if (notBefore > deadlineAt - normalized.requestTimeoutMs) {
      deadlineAdmissionExhausted = true;
      finalizeDeadlineQuestions(unresolved);
      return false;
    }

    pending.push({
      questionIds: unresolved,
      depth,
      notBefore,
      executions,
    });
    return true;
  };

  const schedule = (
    questionIds: readonly string[],
    depth: number,
    disposition: Exclude<GeminiRecoveryDisposition, 'NONE'>,
    executions: number,
    delayMs: number,
    reason: string,
    backoffMs = 0,
    splitOnRepeatedFailure = true
  ): void => {
    const unresolved = questionIds.filter(
      (questionId) => !results.has(questionId)
    );
    if (unresolved.length === 0) {
      return;
    }
    const shouldSplit =
      depth < normalized.maxSplitDepth &&
      unresolved.length > 1 &&
      (disposition === 'SPLIT' || (splitOnRepeatedFailure && executions >= 2));

    if (shouldSplit) {
      const midpoint = Math.ceil(unresolved.length / 2);
      const notBefore = Date.now() + Math.max(0, delayMs);
      const left = enqueue(
        unresolved.slice(0, midpoint),
        depth + 1,
        notBefore,
        0
      );
      const right = enqueue(
        unresolved.slice(midpoint),
        depth + 1,
        notBefore,
        0
      );
      if (left || right) {
        recordSplit(unresolved.length, depth + 1, delayMs, reason);
      }
      return;
    }

    const notBefore = Date.now() + Math.max(0, delayMs);
    const enqueued = enqueue(unresolved, depth, notBefore, executions);
    if (enqueued && disposition === 'RETRY') {
      recordRetry(unresolved.length, depth, delayMs, backoffMs, reason);
    }
  };

  const handleSuccess = (
    questionIds: readonly string[],
    depth: number,
    executions: number,
    outcome: Extract<GeminiAttemptOutcome, { readonly ok: true }>
  ): void => {
    const taskIds = new Set(questionIds);
    for (const result of outcome.results) {
      if (!taskIds.has(result.questionId) || results.has(result.questionId)) {
        continue;
      }
      if (result.status === 'GENERATED' || result.status === 'ABSTAINED') {
        storeAccepted(result);
        continue;
      }
      everFailedIds.add(result.questionId);
      const details = modelFailureDetails(result);
      lastFailureById.set(result.questionId, details.descriptor);
      if (details.disposition === 'NONE') {
        storeTerminal(result);
      }
    }

    const missing = questionIds.filter(
      (questionId) => !results.has(questionId)
    );
    if (missing.length === 0) {
      return;
    }
    for (const questionId of missing) {
      everFailedIds.add(questionId);
      if (!lastFailureById.has(questionId)) {
        lastFailureById.set(
          questionId,
          outcome.diagnosticFailure ??
            (outcome.truncated === true
              ? {
                  code: 'INCOMPLETE_PROVIDER_RESPONSE',
                  message: 'Provider response was truncated before completion.',
                }
              : {
                  code: 'MALFORMED_PROVIDER_OUTPUT',
                  message:
                    'Provider did not return a usable result for this question.',
                })
        );
      }
    }

    const repeatedWholeGroup =
      missing.length === questionIds.length && questionIds.length > 1;
    schedule(
      missing,
      depth,
      outcome.truncated === true || repeatedWholeGroup ? 'SPLIT' : 'RETRY',
      executions,
      0,
      outcome.truncated === true ? 'TRUNCATED_RESPONSE' : 'MISSING_RESULT',
      0,
      false
    );
  };

  const runOverflowProbe = async (
    depth: number
  ): Promise<
    'SHARED_CONTEXT' | 'QUESTION_PAYLOAD' | 'INCONCLUSIVE' | 'DEADLINE'
  > => {
    if (Date.now() + normalized.requestTimeoutMs > deadlineAt) {
      return 'DEADLINE';
    }
    let outcome: GeminiAttemptOutcome;
    try {
      outcome = await runAttempt(
        { ...request, questions: [] },
        controller.signal,
        {
          attempt: 1,
          splitDepth: depth,
          questionCount: 0,
          waveIndex,
        }
      );
    } catch {
      if (deadlineExpired || Date.now() >= deadlineAt) {
        return 'DEADLINE';
      }
      return 'INCONCLUSIVE';
    }
    if (deadlineExpired || Date.now() >= deadlineAt) {
      return 'DEADLINE';
    }
    if (!outcome.ok && outcome.contextOverflow === true) {
      return 'SHARED_CONTEXT';
    }
    if (outcome.ok || outcome.acceptedEmptyResponse === true) {
      return 'QUESTION_PAYLOAD';
    }
    return 'INCONCLUSIVE';
  };

  const resolveOverflowKind = async (
    kind: GeminiOverflowKind,
    depth: number
  ): Promise<GeminiOverflowKind | 'DEADLINE' | 'INCONCLUSIVE_STOP'> => {
    if (kind === 'QUESTION_PAYLOAD') {
      return 'QUESTION_PAYLOAD';
    }
    if (!hasSharedContext) {
      return 'QUESTION_PAYLOAD';
    }
    if (kind === 'SHARED_CONTEXT') {
      return 'SHARED_CONTEXT';
    }
    if (overflowProbeState === 'NOT_RUN') {
      const probe = await runOverflowProbe(depth);
      if (probe === 'DEADLINE') {
        return 'DEADLINE';
      }
      overflowProbeState =
        probe === 'SHARED_CONTEXT'
          ? 'SHARED_CONTEXT'
          : probe === 'QUESTION_PAYLOAD'
            ? 'QUESTION_PAYLOAD'
            : 'INCONCLUSIVE';
    }
    if (overflowProbeState === 'QUESTION_PAYLOAD') {
      return 'QUESTION_PAYLOAD';
    }
    if (overflowProbeState === 'SHARED_CONTEXT') {
      return 'SHARED_CONTEXT';
    }
    return 'INCONCLUSIVE_STOP';
  };

  const handleFailure = async (
    questionIds: readonly string[],
    depth: number,
    executions: number,
    outcome: Extract<GeminiAttemptOutcome, { readonly ok: false }>
  ): Promise<void> => {
    lastRequestFailure = outcome.error;
    const unresolved = questionIds.filter(
      (questionId) => !results.has(questionId)
    );
    if (unresolved.length === 0) {
      return;
    }
    for (const questionId of unresolved) {
      everFailedIds.add(questionId);
      lastFailureById.set(questionId, outcome.failure);
    }

    if (outcome.disposition === 'NONE') {
      finalizeQuestions(unresolved, outcome.failure);
      return;
    }

    if (outcome.contextOverflow === true) {
      const kind = await resolveOverflowKind(
        outcome.overflowKind ?? 'UNKNOWN',
        depth
      );
      if (kind === 'DEADLINE') {
        finalizeDeadlineQuestions(unresolved);
        return;
      }
      if (kind === 'SHARED_CONTEXT') {
        finalizeQuestions(unresolved, SHARED_CONTEXT_FAILURE);
        return;
      }
      if (kind === 'INCONCLUSIVE_STOP' || kind === 'UNKNOWN') {
        finalizeQuestions(unresolved, CONTEXT_OVERFLOW_FAILURE);
        return;
      }
    }

    const backoffMs = computeGeminiRecoveryBackoff(
      executions,
      normalized.baseBackoffMs,
      normalized.maxBackoffMs,
      normalized.random
    );
    const retryAfterMs =
      outcome.retryAfterMs === null || outcome.retryAfterMs === undefined
        ? null
        : Math.min(
            normalized.maxBackoffMs,
            Math.max(0, Math.floor(outcome.retryAfterMs))
          );
    const delayMs = retryAfterMs ?? backoffMs;
    const reason = outcome.contextOverflow
      ? 'CONTEXT_OVERFLOW'
      : outcome.failure.code;
    schedule(
      unresolved,
      depth,
      outcome.disposition,
      executions,
      delayMs,
      reason,
      backoffMs
    );
  };

  const handleUnexpected = (
    questionIds: readonly string[],
    error: unknown
  ): void => {
    lastRequestFailure = error;
    const failure = failureDescriptorFromError(error);
    finalizeQuestions(questionIds, failure);
  };

  const requestFor = (questionIds: readonly string[]): GenerationRequest => ({
    ...request,
    questions: questionIds.flatMap((questionId) => {
      const question = questionById.get(questionId);
      return question ? [question] : [];
    }),
  });

  const abortFromCaller = (): void => {
    cancelled = true;
    controller.abort();
  };
  normalized.signal?.addEventListener('abort', abortFromCaller, {
    once: true,
  });
  const deadlineTimer = setTimeout(
    () => {
      deadlineExpired = true;
      controller.abort();
    },
    Math.max(0, deadlineAt - Date.now())
  );

  try {
    while (true) {
      if (cancelled || normalized.signal?.aborted) {
        throw new GeminiRecoveryCancelledError();
      }
      if (deadlineExpired || Date.now() >= deadlineAt) {
        deadlineExpired = true;
        break;
      }

      const now = Date.now();
      const ready = pending.filter((group) => group.notBefore <= now);
      if (ready.length === 0) {
        if (pending.length === 0) {
          break;
        }
        const nextReadyAt = Math.min(
          ...pending.map((group) => group.notBefore)
        );
        if (nextReadyAt >= deadlineAt) {
          deadlineExpired = true;
          break;
        }
        if (nextReadyAt > deadlineAt - normalized.requestTimeoutMs) {
          deadlineAdmissionExhausted = true;
          break;
        }
        try {
          await waitFor(
            Math.max(0, Math.min(nextReadyAt - now, deadlineAt - Date.now())),
            controller.signal
          );
        } catch {
          if (cancelled || normalized.signal?.aborted) {
            throw new GeminiRecoveryCancelledError();
          }
          if (deadlineExpired || Date.now() >= deadlineAt) {
            deadlineExpired = true;
            break;
          }
          throw new GeminiRecoveryCancelledError();
        }
        continue;
      }

      const wave = ready.slice(0, normalized.concurrency);
      pending = pending.filter((group) => !wave.includes(group));
      const tasks = wave.flatMap((group) => {
        const questionIds = group.questionIds.filter(
          (questionId) => !results.has(questionId)
        );
        return questionIds.length > 0
          ? [{ ...group, questionIds, executions: group.executions + 1 }]
          : [];
      });
      if (tasks.length === 0) {
        continue;
      }

      const admissionTime = Date.now();
      const admissibleTasks: typeof tasks = [];
      for (const task of tasks) {
        if (admissionTime + normalized.requestTimeoutMs <= deadlineAt) {
          admissibleTasks.push(task);
        } else {
          finalizeDeadlineQuestions(task.questionIds);
        }
      }
      if (admissibleTasks.length === 0) {
        deadlineAdmissionExhausted = true;
        break;
      }

      waveIndex += 1;
      normalized.performance?.addCount('geminiRecoveryWaveCount');
      normalized.performance?.observeConcurrency(
        admissibleTasks.length,
        pending.length
      );
      const waveStartedAt = normalized.performance
        ? (globalThis.performance?.now?.() ?? Date.now())
        : 0;

      const outcomes = await Promise.allSettled(
        admissibleTasks.map((task) =>
          runAttempt(requestFor(task.questionIds), controller.signal, {
            attempt: task.executions,
            splitDepth: task.depth,
            questionCount: task.questionIds.length,
            waveIndex,
          })
        )
      );

      if (cancelled || normalized.signal?.aborted) {
        throw new GeminiRecoveryCancelledError();
      }

      const deadlineReachedDuringWave =
        deadlineExpired || Date.now() >= deadlineAt;
      if (deadlineReachedDuringWave) {
        deadlineExpired = true;
      }
      for (let index = 0; index < outcomes.length; index += 1) {
        const task = admissibleTasks[index];
        const outcome = outcomes[index];
        if (outcome.status === 'fulfilled') {
          if (outcome.value.ok) {
            handleSuccess(
              task.questionIds,
              task.depth,
              task.executions,
              outcome.value
            );
          } else if (!deadlineReachedDuringWave) {
            await handleFailure(
              task.questionIds,
              task.depth,
              task.executions,
              outcome.value
            );
          }
        } else if (!deadlineReachedDuringWave) {
          handleUnexpected(task.questionIds, outcome.reason);
        }
      }

      if (!firstWaveCompleted) {
        firstWaveCompleted = true;
        initialExecutionMs = normalized.performance
          ? Math.max(
              0,
              Math.round(
                (globalThis.performance?.now?.() ?? Date.now()) - waveStartedAt
              )
            )
          : 0;
      }
      if (
        deadlineExpired ||
        deadlineAdmissionExhausted ||
        Date.now() >= deadlineAt
      ) {
        deadlineExpired = true;
        break;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    normalized.signal?.removeEventListener('abort', abortFromCaller);
    if (normalized.performance) {
      const totalRecoveryDurationMs = normalized.performance
        ? Math.max(
            0,
            Math.round(
              (globalThis.performance?.now?.() ?? Date.now()) - startedAt
            )
          )
        : 0;
      normalized.performance.setRecoverySummary({
        initialExecutionMs,
        recoveryDurationMs: Math.max(
          0,
          totalRecoveryDurationMs - initialExecutionMs
        ),
        totalRecoveryDurationMs,
        retryCount,
        retryReasons: { ...retryReasons },
        splitCount,
        maxSplitDepth: maxSplitDepthSeen,
        recoveredCount: recoveredIds.size,
        unresolvedCount: unresolvedQuestionIds().length,
        concurrencyReductionCount: 0,
        retryEligibilityWaitMs: retryWaitMs,
        backoffWaitMs,
        deadlineReached: deadlineExpired || deadlineAdmissionExhausted,
        cancelled: cancelled || normalized.signal?.aborted === true,
      });
      normalized.performance.addPhase(
        'geminiRecoveryMs',
        totalRecoveryDurationMs
      );
      if (deadlineExpired || deadlineAdmissionExhausted) {
        normalized.performance.recordRecoveryEvent({
          type: 'DEADLINE',
          waveIndex,
          questionCount: unresolvedQuestionIds().length,
          attempt: null,
          splitDepth: 0,
          reason: 'DEADLINE',
          delayMs: null,
          backoffMs: null,
          concurrency: normalized.concurrency,
        });
      }
      if (cancelled || normalized.signal?.aborted) {
        normalized.performance.recordRecoveryEvent({
          type: 'CANCELLED',
          waveIndex,
          questionCount: unresolvedQuestionIds().length,
          attempt: null,
          splitDepth: 0,
          reason: 'CANCELLED',
          delayMs: null,
          backoffMs: null,
          concurrency: normalized.concurrency,
        });
      }
    }
  }

  if (cancelled || normalized.signal?.aborted) {
    throw new GeminiRecoveryCancelledError();
  }

  if (
    deadlineExpired ||
    deadlineAdmissionExhausted ||
    Date.now() >= deadlineAt
  ) {
    const unresolved = unresolvedQuestionIds();
    finalizeDeadlineQuestions(unresolved);
    if (acceptedIds.size === 0) {
      throw new GeminiRecoveryDeadlineError(
        request.questions.flatMap((question) =>
          deadlineFinalizedIds.has(question.questionId)
            ? [question.questionId]
            : []
        )
      );
    }
  } else {
    finalizeQuestions(unresolvedQuestionIds());
  }

  if (acceptedIds.size === 0 && lastRequestFailure !== null) {
    throw lastRequestFailure;
  }
  if (acceptedIds.size === 0 && results.size === 0) {
    throw new GeminiRecoveryExhaustedError(DEFAULT_FAILURE);
  }

  return {
    cycleId: request.cycleId,
    results: request.questions.map(
      (question) =>
        results.get(question.questionId) ??
        failedResult(question.questionId, DEFAULT_FAILURE)
    ),
  };
}
