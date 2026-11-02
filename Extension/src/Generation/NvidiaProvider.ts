import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
  ProviderErrorCode,
  ProviderErrorContract,
} from './Contract';
import { systemInstruction } from './SystemInstructions';
import { buildAnswerPartsInstructions } from './AnswerParts';

export const NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const NVIDIA_NEMOTRON_LIGHTNING_MODEL =
  'nvidia/nemotron-3.5-lightning-30b-a3b';
export const NVIDIA_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
export const NVIDIA_STATUS_ENDPOINT =
  'https://integrate.api.nvidia.com/v2/nvcf/pexec/status/';
export const NVIDIA_REQUEST_TIMEOUT_MS = 30_000;
export const NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS = 60_000;
const NVIDIA_POLL_INTERVAL_MS = 1_000;
const NVIDIA_MAX_POLL_INTERVAL_MS = 30_000;
const NVIDIA_MAX_RETRY_AFTER_MS = 3_600_000;
const NVIDIA_FALLBACK_ERROR_BODY_LIMIT = 16_384;
const NVCF_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NVIDIA_MODEL_MAX_TOKENS: Readonly<Record<string, number>> = Object.freeze(
  {
    [NVIDIA_MODEL]: 16384,
    [NVIDIA_NEMOTRON_LIGHTNING_MODEL]: 32768,
  }
);
const NVIDIA_MODELS = new Set(Object.keys(NVIDIA_MODEL_MAX_TOKENS));

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
  public readonly providerId = 'nvidia';
  public readonly safeMessageCode: 'SERVER_BUSY' | undefined;

  constructor(
    public readonly safeCode: ProviderErrorCode,
    safeMessageCode?: 'SERVER_BUSY',
    public readonly diagnostics?: NvidiaResponseDiagnostics
  ) {
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'NvidiaProviderError';
    this.safeMessageCode = safeMessageCode;
  }
}

type FetchImplementation = typeof fetch;

interface HttpResponseText {
  status: number;
  text: string;
  headers: Headers;
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

function createUserContent(request: GenerationRequest): string {
  const answerPartsInstructions = buildAnswerPartsInstructions(
    request.questions
  );
  return JSON.stringify({
    task:
      'Generate answers for the supplied questions.' +
      (answerPartsInstructions.length > 0
        ? ' ' + answerPartsInstructions.join(' ')
        : ''),
    cycleId: request.cycleId,
    questions: request.questions,
    settledContext: request.settledContext,
    responseContract: {
      format:
        'Return one JSON object only. Do not include Markdown fences, commentary, reasoning, or <think> tags.',
      requiredTopLevelFields: ['cycleId', 'results'],
      cycleId: 'Copy the nonblank cycleId from this request exactly.',
      results:
        'Return an array with exactly one result for every supplied question. Each questionId must be unique and match one supplied questionId.',
      numberOfResults: request.questions.length,
      responseExample: {
        cycleId: request.cycleId,
        results: [
          {
            questionId: '<supplied questionId>',
            status: 'GENERATED',
            answer: {
              questionId: '<same supplied questionId>',
              value: '<answer value>',
            },
          },
        ],
      },
      resultVariants: {
        GENERATED:
          '{ questionId, status: "GENERATED", answer: { questionId: same questionId, value } }',
        ABSTAINED:
          '{ questionId, status: "ABSTAINED", answer: null, reason: "LOW_CONFIDENCE" | "UNABLE_TO_DETERMINE" | "NOT_APPLICABLE" }',
        GENERATION_FAILED:
          '{ questionId, status: "GENERATION_FAILED", answer: null, failure: { code: string, message: string } }',
      },
      answerRules:
        'short-text and paragraph values must be strings; single-choice values must be one supplied option string; multiple-choice values must be arrays of distinct strings, each matching a supplied option.',
    },
  });
}

interface PayloadOptions {
  readonly includeResponseFormat?: boolean;
}

function defaultTimeoutMs(modelId: string): number {
  return modelId === NVIDIA_NEMOTRON_LIGHTNING_MODEL
    ? NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS
    : NVIDIA_REQUEST_TIMEOUT_MS;
}

function createPayload(
  request: GenerationRequest,
  modelId: string,
  options: PayloadOptions = {}
): Record<string, unknown> {
  const maxTokens = NVIDIA_MODEL_MAX_TOKENS[modelId];
  if (maxTokens === undefined) {
    throw new NvidiaProviderError('INVALID_REQUEST');
  }
  const isLightning = modelId === NVIDIA_NEMOTRON_LIGHTNING_MODEL;
  const reasoningParameters = isLightning
    ? { chat_template_kwargs: { enable_thinking: false } }
    : { reasoning_effort: 'low' };
  const includeResponseFormat = options.includeResponseFormat ?? isLightning;
  return {
    model: modelId,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: createUserContent(request) },
    ],
    temperature: 1.0,
    top_p: 0.95,
    max_tokens: maxTokens,
    ...reasoningParameters,
    ...(includeResponseFormat
      ? { response_format: { type: 'json_object' } }
      : {}),
    stream: false,
  };
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
  stage: NvidiaTimeoutStage
): Promise<HttpResponseText> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutStage = stage;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (stage !== 'POLLING') {
      timeoutStage = 'RESPONSE_BODY';
    }
    const text = await response.text();
    return {
      status: response.status,
      text,
      headers: response.headers ?? new Headers(),
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
  }
}

async function postJson(
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  trace: RequestTrace
): Promise<HttpResponseText> {
  return requestText(
    NVIDIA_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    fetchImpl,
    timeoutMs,
    trace,
    'REQUEST'
  );
}

async function getPendingResult(
  apiKey: string,
  requestId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number,
  trace: RequestTrace
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
    'POLLING'
  );
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function awaitPendingResult(
  response: HttpResponseText,
  apiKey: string,
  fetchImpl: FetchImplementation,
  deadline: number,
  trace: RequestTrace
): Promise<HttpResponseText> {
  if (response.status !== 202) {
    return response;
  }
  trace.pollingUsed = true;
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
    await delay(Math.min(intervalMs, remaining));
    if (Date.now() >= deadline) {
      break;
    }
    trace.pollCount += 1;
    const polled = await getPendingResult(
      apiKey,
      requestId,
      fetchImpl,
      Math.max(1, deadline - Date.now()),
      trace
    );
    if (polled.status !== 202) {
      trace.retryAfterMs = retryAfterMs(polled.headers);
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

function parseCompletionEnvelope(
  value: unknown,
  apiKey: string,
  httpStatus: number,
  request: GenerationRequest,
  trace: RequestTrace
): GenerationResponse {
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
  const selected = selectGenerationObject(candidates.objects);
  if (!selected) {
    throw failure('MALFORMED_PROVIDER_RESPONSE', 'INVALID_JSON', {
      ...diagnosticContext,
      extractionOutcome: candidates.outcome,
    });
  }

  const validation = validateGenerationResponseForRequest(selected, request);
  if (!validation.ok) {
    throw failure(
      validation.missingResults
        ? 'INCOMPLETE_PROVIDER_RESPONSE'
        : 'MALFORMED_PROVIDER_RESPONSE',
      validation.missingResults
        ? 'MISSING_RESULTS'
        : 'INVALID_GENERATION_RESPONSE',
      {
        ...diagnosticContext,
        extractionOutcome: candidates.outcome,
      }
    );
  }

  return selected as unknown as GenerationResponse;
}

async function requestGenerationResponse(
  apiKey: string,
  request: GenerationRequest,
  modelId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number
): Promise<GenerationResponse> {
  const deadline = Date.now() + timeoutMs;
  const trace = createRequestTrace(modelId);
  let payload = createPayload(request, modelId);
  let response = await postJson(
    apiKey,
    payload,
    fetchImpl,
    Math.max(1, deadline - Date.now()),
    trace
  );
  if (
    payload.response_format !== undefined &&
    isResponseFormatRejection(response)
  ) {
    trace.fallbackUsed = true;
    trace.attempt = 2;
    payload = createPayload(request, modelId, {
      includeResponseFormat: false,
    });
    response = await postJson(
      apiKey,
      payload,
      fetchImpl,
      Math.max(1, deadline - Date.now()),
      trace
    );
  }
  response = await awaitPendingResult(
    response,
    apiKey,
    fetchImpl,
    deadline,
    trace
  );
  if (response.status !== 200) {
    trace.retryAfterMs = retryAfterMs(response.headers);
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
  try {
    envelope = JSON.parse(response.text);
  } catch {
    throw responseError(
      'MALFORMED_PROVIDER_RESPONSE',
      'INVALID_HTTP_RESPONSE_ENVELOPE',
      response.status,
      traceDiagnosticContext(trace)
    );
  }

  return parseCompletionEnvelope(
    envelope,
    apiKey,
    response.status,
    request,
    trace
  );
}

export class NvidiaProvider implements GenerationInterface {
  constructor(
    private readonly apiKey: string,
    private readonly modelId = NVIDIA_MODEL,
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly timeoutMs?: number
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    if (!NVIDIA_MODELS.has(this.modelId)) {
      throw new NvidiaProviderError('INVALID_REQUEST');
    }
    return requestGenerationResponse(
      this.apiKey,
      request,
      this.modelId,
      this.fetchImpl,
      this.timeoutMs ?? defaultTimeoutMs(this.modelId)
    );
  }
}

export async function validateNvidiaCredential(
  apiKey: string,
  modelId: string,
  fetchImpl: FetchImplementation = fetch,
  timeoutMs = defaultTimeoutMs(modelId)
): Promise<void> {
  if (!NVIDIA_MODELS.has(modelId)) {
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
