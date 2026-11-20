import {
  PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
  type GenerationInterface,
  type GenerationRequest,
  type GenerationResponse,
  type ProviderErrorCode,
  type ProviderErrorContract,
  type ProviderProgressObserver,
  type ProviderSafeMessageCode,
} from './Contract';
import {
  GEMINI_PROVIDER_ID,
  GEMINI_SERVER_BUSY_MESSAGE,
} from './ProviderIdentity';
import { systemInstruction } from './SystemInstructions';
import { buildAnswerPartsInstructions } from './AnswerParts';
import {
  GEMINI_RECOVERY_DEADLINE_MESSAGE,
  GeminiRecoveryCancelledError,
  GeminiRecoveryDeadlineError,
  GeminiRecoveryExhaustedError,
  executeGeminiRecovery,
  type GeminiAttemptMeta,
  type GeminiAttemptOutcome,
  type GeminiFailureDescriptor,
  type GeminiOverflowKind,
  type GeminiRecoveryDisposition,
  type GeminiRecoveryOptions,
} from './GeminiRecovery';
import {
  salvageGeminiResponse,
  type GeminiSalvageExtractionOutcome,
} from './GeminiSalvage';
import {
  elapsedSince,
  monotonicNow,
  type GenerationPerformanceRecorder,
  type PerformanceOutcome,
} from '../Shared/Performance';

export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_35_FLASH_LITE_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
export function geminiModelInfoUrl(modelId: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}`;
}
export const GEMINI_MODEL_INFO_URL = geminiModelInfoUrl(GEMINI_MODEL);
export const GEMINI_REQUEST_TIMEOUT_MS = 30_000;

export type ProviderFailureCode =
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_UNAVAILABLE'
  | 'MALFORMED_PROVIDER_OUTPUT'
  | 'PROVIDER_ERROR'
  | 'CANCELLED';

const SERVER_BUSY_MESSAGE = GEMINI_SERVER_BUSY_MESSAGE;

const SHARED_CONTEXT_OVERFLOW_MESSAGE =
  'The provider rejected the request because the shared context exceeds the model input limit.';
const QUESTION_OVERFLOW_MESSAGE =
  'The provider rejected the request because the individual question content exceeds the model input limit.';
const TRUNCATED_MESSAGE = 'Provider response was truncated before completion.';
const NO_STRUCTURED_OUTPUT_MESSAGE = 'Provider returned no structured output.';
const NO_USABLE_RESULTS_MESSAGE = 'Provider returned no usable results.';

const CONTEXT_OVERFLOW_MESSAGES = new Set([
  PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
  SHARED_CONTEXT_OVERFLOW_MESSAGE,
  QUESTION_OVERFLOW_MESSAGE,
]);

function safeCodeForGeminiFailure(
  code: ProviderFailureCode
): ProviderErrorCode {
  switch (code) {
    case 'AUTHENTICATION_FAILED':
    case 'PERMISSION_DENIED':
    case 'RATE_LIMITED':
    case 'INVALID_REQUEST':
    case 'TIMEOUT':
    case 'NETWORK_FAILURE':
    case 'PROVIDER_UNAVAILABLE':
      return code;
    case 'MALFORMED_PROVIDER_OUTPUT':
      return 'MALFORMED_PROVIDER_RESPONSE';
    case 'CANCELLED':
      return 'PROVIDER_UNAVAILABLE';
    default:
      return 'PROVIDER_FAILURE';
  }
}

export type GeminiProviderDiagnostic =
  | 'HTTP_STATUS'
  | 'TRANSPORT'
  | 'INVALID_JSON'
  | 'INVALID_GENERATION_RESPONSE'
  | 'MISSING_RESULTS'
  | 'API_KEY_ECHO'
  | 'TRUNCATED_RESPONSE';

export interface GeminiProviderDiagnostics {
  readonly diagnostic: GeminiProviderDiagnostic;
  readonly httpStatus: number;
  readonly finishReason: string | null;
  readonly contentPresent: boolean;
  readonly contentLength: number;
  readonly reasoningFieldPresent: boolean;
  readonly reasoningBlockPresent: boolean;
  readonly extractionOutcome: GeminiSalvageExtractionOutcome;
  readonly usage: null;
  readonly modelId?: string;
  readonly attempt?: number;
  readonly elapsedMs?: number;
  readonly retryAfterMs?: number | null;
}

export class GeminiProviderError
  extends Error
  implements ProviderErrorContract
{
  public readonly safeCode: ProviderErrorCode;
  public readonly safeMessageCode: ProviderSafeMessageCode | undefined;
  public readonly providerId = GEMINI_PROVIDER_ID;

  constructor(
    public readonly code: ProviderFailureCode,
    message: string,
    safeCode = safeCodeForGeminiFailure(code),
    public readonly diagnostics?: GeminiProviderDiagnostics
  ) {
    super(message);
    this.name = 'GeminiProviderError';
    this.safeCode = safeCode;
    this.safeMessageCode =
      code === 'PROVIDER_UNAVAILABLE' && message === SERVER_BUSY_MESSAGE
        ? 'SERVER_BUSY'
        : code === 'INVALID_REQUEST' && CONTEXT_OVERFLOW_MESSAGES.has(message)
          ? 'CONTEXT_OVERFLOW'
          : undefined;
  }
}

export const responseJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    cycleId: { type: 'string' },
    results: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['GENERATED'] },
              answer: {
                type: 'object',
                properties: {
                  questionId: { type: 'string' },
                  value: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } },
                    ],
                  },
                },
                required: ['questionId', 'value'],
              },
            },
            required: ['questionId', 'status', 'answer'],
          },
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['ABSTAINED'] },
              answer: { type: 'null' },
              reason: {
                type: 'string',
                enum: [
                  'LOW_CONFIDENCE',
                  'UNABLE_TO_DETERMINE',
                  'NOT_APPLICABLE',
                ],
              },
            },
            required: ['questionId', 'status', 'answer', 'reason'],
          },
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['GENERATION_FAILED'] },
              answer: { type: 'null' },
              failure: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
              },
            },
            required: ['questionId', 'status', 'answer', 'failure'],
          },
        ],
      },
    },
  },
  required: ['cycleId', 'results'],
};

function buildPrompt(request: GenerationRequest): string {
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
  });
}

function buildGeminiBody(
  request: GenerationRequest,
  modelId: string
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema,
      ...(modelId === GEMINI_35_FLASH_LITE_MODEL
        ? { thinkingConfig: { thinkingLevel: 'LOW' } }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ParsedGeminiResponse {
  readonly text: string | null;
  readonly finishReason: string | null;
  readonly contentPresent: boolean;
  readonly contentLength: number;
  readonly reasoningFieldPresent: boolean;
  readonly reasoningBlockPresent: boolean;
  readonly truncated: boolean;
  readonly candidateCount: number;
}

function emptyParsedResponse(): ParsedGeminiResponse {
  return {
    text: null,
    finishReason: null,
    contentPresent: false,
    contentLength: 0,
    reasoningFieldPresent: false,
    reasoningBlockPresent: false,
    truncated: false,
    candidateCount: 0,
  };
}

function parseGeminiResponse(value: unknown): ParsedGeminiResponse {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    return emptyParsedResponse();
  }
  const candidates = value.candidates;
  if (candidates.length === 0) {
    return emptyParsedResponse();
  }
  const candidate = candidates[0];
  if (!isRecord(candidate)) {
    return emptyParsedResponse();
  }
  const finishReason =
    typeof candidate.finishReason === 'string'
      ? candidate.finishReason.slice(0, 64)
      : null;
  const truncated = finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH';
  if (!isRecord(candidate.content)) {
    return {
      ...emptyParsedResponse(),
      finishReason,
      truncated,
      candidateCount: candidates.length,
    };
  }
  const parts = candidate.content.parts;
  if (!Array.isArray(parts)) {
    return {
      ...emptyParsedResponse(),
      finishReason,
      truncated,
      candidateCount: candidates.length,
    };
  }

  let text = '';
  let reasoningBlockPresent = false;
  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== 'string') {
      continue;
    }
    if (part.thought === true) {
      reasoningBlockPresent = true;
      continue;
    }
    text += part.text;
  }

  return {
    text: text.length > 0 ? text : null,
    finishReason,
    contentPresent: text.trim().length > 0,
    contentLength: text.length,
    reasoningFieldPresent: false,
    reasoningBlockPresent,
    truncated,
    candidateCount: candidates.length,
  };
}

function readErrorStatus(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }
  return typeof body.error.status === 'string'
    ? body.error.status.slice(0, 64)
    : null;
}

function parseRetryDelayValue(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/u.exec(value.trim());
    if (match) {
      return Math.max(0, Math.round(Number(match[1]) * 1_000));
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const seconds =
    typeof value.seconds === 'string' ? Number(value.seconds) : value.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }
  const nanos =
    typeof value.nanos === 'number' && Number.isFinite(value.nanos)
      ? value.nanos
      : 0;
  return Math.max(0, Math.round(seconds * 1_000 + nanos / 1_000_000));
}

function retryAfterFromBody(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }
  const details = body.error.details;
  if (!Array.isArray(details)) {
    return null;
  }
  for (const detail of details) {
    if (!isRecord(detail)) {
      continue;
    }
    const delay = parseRetryDelayValue(detail.retryDelay ?? detail.retry_delay);
    if (delay !== null) {
      return delay;
    }
  }
  return null;
}

function retryAfterFromHeaders(headers?: Headers): number | null {
  if (!headers) {
    return null;
  }
  const raw = headers.get('Retry-After');
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : null;
}

function retryAfterMs(
  headers: Headers | undefined,
  body: unknown
): number | null {
  return retryAfterFromHeaders(headers) ?? retryAfterFromBody(body);
}

interface HttpFailureClassification {
  readonly code: ProviderFailureCode;
  readonly message: string;
  readonly disposition: GeminiRecoveryDisposition;
  readonly retryAfterMs: number | null;
  readonly contextOverflow?: boolean;
  readonly overflowKind?: GeminiOverflowKind;
}

function errorDetailText(body: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || parts.length >= 32) {
      return;
    }
    if (typeof value === 'string') {
      parts.push(value.slice(0, 1_024));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const key of [
      'message',
      'reason',
      'description',
      'status',
      'domain',
    ]) {
      const entry = value[key];
      if (typeof entry === 'string') {
        parts.push(entry.slice(0, 1_024));
      }
    }
    visit(value.error, depth + 1);
    visit(value.details, depth + 1);
    visit(value.fieldViolations, depth + 1);
  };
  visit(body, 0);
  return parts.join(' ').slice(0, 4_096);
}

function classifyOverflowKind(
  body: unknown,
  questionCount: number,
  hasSharedContext: boolean
): GeminiOverflowKind {
  const text = errorDetailText(body);
  const mentionsSharedContext =
    /\b(?:shared|settled)\s+(?:form\s+)?context\b/iu.test(text);
  const mentionsQuestions = /\bquestions?\b/iu.test(text);
  const mentionsInputSize =
    /\b(?:input token count|input size|token limit|maximum (?:number of )?tokens|request payload|payload size|too large)\b/iu.test(
      text
    );

  if (mentionsSharedContext && !mentionsQuestions) {
    return 'SHARED_CONTEXT';
  }
  if (mentionsQuestions && !mentionsSharedContext) {
    return 'QUESTION_PAYLOAD';
  }
  if (mentionsInputSize && !hasSharedContext) {
    return 'QUESTION_PAYLOAD';
  }
  if (!hasSharedContext || questionCount <= 1) {
    return hasSharedContext ? 'UNKNOWN' : 'QUESTION_PAYLOAD';
  }
  return 'UNKNOWN';
}

function classifyHttpFailure(
  status: number,
  body: unknown,
  headers: Headers | undefined,
  questionCount: number,
  hasSharedContext = false
): HttpFailureClassification {
  if (status === 401) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: 'Credential invalid.',
      disposition: 'NONE',
      retryAfterMs: null,
    };
  }
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      message: 'API key or project does not have permission to use this model.',
      disposition: 'NONE',
      retryAfterMs: null,
    };
  }
  if (status === 402) {
    return {
      code: 'QUOTA_EXHAUSTED',
      message: 'Quota unavailable.',
      disposition: 'NONE',
      retryAfterMs: null,
    };
  }
  if (status === 413) {
    const overflowKind = classifyOverflowKind(
      body,
      questionCount,
      hasSharedContext
    );
    return {
      code: 'INVALID_REQUEST',
      message:
        overflowKind === 'SHARED_CONTEXT'
          ? SHARED_CONTEXT_OVERFLOW_MESSAGE
          : overflowKind === 'QUESTION_PAYLOAD'
            ? QUESTION_OVERFLOW_MESSAGE
            : PROVIDER_CONTEXT_OVERFLOW_MESSAGE,
      disposition:
        overflowKind === 'SHARED_CONTEXT'
          ? 'NONE'
          : questionCount > 1
            ? 'SPLIT'
            : 'NONE',
      retryAfterMs: null,
      contextOverflow: true,
      overflowKind,
    };
  }
  if (status === 429) {
    const guidance = retryAfterMs(headers, body);
    const errorStatus = readErrorStatus(body);
    if (errorStatus === 'RESOURCE_EXHAUSTED' && guidance === null) {
      return {
        code: 'QUOTA_EXHAUSTED',
        message: 'Quota unavailable.',
        disposition: 'NONE',
        retryAfterMs: null,
      };
    }
    return {
      code: 'RATE_LIMITED',
      message: 'Temporarily unavailable.',
      disposition: 'RETRY',
      retryAfterMs: guidance,
    };
  }
  if (status === 408 || status === 504) {
    return {
      code: 'TIMEOUT',
      message: 'Provider request timed out.',
      disposition: 'RETRY',
      retryAfterMs: null,
    };
  }
  if (status === 503) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      message: SERVER_BUSY_MESSAGE,
      disposition: 'RETRY',
      retryAfterMs: retryAfterMs(headers, body),
    };
  }
  if (status === 500 || status === 502) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Provider unavailable.',
      disposition: 'RETRY',
      retryAfterMs: retryAfterMs(headers, body),
    };
  }
  if (status === 501 || status === 505 || status >= 506) {
    return {
      code: 'PROVIDER_ERROR',
      message: 'Provider request failed.',
      disposition: 'NONE',
      retryAfterMs: null,
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      code: 'INVALID_REQUEST',
      message: 'Provider request was invalid.',
      disposition: 'NONE',
      retryAfterMs: null,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    message: 'Provider request failed.',
    disposition: 'NONE',
    retryAfterMs: null,
  };
}

function classifyStatus(
  status: number,
  body?: unknown,
  headers?: Headers
): GeminiProviderError {
  const classification = classifyHttpFailure(status, body, headers, 0);
  return new GeminiProviderError(classification.code, classification.message);
}

function dispositionForProviderCode(
  code: ProviderFailureCode
): GeminiRecoveryDisposition {
  if (
    code === 'TIMEOUT' ||
    code === 'NETWORK_FAILURE' ||
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'RATE_LIMITED'
  ) {
    return 'RETRY';
  }
  return 'NONE';
}

function createDiagnostics(
  diagnostic: GeminiProviderDiagnostic,
  httpStatus: number,
  parsed: ParsedGeminiResponse | null,
  extractionOutcome: GeminiSalvageExtractionOutcome,
  modelId: string,
  meta: GeminiAttemptMeta,
  elapsedMs: number,
  retryAfter: number | null
): GeminiProviderDiagnostics {
  return {
    diagnostic,
    httpStatus,
    finishReason: parsed?.finishReason ?? null,
    contentPresent: parsed?.contentPresent ?? false,
    contentLength: Math.min(parsed?.contentLength ?? 0, 10_000_000),
    reasoningFieldPresent: parsed?.reasoningFieldPresent ?? false,
    reasoningBlockPresent: parsed?.reasoningBlockPresent ?? false,
    extractionOutcome,
    usage: null,
    modelId,
    attempt: meta.attempt,
    elapsedMs,
    retryAfterMs:
      retryAfter === null ? null : Math.min(3_600_000, Math.max(0, retryAfter)),
  };
}

function failureFromTransport(error: unknown): {
  readonly error: GeminiProviderError;
  readonly failure: GeminiFailureDescriptor;
  readonly disposition: GeminiRecoveryDisposition;
} {
  if (error instanceof GeminiProviderError) {
    return {
      error,
      failure: { code: error.code, message: error.message },
      disposition: dispositionForProviderCode(error.code),
    };
  }
  const isAbort = error instanceof Error && error.name === 'AbortError';
  const isNetwork = error instanceof TypeError;
  const wrapped = new GeminiProviderError(
    isAbort ? 'TIMEOUT' : isNetwork ? 'NETWORK_FAILURE' : 'PROVIDER_ERROR',
    isAbort
      ? 'Provider request timed out.'
      : isNetwork
        ? 'Provider network request failed.'
        : 'Provider request failed.'
  );
  return {
    error: wrapped,
    failure: { code: wrapped.code, message: wrapped.message },
    disposition: dispositionForProviderCode(wrapped.code),
  };
}

export interface GeminiTransport {
  generate(request: {
    apiKey: string;
    body: unknown;
    url: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown; headers?: Headers }>;
}

export async function readResponseBody(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abortListener();
    } else {
      signal.addEventListener('abort', abortListener);
    }
  });
  try {
    let bodyPromise: Promise<unknown>;
    try {
      bodyPromise = response.json();
    } catch {
      return null;
    }
    return await Promise.race([bodyPromise.catch(() => null), aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

const fetchTransport: GeminiTransport = {
  async generate({ apiKey, body, url, signal }) {
    if (signal?.aborted) {
      throw new GeminiProviderError(
        'CANCELLED',
        'Generation cancelled.',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GEMINI_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseBody = await readResponseBody(response, controller.signal);
      return {
        status: response.status,
        body: responseBody,
        headers: response.headers,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new GeminiProviderError(
          'CANCELLED',
          'Generation cancelled.',
          'PROVIDER_UNAVAILABLE'
        );
      }
      if (timedOut) {
        throw new GeminiProviderError('TIMEOUT', 'Provider request timed out.');
      }
      if (error instanceof GeminiProviderError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GeminiProviderError('TIMEOUT', 'Provider request timed out.');
      }
      throw new GeminiProviderError(
        'NETWORK_FAILURE',
        'Provider network request failed.'
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  },
};

function assertUniqueQuestionIds(request: GenerationRequest): void {
  const questionIds = new Set<string>();
  for (const question of request.questions) {
    if (questionIds.has(question.questionId)) {
      throw new GeminiProviderError(
        'INVALID_REQUEST',
        'Provider request was invalid.'
      );
    }
    questionIds.add(question.questionId);
  }
}

function countResults(response: GenerationResponse): {
  generatedCount: number;
  abstainedCount: number;
  failedCount: number;
} {
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
  return { generatedCount, abstainedCount, failedCount };
}

export class GeminiProvider implements GenerationInterface {
  constructor(
    private readonly apiKey: string,
    private readonly transport = fetchTransport,
    private readonly modelId = GEMINI_MODEL,
    private readonly recoveryOptions: GeminiRecoveryOptions = {}
  ) {}

  private async executeAttempt(
    request: GenerationRequest,
    signal: AbortSignal | undefined,
    meta: GeminiAttemptMeta,
    performance?: GenerationPerformanceRecorder
  ): Promise<GeminiAttemptOutcome> {
    const startedAt = performance ? monotonicNow() : 0;
    performance?.addCount('geminiAttemptCount');

    try {
      const result = await this.transport.generate({
        apiKey: this.apiKey,
        signal,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:generateContent`,
        body: buildGeminiBody(request, this.modelId),
      });

      if (result.status < 200 || result.status >= 300) {
        const classification = classifyHttpFailure(
          result.status,
          result.body,
          result.headers,
          request.questions.length,
          request.settledContext.length > 0
        );
        const diagnostics = createDiagnostics(
          'HTTP_STATUS',
          result.status,
          null,
          'NOT_ATTEMPTED',
          this.modelId,
          meta,
          performance ? elapsedSince(startedAt) : 0,
          classification.retryAfterMs
        );
        const error = new GeminiProviderError(
          classification.code,
          classification.message,
          undefined,
          diagnostics
        );
        return {
          ok: false,
          error,
          failure: {
            code: classification.code,
            message: classification.message,
          },
          disposition: classification.disposition,
          retryAfterMs: classification.retryAfterMs,
          ...(classification.contextOverflow ? { contextOverflow: true } : {}),
          ...(classification.overflowKind
            ? { overflowKind: classification.overflowKind }
            : {}),
        };
      }

      const parsed = parseGeminiResponse(result.body);
      if (!parsed.text) {
        const code: ProviderFailureCode = 'MALFORMED_PROVIDER_OUTPUT';
        const message = parsed.truncated
          ? TRUNCATED_MESSAGE
          : NO_STRUCTURED_OUTPUT_MESSAGE;
        const diagnostics = createDiagnostics(
          parsed.truncated
            ? 'TRUNCATED_RESPONSE'
            : 'INVALID_GENERATION_RESPONSE',
          result.status,
          parsed,
          'FAILED',
          this.modelId,
          meta,
          performance ? elapsedSince(startedAt) : 0,
          null
        );
        const error = new GeminiProviderError(
          code,
          message,
          undefined,
          diagnostics
        );
        return {
          ok: false,
          error,
          failure: { code, message },
          disposition: 'SPLIT',
          retryAfterMs: null,
        };
      }

      const salvage = salvageGeminiResponse(parsed.text, request, this.apiKey);
      if (salvage.rejected) {
        const isEcho = salvage.rejected.code === 'API_KEY_ECHO';
        const code: ProviderFailureCode = isEcho
          ? 'PROVIDER_ERROR'
          : 'MALFORMED_PROVIDER_OUTPUT';
        const disposition: GeminiRecoveryDisposition =
          salvage.rejected.code === 'UNPARSEABLE' ? 'SPLIT' : 'NONE';
        const diagnostics = createDiagnostics(
          isEcho
            ? 'API_KEY_ECHO'
            : salvage.rejected.code === 'UNPARSEABLE'
              ? 'INVALID_JSON'
              : 'INVALID_GENERATION_RESPONSE',
          result.status,
          parsed,
          salvage.extractionOutcome,
          this.modelId,
          meta,
          performance ? elapsedSince(startedAt) : 0,
          null
        );
        const error = new GeminiProviderError(
          code,
          salvage.rejected.message,
          undefined,
          diagnostics
        );
        return {
          ok: false,
          error,
          failure: { code, message: salvage.rejected.message },
          disposition,
          retryAfterMs: null,
        };
      }

      if (!salvage.hasUsableResult) {
        const acceptedEmptyResponse =
          request.questions.length === 0 &&
          !parsed.truncated &&
          salvage.rejected === null &&
          salvage.ignoredResultCount === 0 &&
          salvage.candidateCount > 0 &&
          (salvage.extractionOutcome === 'DIRECT' ||
            salvage.extractionOutcome === 'EMBEDDED');
        const code: ProviderFailureCode = 'MALFORMED_PROVIDER_OUTPUT';
        const message = parsed.truncated
          ? TRUNCATED_MESSAGE
          : NO_USABLE_RESULTS_MESSAGE;
        const diagnostics = createDiagnostics(
          parsed.truncated
            ? 'TRUNCATED_RESPONSE'
            : 'INVALID_GENERATION_RESPONSE',
          result.status,
          parsed,
          salvage.extractionOutcome,
          this.modelId,
          meta,
          performance ? elapsedSince(startedAt) : 0,
          null
        );
        const error = new GeminiProviderError(
          code,
          message,
          undefined,
          diagnostics
        );
        return {
          ok: false,
          error,
          failure: { code, message },
          disposition: 'SPLIT',
          retryAfterMs: null,
          ...(acceptedEmptyResponse ? { acceptedEmptyResponse: true } : {}),
        };
      }

      const diagnosticFailure: GeminiFailureDescriptor = parsed.truncated
        ? {
            code: 'INCOMPLETE_PROVIDER_RESPONSE',
            message: TRUNCATED_MESSAGE,
          }
        : {
            code: 'MALFORMED_PROVIDER_OUTPUT',
            message:
              'Provider did not return a usable result for this question.',
          };
      performance?.addCount(
        'geminiSalvagedResultCount',
        salvage.results.length
      );
      return {
        ok: true,
        results: salvage.results,
        truncated: parsed.truncated,
        diagnosticFailure,
      };
    } catch (error) {
      const failure = failureFromTransport(error);
      const diagnostics =
        failure.error.diagnostics ??
        createDiagnostics(
          'TRANSPORT',
          0,
          null,
          'NOT_ATTEMPTED',
          this.modelId,
          meta,
          performance ? elapsedSince(startedAt) : 0,
          null
        );
      if (!failure.error.diagnostics) {
        const wrapped = new GeminiProviderError(
          failure.error.code,
          failure.error.message,
          failure.error.safeCode,
          diagnostics
        );
        return {
          ok: false,
          error: wrapped,
          failure: failure.failure,
          disposition: failure.disposition,
          retryAfterMs: null,
        };
      }
      return {
        ok: false,
        error: failure.error,
        failure: failure.failure,
        disposition: failure.disposition,
        retryAfterMs: null,
      };
    }
  }

  async generate(
    request: GenerationRequest,
    signal?: AbortSignal,
    performance?: GenerationPerformanceRecorder,
    onProgress?: ProviderProgressObserver
  ): Promise<GenerationResponse> {
    const startedAt = performance ? monotonicNow() : 0;
    let outcome: PerformanceOutcome = 'UNKNOWN';
    performance?.setModelId(this.modelId);
    performance?.addCount('expectedQuestionCount', request.questions.length);

    try {
      if (request.questions.length === 0) {
        outcome = 'SUCCESS';
        return { cycleId: request.cycleId, results: [] };
      }
      assertUniqueQuestionIds(request);

      const response = await executeGeminiRecovery(
        request,
        (subset, attemptSignal, meta) =>
          this.executeAttempt(subset, attemptSignal, meta, performance),
        {
          ...this.recoveryOptions,
          signal,
          ...(performance ? { performance } : {}),
          ...(onProgress ? { onProgress } : {}),
        }
      );

      const counts = countResults(response);
      performance?.setResultProcessing({
        expectedQuestionCount: request.questions.length,
        returnedResultCount: response.results.length,
        generatedCount: counts.generatedCount,
        abstainedCount: counts.abstainedCount,
        failedCount: counts.failedCount,
        salvagedResultCount: counts.generatedCount + counts.abstainedCount,
      });
      performance?.addCount(
        'geminiAcceptedResultCount',
        counts.generatedCount + counts.abstainedCount
      );
      performance?.addCount('geminiFailedResultCount', counts.failedCount);
      outcome = 'SUCCESS';
      return response;
    } catch (error) {
      if (error instanceof GeminiRecoveryCancelledError) {
        outcome = 'CANCELLED';
        throw new GeminiProviderError(
          'CANCELLED',
          'Generation cancelled.',
          'PROVIDER_UNAVAILABLE'
        );
      }
      if (error instanceof GeminiRecoveryDeadlineError) {
        outcome = 'DEADLINE';
        throw new GeminiProviderError(
          'TIMEOUT',
          GEMINI_RECOVERY_DEADLINE_MESSAGE
        );
      }
      if (error instanceof GeminiRecoveryExhaustedError) {
        outcome = 'FAILURE';
        throw new GeminiProviderError('PROVIDER_ERROR', error.failure.message);
      }
      if (error instanceof GeminiProviderError) {
        outcome =
          error.code === 'CANCELLED'
            ? 'CANCELLED'
            : error.safeCode === 'TIMEOUT'
              ? 'DEADLINE'
              : 'FAILURE';
        throw error;
      }
      outcome = 'FAILURE';
      throw error;
    } finally {
      if (performance) {
        performance.addPhase('providerGenerationMs', elapsedSince(startedAt));
        performance.finish(outcome);
      }
    }
  }
}

export async function validateGeminiCredential(
  apiKey: string,
  modelId: string = GEMINI_MODEL
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GEMINI_REQUEST_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await fetch(geminiModelInfoUrl(modelId), {
      headers: { 'x-goog-api-key': apiKey },
      signal: controller.signal,
    });
  } catch (error) {
    throw new GeminiProviderError(
      'PROVIDER_UNAVAILABLE',
      'Provider unavailable.',
      error instanceof Error && error.name === 'AbortError'
        ? 'TIMEOUT'
        : undefined
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Keep status-based classification when the provider body is unavailable.
    }
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      Array.isArray(body.error.details) &&
      body.error.details.some(
        (detail) => isRecord(detail) && detail.reason === 'API_KEY_INVALID'
      )
    ) {
      throw new GeminiProviderError(
        'AUTHENTICATION_FAILED',
        'Credential invalid.'
      );
    }
    throw classifyStatus(response.status, body, response.headers);
  }
}
