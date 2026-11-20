import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
  GenerationResult,
  ProviderErrorCode,
  ProviderErrorContract,
  ProviderProgressObserver,
} from './Contract';
import {
  NVIDIA_BATCH_CONCURRENCY,
  NvidiaBatchCancellationError,
} from './NvidiaBatchExecution';
import {
  NvidiaBatchLimitError,
  planNvidiaBatches,
  type NvidiaBatchLimits,
  type NvidiaQuestionBatch,
} from './NvidiaBatchPlanning';
import {
  createNvidiaPayload,
  type NvidiaGenerationRequest,
  type NvidiaPayloadProfile,
} from './NvidiaRequest';
import {
  NVIDIA_RECOVERY_DEADLINE_MESSAGE,
  NVIDIA_RECOVERY_MAX_ATTEMPTS,
  NVIDIA_RECOVERY_MAX_SPLIT_DEPTH,
  NvidiaRecoveryDeadlineError,
  NvidiaRecoveryExhaustedError,
  computeNvidiaOverallTimeoutMs,
  executeNvidiaRecovery,
} from './NvidiaRecovery';
import {
  NVIDIA_PROVIDER_ID,
  NVIDIA_SERVER_BUSY_MESSAGE,
} from './ProviderIdentity';
import { parseNvidiaSalvageObjects } from './NvidiaSalvage';
import {
  elapsedSince,
  monotonicNow,
  type GenerationPerformanceRecorder,
  type PerformanceOutcome,
  type TransportPerformanceRecord,
} from '../Shared/Performance';

export const NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const NVIDIA_NEMOTRON_LIGHTNING_MODEL =
  'nvidia/nemotron-3.5-lightning-30b-a3b';
export const NVIDIA_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
export const NVIDIA_STATUS_ENDPOINT =
  'https://integrate.api.nvidia.com/v2/nvcf/pexec/status/';
export const NVIDIA_REQUEST_TIMEOUT_MS = 30_000;
export const NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS = 60_000;

// Three worst-case request waves at the current ten-question batch cap.
export const NVIDIA_OVERALL_TIMEOUT_MS = 90_000;
export const NVIDIA_LIGHTNING_OVERALL_TIMEOUT_MS = 180_000;
const NVIDIA_POLL_INTERVAL_MS = 1_000;
const NVIDIA_MAX_POLL_INTERVAL_MS = 30_000;
const NVIDIA_MAX_RETRY_AFTER_MS = 3_600_000;
const NVIDIA_FALLBACK_ERROR_BODY_LIMIT = 16_384;
const NVCF_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface NvidiaModelPolicy {
  readonly modelId: string;
  readonly payloadProfile: NvidiaPayloadProfile;
  readonly requestTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly batchLimits: NvidiaBatchLimits;
  readonly reasoningTokenReserve: number;
}

export const NVIDIA_MODEL_POLICIES: Readonly<
  Record<string, NvidiaModelPolicy>
> = Object.freeze({
  [NVIDIA_MODEL]: Object.freeze({
    modelId: NVIDIA_MODEL,
    payloadProfile: Object.freeze({
      modelId: NVIDIA_MODEL,
      maxTokens: 131072,
      includeResponseFormat: false,
      lightning: false,
    }),
    requestTimeoutMs: NVIDIA_REQUEST_TIMEOUT_MS,
    overallTimeoutMs: NVIDIA_OVERALL_TIMEOUT_MS,
    batchLimits: Object.freeze({
      maxQuestionsPerBatch: 10,
      maxEstimatedInputTokens: 12_000,
      maxEstimatedOutputTokens: 8_000,
      maxSerializedBytes: 48_000,
    }),
    reasoningTokenReserve: 4_096,
  }),
  [NVIDIA_NEMOTRON_LIGHTNING_MODEL]: Object.freeze({
    modelId: NVIDIA_NEMOTRON_LIGHTNING_MODEL,
    payloadProfile: Object.freeze({
      modelId: NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      maxTokens: 32768,
      includeResponseFormat: true,
      lightning: true,
    }),
    requestTimeoutMs: NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS,
    overallTimeoutMs: NVIDIA_LIGHTNING_OVERALL_TIMEOUT_MS,
    batchLimits: Object.freeze({
      maxQuestionsPerBatch: 10,
      maxEstimatedInputTokens: 12_000,
      maxEstimatedOutputTokens: 4_000,
      maxSerializedBytes: 48_000,
    }),
    reasoningTokenReserve: 4_096,
  }),
});

export function getNvidiaModelPolicy(
  modelId: string
): NvidiaModelPolicy | undefined {
  return NVIDIA_MODEL_POLICIES[modelId];
}

export type NvidiaResponseDiagnostic =
  | 'HTTP_STATUS'
  | 'TRANSPORT'
  | 'INVALID_HTTP_RESPONSE_ENVELOPE'
  | 'MISSING_CHOICES'
  | 'INVALID_MESSAGE'
  | 'EMPTY_FINAL_CONTENT'
  | 'REASONING_ONLY'
  | 'UNSUPPORTED_FINISH_REASON'
  | 'TRUNCATED_RESPONSE'
  | 'INVALID_JSON'
  | 'INVALID_GENERATION_RESPONSE'
  | 'MISSING_RESULTS'
  | 'API_KEY_ECHO';

export type NvidiaJsonExtractionOutcome =
  'NOT_ATTEMPTED' | 'DIRECT' | 'MARKDOWN_FENCE' | 'EMBEDDED' | 'FAILED';

export type NvidiaTimeoutStage = 'REQUEST' | 'RESPONSE_BODY' | 'POLLING';

export interface NvidiaResponseUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface NvidiaResponseDiagnostics {
  readonly diagnostic: NvidiaResponseDiagnostic;
  readonly httpStatus: number;
  readonly finishReason: string | null;
  readonly contentPresent: boolean;
  readonly contentLength: number;
  readonly reasoningFieldPresent: boolean;
  readonly reasoningBlockPresent: boolean;
  readonly extractionOutcome: NvidiaJsonExtractionOutcome;
  readonly usage: NvidiaResponseUsage | null;
  readonly modelId?: string;
  readonly attempt?: number;
  readonly elapsedMs?: number;
  readonly fallbackUsed?: boolean;
  readonly pollingUsed?: boolean;
  readonly pollCount?: number;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly timeoutStage?: NvidiaTimeoutStage | null;
}

const SAFE_MESSAGES: Record<ProviderErrorCode, string> = {
  AUTHENTICATION_FAILED: 'Credential invalid.',
  PERMISSION_DENIED: 'Provider access denied.',
  INVALID_REQUEST: 'Provider request was invalid.',
  RATE_LIMITED: 'Provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'Provider unavailable.',
  TIMEOUT: 'Provider request timed out.',
  INCOMPLETE_PROVIDER_RESPONSE:
    'NVIDIA response was truncated before completion.',
  MALFORMED_PROVIDER_RESPONSE: 'Provider returned an invalid response.',
  NETWORK_FAILURE: 'Provider network request failed.',
  PROVIDER_FAILURE: 'Provider request failed.',
};

export class NvidiaProviderError
  extends Error
  implements ProviderErrorContract
{
  public readonly providerId = NVIDIA_PROVIDER_ID;
  public readonly safeMessageCode: 'SERVER_BUSY' | undefined;

  constructor(
    public readonly safeCode: ProviderErrorCode,
    safeMessageCode?: 'SERVER_BUSY',
    public readonly diagnostics?: NvidiaResponseDiagnostics
  ) {
    super(
      safeMessageCode === 'SERVER_BUSY'
        ? NVIDIA_SERVER_BUSY_MESSAGE
        : SAFE_MESSAGES[safeCode]
    );
    this.name = 'NvidiaProviderError';
    this.safeMessageCode = safeMessageCode;
  }
}

function assertUniqueQuestionIds(request: GenerationRequest): void {
  const questionIds = new Set<string>();
  for (const question of request.questions) {
    if (questionIds.has(question.questionId)) {
      throw new NvidiaProviderError('INVALID_REQUEST');
    }
    questionIds.add(question.questionId);
  }
}

type FetchImplementation = typeof fetch;

interface HttpResponseTiming {
  readonly networkRequestMs: number;
  readonly responseBodyReadMs: number;
  readonly totalRequestMs: number;
}

interface HttpResponseText {
  status: number;
  text: string;
  headers: Headers;
  timing: HttpResponseTiming;
}

interface DiagnosticContext {
  readonly finishReason?: unknown;
  readonly contentPresent?: boolean;
  readonly contentLength?: number;
  readonly reasoningFieldPresent?: boolean;
  readonly reasoningBlockPresent?: boolean;
  readonly extractionOutcome?: NvidiaJsonExtractionOutcome;
  readonly usage?: NvidiaResponseUsage | null;
  readonly modelId?: string;
  readonly attempt?: number;
  readonly elapsedMs?: number;
  readonly fallbackUsed?: boolean;
  readonly pollingUsed?: boolean;
  readonly pollCount?: number;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly timeoutStage?: NvidiaTimeoutStage | null;
}

interface RequestTrace {
  readonly modelId: string;
  readonly startedAt: number;
  attempt: number;
  fallbackUsed: boolean;
  pollingUsed: boolean;
  pollCount: number;
  requestId: string | null;
  retryAfterMs: number | null;
  timeoutStage: NvidiaTimeoutStage | null;
}

interface JsonCandidates {
  readonly objects: readonly Record<string, unknown>[];
  readonly outcome: NvidiaJsonExtractionOutcome;
}

interface TransportTimingAccumulator {
  payloadBuildMs: number;
  serializationMs: number;
  networkRequestMs: number;
  responseBodyReadMs: number;
  jsonParseMs: number;
  responseCount: number;
  jsonParseAttempted: boolean;
  pollingUsed: boolean;
  pollCount: number;
  pollWaitMs: number;
  pollRequestMs: number;
  pollNetworkMs: number;
  pollBodyReadMs: number;
  httpStatus: number | null;
  fallbackUsed: boolean;
  retryAfterMs: number | null;
  usage: NvidiaResponseUsage | null;
}

interface ProviderRequestPerformanceContext {
  readonly performance?: GenerationPerformanceRecorder;
  readonly batchIndex?: number;
  readonly attempt?: number;
}

const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeFinishReason(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 64) : null;
}

function createDiagnostics(
  diagnostic: NvidiaResponseDiagnostic,
  httpStatus: number,
  context: DiagnosticContext = {}
): NvidiaResponseDiagnostics {
  return {
    diagnostic,
    httpStatus,
    finishReason: safeFinishReason(context.finishReason),
    contentPresent: context.contentPresent ?? false,
    contentLength: context.contentLength ?? 0,
    reasoningFieldPresent: context.reasoningFieldPresent ?? false,
    reasoningBlockPresent: context.reasoningBlockPresent ?? false,
    extractionOutcome: context.extractionOutcome ?? 'NOT_ATTEMPTED',
    usage: context.usage ?? null,
    ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.elapsedMs !== undefined
      ? { elapsedMs: context.elapsedMs }
      : {}),
    ...(context.fallbackUsed !== undefined
      ? { fallbackUsed: context.fallbackUsed }
      : {}),
    ...(context.pollingUsed !== undefined
      ? { pollingUsed: context.pollingUsed }
      : {}),
    ...(context.pollCount !== undefined
      ? { pollCount: context.pollCount }
      : {}),
    ...(context.requestId !== undefined
      ? { requestId: context.requestId }
      : {}),
    ...(context.retryAfterMs !== undefined
      ? { retryAfterMs: context.retryAfterMs }
      : {}),
    ...(context.timeoutStage !== undefined
      ? { timeoutStage: context.timeoutStage }
      : {}),
  };
}

function createRequestTrace(modelId: string): RequestTrace {
  return {
    modelId,
    startedAt: Date.now(),
    attempt: 1,
    fallbackUsed: false,
    pollingUsed: false,
    pollCount: 0,
    requestId: null,
    retryAfterMs: null,
    timeoutStage: null,
  };
}

function traceDiagnosticContext(trace: RequestTrace): DiagnosticContext {
  return {
    modelId: trace.modelId,
    attempt: trace.attempt,
    elapsedMs: Math.max(0, Date.now() - trace.startedAt),
    fallbackUsed: trace.fallbackUsed,
    pollingUsed: trace.pollingUsed,
    pollCount: trace.pollCount,
    ...(trace.requestId !== null ? { requestId: trace.requestId } : {}),
    ...(trace.retryAfterMs !== null
      ? { retryAfterMs: trace.retryAfterMs }
      : {}),
    ...(trace.timeoutStage !== null
      ? { timeoutStage: trace.timeoutStage }
      : {}),
  };
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function readUsage(value: unknown): NvidiaResponseUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = safeTokenCount(value.prompt_tokens);
  const completionTokens = safeTokenCount(value.completion_tokens);
  const totalTokens = safeTokenCount(value.total_tokens);
  if (
    promptTokens === null &&
    completionTokens === null &&
    totalTokens === null
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function nvidiaDeadlinePartialResponse(
  request: GenerationRequest,
  error: NvidiaRecoveryDeadlineError
): GenerationResponse | null {
  if (error.acceptedResults.length === 0) {
    return null;
  }
  const completedById = new Map(
    error.completedResults.map((result) => [result.questionId, result])
  );
  const results: GenerationResult[] = request.questions.map((question) => {
    const completed = completedById.get(question.questionId);
    if (completed) {
      return completed;
    }
    return {
      questionId: question.questionId,
      status: 'GENERATION_FAILED',
      answer: null,
      failure: {
        code: 'TIMEOUT',
        message: NVIDIA_RECOVERY_DEADLINE_MESSAGE,
      },
    };
  });
  return { cycleId: request.cycleId, results };
}

function recordResponseResultCounts(
  performance: GenerationPerformanceRecorder,
  response: GenerationResponse
): void {
  let generatedCount = 0;
  let abstainedCount = 0;
  let failedCount = 0;
  for (const result of response.results) {
    if (result.status === 'GENERATED') {
      generatedCount += 1;
    } else if (result.status === 'ABSTAINED') {
      abstainedCount += 1;
    } else {
      failedCount += 1;
    }
  }
  performance.setResultProcessing({
    returnedResultCount: response.results.length,
    generatedCount,
    abstainedCount,
    failedCount,
  });
  performance.addCount('returnedResultCount', response.results.length);
  performance.addCount('generatedResultCount', generatedCount);
  performance.addCount('abstainedResultCount', abstainedCount);
  performance.addCount('failedResultCount', failedCount);
}

function responseError(
  safeCode: ProviderErrorCode,
  diagnostic: NvidiaResponseDiagnostic,
  httpStatus: number,
  context: DiagnosticContext = {}
): NvidiaProviderError {
  return new NvidiaProviderError(
    safeCode,
    undefined,
    createDiagnostics(diagnostic, httpStatus, context)
  );
}

function hasReasoningField(message: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(message.reasoning) ||
    isNonEmptyString(message.reasoning_content)
  );
}

function readMessageContent(message: Record<string, unknown>): string | null {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return null;
  }
  const parts = message.content.flatMap((part): string[] => {
    if (typeof part === 'string') {
      return [part];
    }
    if (
      isRecord(part) &&
      part.type === 'text' &&
      typeof part.text === 'string'
    ) {
      return [part.text];
    }
    return [];
  });
  return parts.length > 0 ? parts.join('') : null;
}

const CLOSED_REASONING_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const OPEN_REASONING_BLOCK_PATTERN = /<think\b[^>]*>/i;

function stripReasoningBlocks(content: string): {
  content: string;
  reasoningBlockPresent: boolean;
} {
  if (!/<think\b/i.test(content)) {
    return { content, reasoningBlockPresent: false };
  }
  if (parseJsonObject(content.trim())) {
    return { content, reasoningBlockPresent: false };
  }
  const firstBrace = content.indexOf('{');
  const head = firstBrace >= 0 ? content.slice(0, firstBrace) : content;
  const tail = firstBrace >= 0 ? content.slice(firstBrace) : '';
  let strippedHead = head.replace(CLOSED_REASONING_BLOCK_PATTERN, '');
  const openIndex = strippedHead.search(OPEN_REASONING_BLOCK_PATTERN);
  if (openIndex >= 0) {
    strippedHead = strippedHead.slice(0, openIndex);
  }
  return {
    content: `${strippedHead}${tail}`.trim(),
    reasoningBlockPresent: true,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findTopLevelJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function collectParsedObjects(text: string): Record<string, unknown>[] {
  return findTopLevelJsonObjects(text).flatMap((candidate) => {
    const parsed = parseJsonObject(candidate);
    return parsed ? [parsed] : [];
  });
}

function uniqueObjects(
  objects: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];

  for (const object of objects) {
    const serialized = JSON.stringify(object);
    if (serialized === undefined || seen.has(serialized)) {
      continue;
    }
    seen.add(serialized);
    unique.push(object);
  }

  return unique;
}

function collectJsonCandidates(content: string): JsonCandidates {
  const trimmed = content.trim();
  const direct = parseJsonObject(trimmed);
  if (direct) {
    return { objects: [direct], outcome: 'DIRECT' };
  }

  const fenced: Record<string, unknown>[] = [];
  for (const match of trimmed.matchAll(FENCED_JSON_PATTERN)) {
    const block = match[1];
    if (typeof block !== 'string') {
      continue;
    }
    const fencedText = block.trim();
    const directFence = parseJsonObject(fencedText);
    if (directFence) {
      fenced.push(directFence);
    } else {
      fenced.push(...collectParsedObjects(fencedText));
    }
  }
  const uniqueFenced = uniqueObjects(fenced);
  if (uniqueFenced.length > 0) {
    return { objects: uniqueFenced, outcome: 'MARKDOWN_FENCE' };
  }

  const embedded = uniqueObjects(collectParsedObjects(trimmed));
  if (embedded.length > 0) {
    return { objects: embedded, outcome: 'EMBEDDED' };
  }

  return { objects: [], outcome: 'FAILED' };
}

function selectGenerationObject(
  objects: readonly Record<string, unknown>[]
): Record<string, unknown> | null {
  if (objects.length === 0) {
    return null;
  }
  if (objects.length === 1) {
    return objects[0];
  }

  const generationObjects = objects.filter(
    (object) =>
      typeof object.cycleId === 'string' && Array.isArray(object.results)
  );
  return generationObjects.length === 1 ? generationObjects[0] : null;
}

const ABSTENTION_REASONS = new Set([
  'LOW_CONFIDENCE',
  'UNABLE_TO_DETERMINE',
  'NOT_APPLICABLE',
]);

function isGenerationResultForQuestion(
  result: unknown,
  questionId: string
): boolean {
  if (!isRecord(result) || result.questionId !== questionId) {
    return false;
  }
  if (result.status === 'GENERATED') {
    return (
      isRecord(result.answer) &&
      result.answer.questionId === questionId &&
      'value' in result.answer
    );
  }
  if (result.status === 'ABSTAINED') {
    return (
      result.answer === null &&
      typeof result.reason === 'string' &&
      ABSTENTION_REASONS.has(result.reason)
    );
  }
  if (result.status === 'GENERATION_FAILED') {
    return (
      result.answer === null &&
      isRecord(result.failure) &&
      typeof result.failure.code === 'string' &&
      typeof result.failure.message === 'string'
    );
  }
  return false;
}

type GenerationResponseValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly missingResults: boolean };

function validateGenerationResponseForRequest(
  response: Record<string, unknown>,
  request: GenerationRequest
): GenerationResponseValidation {
  if (
    response.cycleId !== request.cycleId ||
    !Array.isArray(response.results)
  ) {
    return { ok: false, missingResults: false };
  }
  const expectedIds = new Set(
    request.questions.map((question) => question.questionId)
  );
  const seenIds = new Set<string>();
  for (const result of response.results) {
    if (
      !isRecord(result) ||
      typeof result.questionId !== 'string' ||
      !expectedIds.has(result.questionId) ||
      seenIds.has(result.questionId) ||
      !isGenerationResultForQuestion(result, result.questionId)
    ) {
      return { ok: false, missingResults: false };
    }
    seenIds.add(result.questionId);
  }
  if (seenIds.size !== expectedIds.size) {
    return { ok: false, missingResults: true };
  }
  if (response.results.length !== expectedIds.size) {
    return { ok: false, missingResults: false };
  }
  return { ok: true };
}

interface PayloadOptions {
  readonly includeResponseFormat?: boolean;
}

function defaultTimeoutMs(modelId: string): number {
  return (
    getNvidiaModelPolicy(modelId)?.requestTimeoutMs ?? NVIDIA_REQUEST_TIMEOUT_MS
  );
}

function payloadProfileFor(
  modelId: string,
  options: PayloadOptions = {}
): NvidiaPayloadProfile {
  const policy = getNvidiaModelPolicy(modelId);
  if (!policy) {
    throw new NvidiaProviderError('INVALID_REQUEST');
  }
  if (options.includeResponseFormat === undefined) {
    return policy.payloadProfile;
  }
  return {
    ...policy.payloadProfile,
    includeResponseFormat: options.includeResponseFormat,
  };
}

function createPayload(
  request: NvidiaGenerationRequest,
  modelId: string,
  options: PayloadOptions = {}
): Record<string, unknown> {
  return createNvidiaPayload(request, payloadProfileFor(modelId, options));
}

const RESPONSE_FORMAT_REJECTION_MARKERS = [
  'unsupported',
  'not supported',
  'not support',
  'does not support',
  'unknown parameter',
  'unknown field',
  'unrecognized',
  'unexpected',
  'not permitted',
  'not allowed',
  'not available',
  'invalid parameter',
  'extra fields',
  'extra inputs',
  'additional propert',
] as const;

function isResponseFormatRejection(response: HttpResponseText): boolean {
  if (response.status !== 400 && response.status !== 422) {
    return false;
  }
  const body = response.text
    .slice(0, NVIDIA_FALLBACK_ERROR_BODY_LIMIT)
    .toLowerCase();
  if (
    !body.includes('response_format') &&
    !body.includes('response format') &&
    !body.includes('responseformat')
  ) {
    return false;
  }
  return RESPONSE_FORMAT_REJECTION_MARKERS.some((marker) =>
    body.includes(marker)
  );
}

function pollIntervalMs(headers: Headers, fallbackMs: number): number {
  const raw = headers.get('NVCF-POLL-SECONDS');
  if (!raw) {
    return fallbackMs;
  }
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return fallbackMs;
  }
  return Math.min(seconds * 1_000, NVIDIA_MAX_POLL_INTERVAL_MS);
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, NVIDIA_MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.min(
    Math.max(0, timestamp - Date.now()),
    NVIDIA_MAX_RETRY_AFTER_MS
  );
}

function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status >= 200 && status < 300) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_FAILURE';
}

function transportFailureCode(
  error: unknown,
  timedOut: boolean
): ProviderErrorCode {
  if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
    return 'TIMEOUT';
  }
  return error instanceof TypeError
    ? 'NETWORK_FAILURE'
    : 'PROVIDER_UNAVAILABLE';
}

async function requestText(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  trace: RequestTrace,
  stage: NvidiaTimeoutStage,
  signal?: AbortSignal
): Promise<HttpResponseText> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  let timedOut = false;
  let timeoutStage = stage;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const requestStartedAt = monotonicNow();
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const headersReceivedAt = monotonicNow();
    if (stage !== 'POLLING') {
      timeoutStage = 'RESPONSE_BODY';
    }
    const text = await response.text();
    const bodyReadAt = monotonicNow();
    return {
      status: response.status,
      text,
      headers: response.headers ?? new Headers(),
      timing: {
        networkRequestMs: elapsedSince(requestStartedAt, headersReceivedAt),
        responseBodyReadMs: elapsedSince(headersReceivedAt, bodyReadAt),
        totalRequestMs: elapsedSince(requestStartedAt, bodyReadAt),
      },
    };
  } catch (error) {
    if (timedOut) {
      trace.timeoutStage = timeoutStage;
    }
    throw new NvidiaProviderError(
      transportFailureCode(error, timedOut),
      undefined,
      createDiagnostics('TRANSPORT', 0, traceDiagnosticContext(trace))
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function postJson(
  apiKey: string,
  body: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  trace: RequestTrace,
  signal?: AbortSignal
): Promise<HttpResponseText> {
  return requestText(
    NVIDIA_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    },
    fetchImpl,
    timeoutMs,
    trace,
    'REQUEST',
    signal
  );
}

async function getPendingResult(
  apiKey: string,
  requestId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  trace: RequestTrace,
  signal?: AbortSignal
): Promise<HttpResponseText> {
  return requestText(
    `${NVIDIA_STATUS_ENDPOINT}${encodeURIComponent(requestId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    },
    fetchImpl,
    timeoutMs,
    trace,
    'POLLING',
    signal
  );
}

function delay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NvidiaProviderError('PROVIDER_UNAVAILABLE'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NvidiaProviderError('PROVIDER_UNAVAILABLE'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function awaitPendingResult(
  response: HttpResponseText,
  apiKey: string,
  fetchImpl: FetchImplementation,
  deadline: number,
  trace: RequestTrace,
  signal?: AbortSignal,
  transport?: TransportTimingAccumulator
): Promise<HttpResponseText> {
  if (response.status !== 202) {
    return response;
  }
  trace.pollingUsed = true;
  if (transport) {
    transport.pollingUsed = true;
  }
  const requestId = response.headers.get('NVCF-REQID');
  if (!requestId || !NVCF_REQUEST_ID_PATTERN.test(requestId)) {
    throw responseError(
      'PROVIDER_UNAVAILABLE',
      'HTTP_STATUS',
      202,
      traceDiagnosticContext(trace)
    );
  }
  trace.requestId = requestId;
  let intervalMs = pollIntervalMs(response.headers, NVIDIA_POLL_INTERVAL_MS);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const waitStartedAt = transport ? monotonicNow() : 0;
    await delay(Math.min(intervalMs, remaining), signal);
    if (transport) {
      transport.pollWaitMs += elapsedSince(waitStartedAt);
    }
    if (Date.now() >= deadline) {
      break;
    }
    trace.pollCount += 1;
    if (transport) {
      transport.pollCount += 1;
    }
    const polled = await getPendingResult(
      apiKey,
      requestId,
      fetchImpl,
      Math.max(1, deadline - Date.now()),
      trace,
      signal
    );
    if (transport) {
      transport.pollNetworkMs += polled.timing.networkRequestMs;
      transport.pollBodyReadMs += polled.timing.responseBodyReadMs;
      transport.pollRequestMs += polled.timing.totalRequestMs;
    }
    if (polled.status !== 202) {
      trace.retryAfterMs = retryAfterMs(polled.headers);
      if (transport) {
        transport.retryAfterMs = trace.retryAfterMs;
        transport.httpStatus = polled.status;
      }
      return polled;
    }
    intervalMs = pollIntervalMs(polled.headers, intervalMs);
    const nextRequestId = polled.headers.get('NVCF-REQID');
    if (nextRequestId && NVCF_REQUEST_ID_PATTERN.test(nextRequestId)) {
      trace.requestId = nextRequestId;
    }
  }
  trace.timeoutStage = 'POLLING';
  throw new NvidiaProviderError(
    'TIMEOUT',
    undefined,
    createDiagnostics('HTTP_STATUS', 202, traceDiagnosticContext(trace))
  );
}

interface CompletionExtraction {
  readonly objects: readonly Record<string, unknown>[];
  readonly outcome: NvidiaJsonExtractionOutcome;
  readonly diagnosticContext: DiagnosticContext;
}

function extractCompletionCandidates(
  value: unknown,
  apiKey: string,
  httpStatus: number,
  trace: RequestTrace
): CompletionExtraction {
  const traceContext = traceDiagnosticContext(trace);
  const failure = (
    safeCode: ProviderErrorCode,
    diagnostic: NvidiaResponseDiagnostic,
    context: DiagnosticContext = {}
  ): NvidiaProviderError =>
    responseError(safeCode, diagnostic, httpStatus, {
      ...traceContext,
      ...context,
    });

  if (!isRecord(value)) {
    throw failure(
      'MALFORMED_PROVIDER_RESPONSE',
      'INVALID_HTTP_RESPONSE_ENVELOPE'
    );
  }
  const usage = readUsage(value.usage);
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw failure('MALFORMED_PROVIDER_RESPONSE', 'MISSING_CHOICES', { usage });
  }

  const choice = value.choices[0];
  if (!isRecord(choice)) {
    throw failure('MALFORMED_PROVIDER_RESPONSE', 'INVALID_MESSAGE', { usage });
  }

  const finishReason = choice.finish_reason;
  if (finishReason === 'length') {
    throw failure('INCOMPLETE_PROVIDER_RESPONSE', 'TRUNCATED_RESPONSE', {
      finishReason,
      usage,
    });
  }

  if (!isRecord(choice.message)) {
    throw failure('MALFORMED_PROVIDER_RESPONSE', 'INVALID_MESSAGE', {
      finishReason,
      usage,
    });
  }

  const message = choice.message;
  const rawContent = readMessageContent(message) ?? '';
  const stripped = stripReasoningBlocks(rawContent);
  const content = stripped.content;
  const contentPresent = content.trim().length > 0;
  const contentLength = rawContent.length;
  const reasoningFieldPresent = hasReasoningField(message);
  const reasoningBlockPresent = stripped.reasoningBlockPresent;
  const diagnosticContext = {
    finishReason,
    contentPresent,
    contentLength,
    reasoningFieldPresent,
    reasoningBlockPresent,
    usage,
  };

  if (message.role !== 'assistant') {
    throw failure(
      'MALFORMED_PROVIDER_RESPONSE',
      'INVALID_MESSAGE',
      diagnosticContext
    );
  }

  if (!contentPresent) {
    const reasoningPresent = reasoningFieldPresent || reasoningBlockPresent;
    throw failure(
      reasoningPresent
        ? 'INCOMPLETE_PROVIDER_RESPONSE'
        : 'MALFORMED_PROVIDER_RESPONSE',
      reasoningPresent ? 'REASONING_ONLY' : 'EMPTY_FINAL_CONTENT',
      diagnosticContext
    );
  }

  if (
    finishReason !== undefined &&
    finishReason !== null &&
    finishReason !== 'stop'
  ) {
    throw failure(
      'MALFORMED_PROVIDER_RESPONSE',
      'UNSUPPORTED_FINISH_REASON',
      diagnosticContext
    );
  }

  if (apiKey && content.includes(apiKey)) {
    throw failure('PROVIDER_FAILURE', 'API_KEY_ECHO', diagnosticContext);
  }

  const candidates = collectJsonCandidates(content);
  return {
    objects: candidates.objects,
    outcome: candidates.outcome,
    diagnosticContext: {
      ...traceContext,
      ...diagnosticContext,
      extractionOutcome: candidates.outcome,
    },
  };
}

function parseCompletionEnvelope(
  value: unknown,
  apiKey: string,
  httpStatus: number,
  request: GenerationRequest,
  trace: RequestTrace
): GenerationResponse {
  const extraction = extractCompletionCandidates(
    value,
    apiKey,
    httpStatus,
    trace
  );
  const selected = selectGenerationObject(extraction.objects);
  if (!selected) {
    throw new NvidiaProviderError(
      'MALFORMED_PROVIDER_RESPONSE',
      undefined,
      createDiagnostics(
        'INVALID_JSON',
        httpStatus,
        extraction.diagnosticContext
      )
    );
  }

  const validation = validateGenerationResponseForRequest(selected, request);
  if (!validation.ok) {
    throw new NvidiaProviderError(
      validation.missingResults
        ? 'INCOMPLETE_PROVIDER_RESPONSE'
        : 'MALFORMED_PROVIDER_RESPONSE',
      undefined,
      createDiagnostics(
        validation.missingResults
          ? 'MISSING_RESULTS'
          : 'INVALID_GENERATION_RESPONSE',
        httpStatus,
        extraction.diagnosticContext
      )
    );
  }

  return selected as unknown as GenerationResponse;
}

function parseCompletionEnvelopeLenient(
  value: unknown,
  apiKey: string,
  httpStatus: number,
  request: GenerationRequest,
  trace: RequestTrace,
  performance?: GenerationPerformanceRecorder
): GenerationResponse {
  const extraction = extractCompletionCandidates(
    value,
    apiKey,
    httpStatus,
    trace
  );
  // Salvage tolerates partial and individually invalid results, but a response
  // that is structurally ambiguous or belongs to another cycle must keep the
  // strict classification instead of being silently merged.
  const generationObjects = extraction.objects.filter(
    (object) => 'cycleId' in object || 'results' in object
  );
  if (generationObjects.length > 1) {
    throw new NvidiaProviderError(
      'MALFORMED_PROVIDER_RESPONSE',
      undefined,
      createDiagnostics(
        'INVALID_JSON',
        httpStatus,
        extraction.diagnosticContext
      )
    );
  }
  if (generationObjects.length === 1) {
    const candidate = generationObjects[0];
    const results = candidate.results;
    if (candidate.cycleId !== request.cycleId || !Array.isArray(results)) {
      throw new NvidiaProviderError(
        'MALFORMED_PROVIDER_RESPONSE',
        undefined,
        createDiagnostics(
          'INVALID_GENERATION_RESPONSE',
          httpStatus,
          extraction.diagnosticContext
        )
      );
    }
    const seenIds = new Set<string>();
    for (const result of results) {
      if (isRecord(result) && typeof result.questionId === 'string') {
        if (seenIds.has(result.questionId)) {
          throw new NvidiaProviderError(
            'MALFORMED_PROVIDER_RESPONSE',
            undefined,
            createDiagnostics(
              'INVALID_GENERATION_RESPONSE',
              httpStatus,
              extraction.diagnosticContext
            )
          );
        }
        seenIds.add(result.questionId);
      }
    }
  }
  const salvage = parseNvidiaSalvageObjects(extraction.objects, request);
  performance?.setResultProcessing({
    salvagedResultCount: salvage.results.length,
  });
  performance?.addCount('salvageCandidateCount', salvage.candidateCount);
  performance?.addCount(
    'salvageAcceptedQuestionCount',
    salvage.acceptedQuestionIds.length
  );
  performance?.addCount(
    'salvageMissingQuestionCount',
    salvage.missingQuestionIds.length
  );
  performance?.addCount(
    'salvageInvalidQuestionCount',
    salvage.invalidQuestionIds.length
  );
  performance?.addCount(
    'salvageIgnoredResultCount',
    salvage.ignoredResultCount
  );
  if (!salvage.hasUsableResult) {
    const missingAll =
      salvage.candidateCount > 0 &&
      salvage.missingQuestionIds.length === request.questions.length;
    throw new NvidiaProviderError(
      salvage.candidateCount === 0
        ? 'MALFORMED_PROVIDER_RESPONSE'
        : missingAll
          ? 'INCOMPLETE_PROVIDER_RESPONSE'
          : 'MALFORMED_PROVIDER_RESPONSE',
      undefined,
      createDiagnostics(
        salvage.candidateCount === 0
          ? 'INVALID_JSON'
          : missingAll
            ? 'MISSING_RESULTS'
            : 'INVALID_GENERATION_RESPONSE',
        httpStatus,
        extraction.diagnosticContext
      )
    );
  }
  return {
    cycleId: request.cycleId,
    results: [...salvage.results],
  };
}

interface CompletionTransfer {
  readonly envelope: unknown;
  readonly httpStatus: number;
  readonly trace: RequestTrace;
}

async function requestCompletionTransfer(
  apiKey: string,
  request: NvidiaGenerationRequest,
  modelId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  signal?: AbortSignal,
  context: ProviderRequestPerformanceContext = {}
): Promise<CompletionTransfer> {
  const deadline = Date.now() + timeoutMs;
  const trace = createRequestTrace(modelId);
  const performance = context.performance;
  const transportStartedAt = performance ? monotonicNow() : 0;
  const transport: TransportTimingAccumulator = {
    payloadBuildMs: 0,
    serializationMs: 0,
    networkRequestMs: 0,
    responseBodyReadMs: 0,
    jsonParseMs: 0,
    responseCount: 0,
    jsonParseAttempted: false,
    pollingUsed: false,
    pollCount: 0,
    pollWaitMs: 0,
    pollRequestMs: 0,
    pollNetworkMs: 0,
    pollBodyReadMs: 0,
    httpStatus: null,
    fallbackUsed: false,
    retryAfterMs: null,
    usage: null,
  };
  let succeeded = false;
  let failureCategory: string | null = null;
  try {
    const payloadStartedAt = monotonicNow();
    let payload = createPayload(request, modelId);
    transport.payloadBuildMs += elapsedSince(payloadStartedAt);
    const serializationStartedAt = monotonicNow();
    const serializedPayload = JSON.stringify(payload);
    transport.serializationMs += elapsedSince(serializationStartedAt);
    let response = await postJson(
      apiKey,
      serializedPayload,
      fetchImpl,
      Math.max(1, deadline - Date.now()),
      trace,
      signal
    );
    transport.networkRequestMs += response.timing.networkRequestMs;
    transport.responseBodyReadMs += response.timing.responseBodyReadMs;
    transport.responseCount += 1;
    transport.httpStatus = response.status;
    if (
      payload.response_format !== undefined &&
      isResponseFormatRejection(response)
    ) {
      trace.fallbackUsed = true;
      trace.attempt = 2;
      transport.fallbackUsed = true;
      const fallbackStartedAt = monotonicNow();
      payload = createPayload(request, modelId, {
        includeResponseFormat: false,
      });
      transport.payloadBuildMs += elapsedSince(fallbackStartedAt);
      const fallbackSerializationStartedAt = monotonicNow();
      const fallbackSerialized = JSON.stringify(payload);
      transport.serializationMs += elapsedSince(fallbackSerializationStartedAt);
      response = await postJson(
        apiKey,
        fallbackSerialized,
        fetchImpl,
        Math.max(1, deadline - Date.now()),
        trace,
        signal
      );
      transport.networkRequestMs += response.timing.networkRequestMs;
      transport.responseBodyReadMs += response.timing.responseBodyReadMs;
      transport.responseCount += 1;
      transport.httpStatus = response.status;
    }
    response = await awaitPendingResult(
      response,
      apiKey,
      fetchImpl,
      deadline,
      trace,
      signal,
      transport
    );
    transport.httpStatus = response.status;
    if (response.status !== 200) {
      trace.retryAfterMs = retryAfterMs(response.headers);
      transport.retryAfterMs = trace.retryAfterMs;
      throw new NvidiaProviderError(
        classifyHttpStatus(response.status),
        response.status === 503 ? 'SERVER_BUSY' : undefined,
        createDiagnostics(
          'HTTP_STATUS',
          response.status,
          traceDiagnosticContext(trace)
        )
      );
    }

    let envelope: unknown;
    const parseStartedAt = monotonicNow();
    transport.jsonParseAttempted = true;
    try {
      envelope = JSON.parse(response.text);
    } catch {
      transport.jsonParseMs += elapsedSince(parseStartedAt);
      throw responseError(
        'MALFORMED_PROVIDER_RESPONSE',
        'INVALID_HTTP_RESPONSE_ENVELOPE',
        response.status,
        traceDiagnosticContext(trace)
      );
    }
    transport.jsonParseMs += elapsedSince(parseStartedAt);
    transport.usage = isRecord(envelope) ? readUsage(envelope.usage) : null;
    succeeded = true;
    return { envelope, httpStatus: response.status, trace };
  } catch (error) {
    failureCategory =
      error instanceof NvidiaProviderError
        ? error.safeCode
        : 'PROVIDER_FAILURE';
    throw error;
  } finally {
    if (performance) {
      const totalTransportMs = elapsedSince(transportStartedAt);
      performance.recordTransport({
        batchIndex: context.batchIndex ?? null,
        attempt: context.attempt ?? trace.attempt,
        modelId,
        requestPreparationMs:
          transport.payloadBuildMs + transport.serializationMs,
        payloadBuildMs: transport.payloadBuildMs,
        serializationMs: transport.serializationMs,
        networkRequestMs:
          transport.responseCount > 0 ? transport.networkRequestMs : null,
        httpStatus: transport.httpStatus,
        responseBodyReadMs:
          transport.responseCount > 0 ? transport.responseBodyReadMs : null,
        jsonParseMs: transport.jsonParseAttempted
          ? transport.jsonParseMs
          : null,
        pollingUsed: transport.pollingUsed,
        pollCount: transport.pollCount,
        pollWaitMs: transport.pollingUsed ? transport.pollWaitMs : null,
        pollRequestMs: transport.pollingUsed ? transport.pollRequestMs : null,
        pollNetworkMs: transport.pollingUsed ? transport.pollNetworkMs : null,
        pollBodyReadMs: transport.pollingUsed ? transport.pollBodyReadMs : null,
        totalTransportMs,
        fallbackUsed: transport.fallbackUsed,
        retryAfterMs: transport.retryAfterMs,
        usage: transport.usage,
        outcome: succeeded ? 'SUCCESS' : 'FAILURE',
        failureCategory,
      } satisfies TransportPerformanceRecord);
    }
  }
}

async function requestGenerationResponse(
  apiKey: string,
  request: NvidiaGenerationRequest,
  modelId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  signal?: AbortSignal,
  context: ProviderRequestPerformanceContext = {}
): Promise<GenerationResponse> {
  const transfer = await requestCompletionTransfer(
    apiKey,
    request,
    modelId,
    fetchImpl,
    timeoutMs,
    signal,
    context
  );
  const parseStartedAt = context.performance ? monotonicNow() : 0;
  const response = parseCompletionEnvelope(
    transfer.envelope,
    apiKey,
    transfer.httpStatus,
    request,
    transfer.trace
  );
  if (context.performance) {
    const responseValidationMs = elapsedSince(parseStartedAt);
    context.performance.addPhase(
      'providerResponseValidationMs',
      responseValidationMs
    );
    context.performance.setResultProcessing({ responseValidationMs });
  }
  return response;
}

async function requestGenerationSalvageAttempt(
  apiKey: string,
  request: NvidiaGenerationRequest,
  modelId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  signal?: AbortSignal,
  context: ProviderRequestPerformanceContext = {}
): Promise<GenerationResponse> {
  const transfer = await requestCompletionTransfer(
    apiKey,
    request,
    modelId,
    fetchImpl,
    timeoutMs,
    signal,
    context
  );
  const parseStartedAt = context.performance ? monotonicNow() : 0;
  const response = parseCompletionEnvelopeLenient(
    transfer.envelope,
    apiKey,
    transfer.httpStatus,
    request,
    transfer.trace,
    context.performance
  );
  if (context.performance) {
    const salvageMs = elapsedSince(parseStartedAt);
    context.performance.addPhase('providerSalvageMs', salvageMs);
    context.performance.setResultProcessing({ salvageMs });
  }
  return response;
}

export class NvidiaProvider implements GenerationInterface {
  constructor(
    private readonly apiKey: string,
    private readonly modelId = NVIDIA_MODEL,
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly timeoutMs?: number,
    private readonly overallTimeoutMs?: number
  ) {}

  async generate(
    request: GenerationRequest,
    signal?: AbortSignal,
    performance?: GenerationPerformanceRecorder,
    onProgress?: ProviderProgressObserver
  ): Promise<GenerationResponse> {
    const providerStartedAt = performance ? monotonicNow() : 0;
    let outcome: PerformanceOutcome = 'UNKNOWN';
    performance?.setModelId(this.modelId);
    performance?.addCount('expectedQuestionCount', request.questions.length);
    performance?.setResultProcessing({
      expectedQuestionCount: request.questions.length,
    });
    try {
      const policy = getNvidiaModelPolicy(this.modelId);
      if (!policy) {
        throw new NvidiaProviderError('INVALID_REQUEST');
      }
      if (request.questions.length === 0) {
        performance?.setMeasurementStatus('batches', 'NOT_APPLICABLE');
        performance?.setMeasurementStatus('transports', 'NOT_APPLICABLE');
        performance?.setMeasurementStatus('recovery', 'NOT_APPLICABLE');
        performance?.setMeasurementStatus('resultProcessing', 'NOT_APPLICABLE');
        outcome = 'SUCCESS';
        return { cycleId: request.cycleId, results: [] };
      }
      assertUniqueQuestionIds(request);

      const timeoutMs = this.timeoutMs ?? policy.requestTimeoutMs;
      let batches: NvidiaQuestionBatch[];
      const planningStartedAt = performance ? monotonicNow() : 0;
      try {
        batches = planNvidiaBatches(request, policy.batchLimits, {
          payloadProfile: policy.payloadProfile,
          reasoningTokenReserve: policy.reasoningTokenReserve,
        });
        if (performance) {
          performance.addPhase(
            'batchPlanningMs',
            elapsedSince(planningStartedAt)
          );
          performance.addCount('plannedBatchCount', batches.length);
        }
      } catch (error) {
        if (error instanceof NvidiaBatchLimitError) {
          throw new NvidiaProviderError('INVALID_REQUEST');
        }
        throw error;
      }

      const overallTimeoutMs =
        this.overallTimeoutMs ??
        computeNvidiaOverallTimeoutMs({
          initialBatchQuestionCounts: batches.map(
            (batch) => batch.questions.length
          ),
          concurrency: NVIDIA_BATCH_CONCURRENCY,
          requestTimeoutMs: timeoutMs,
          minimumTimeoutMs: policy.overallTimeoutMs,
          maxAttempts: NVIDIA_RECOVERY_MAX_ATTEMPTS,
          maxSplitDepth: NVIDIA_RECOVERY_MAX_SPLIT_DEPTH,
        });

      let response: GenerationResponse;
      try {
        response = await executeNvidiaRecovery(
          request,
          batches,
          (batchRequest, batchSignal, context) =>
            requestGenerationSalvageAttempt(
              this.apiKey,
              batchRequest,
              this.modelId,
              this.fetchImpl,
              timeoutMs,
              batchSignal,
              performance
                ? {
                    performance,
                    batchIndex: context?.batchIndex,
                    attempt: context?.attempt,
                  }
                : {}
            ),
          {
            signal,
            overallTimeoutMs,
            limits: policy.batchLimits,
            payloadProfile: policy.payloadProfile,
            reasoningTokenReserve: policy.reasoningTokenReserve,
            ...(performance ? { performance } : {}),
            ...(onProgress ? { onResultsFinalized: onProgress } : {}),
          }
        );
      } catch (error) {
        if (error instanceof NvidiaRecoveryDeadlineError) {
          const partial = nvidiaDeadlinePartialResponse(request, error);
          if (!partial) {
            throw new NvidiaProviderError('TIMEOUT');
          }
          response = partial;
        } else if (error instanceof NvidiaBatchCancellationError) {
          throw new NvidiaProviderError('PROVIDER_UNAVAILABLE');
        } else if (error instanceof NvidiaRecoveryExhaustedError) {
          throw new NvidiaProviderError(
            error.safeCode,
            error.safeMessageCode === 'SERVER_BUSY'
              ? 'SERVER_BUSY'
              : undefined,
            error.diagnostics as NvidiaResponseDiagnostics | undefined
          );
        } else {
          throw error;
        }
      }

      const validationStartedAt = performance ? monotonicNow() : 0;
      const validation = validateGenerationResponseForRequest(
        response as unknown as Record<string, unknown>,
        request
      );
      if (!validation.ok) {
        throw new NvidiaProviderError(
          validation.missingResults
            ? 'INCOMPLETE_PROVIDER_RESPONSE'
            : 'MALFORMED_PROVIDER_RESPONSE'
        );
      }
      if (performance) {
        const strictValidationMs = elapsedSince(validationStartedAt);
        performance.addPhase('providerStrictValidationMs', strictValidationMs);
        performance.setResultProcessing({ strictValidationMs });
        recordResponseResultCounts(performance, response);
      }
      outcome = 'SUCCESS';
      return response;
    } catch (error) {
      outcome = signal?.aborted
        ? 'CANCELLED'
        : error instanceof NvidiaProviderError && error.safeCode === 'TIMEOUT'
          ? 'DEADLINE'
          : 'FAILURE';
      throw error;
    } finally {
      if (performance) {
        performance.addPhase(
          'providerGenerationMs',
          elapsedSince(providerStartedAt)
        );
        performance.finish(outcome);
      }
    }
  }
}

export async function validateNvidiaCredential(
  apiKey: string,
  modelId: string,
  fetchImpl: FetchImplementation = fetch,
  timeoutMs = defaultTimeoutMs(modelId)
): Promise<void> {
  if (!getNvidiaModelPolicy(modelId)) {
    throw new NvidiaProviderError('INVALID_REQUEST');
  }

  const probeRequest: GenerationRequest = {
    cycleId: 'nvidia-credential-validation',
    pageId: 'nvidia-credential-validation',
    questions: [
      {
        questionId: 'nvidia-validation-question',
        text: 'In one short sentence, describe a benefit of labeling shared garden tools.',
        type: 'short-text',
        required: true,
        options: [],
      },
    ],
    settledContext: [],
  };
  await requestGenerationResponse(
    apiKey,
    probeRequest,
    modelId,
    fetchImpl,
    timeoutMs
  );
}
