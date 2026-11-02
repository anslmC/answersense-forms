import type { ProviderErrorCode } from '../Generation/Contract';

export type SafeProviderErrorCode = ProviderErrorCode;

export interface SafeProviderDiagnostics {
  diagnostic: string;
  httpStatus: number;
  finishReason: string | null;
  contentPresent: boolean;
  contentLength: number;
  reasoningFieldPresent: boolean;
  reasoningBlockPresent: boolean;
  extractionOutcome: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  modelId?: string;
  attempt?: number;
  elapsedMs?: number;
  fallbackUsed?: boolean;
  pollingUsed?: boolean;
  pollCount?: number;
  requestId?: string | null;
  retryAfterMs?: number | null;
  timeoutStage?: string | null;
}

export interface SafeProviderError {
  code: SafeProviderErrorCode;
  message: string;
  diagnostics?: SafeProviderDiagnostics;
}

export const NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE =
  'NVIDIA denied access to this model. Check NVIDIA account and model permissions.';

const SAFE_MESSAGES: Record<SafeProviderErrorCode, string> = {
  AUTHENTICATION_FAILED: 'Credential invalid.',
  PERMISSION_DENIED:
    'This key or project doesn’t have access to the selected model. Check your API key and project permissions.',
  INVALID_REQUEST: 'Provider request was invalid.',
  RATE_LIMITED: 'Provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'Provider unavailable.',
  TIMEOUT: 'Provider request timed out.',
  INCOMPLETE_PROVIDER_RESPONSE:
    'NVIDIA output was truncated. Try fewer or shorter questions.',
  MALFORMED_PROVIDER_RESPONSE: 'Provider returned an invalid response.',
  NETWORK_FAILURE: 'Provider network request failed.',
  PROVIDER_FAILURE: 'Provider request failed.',
};

const PROVIDER_DIAGNOSTICS = new Set([
  'HTTP_STATUS',
  'TRANSPORT',
  'INVALID_HTTP_RESPONSE_ENVELOPE',
  'MISSING_CHOICES',
  'INVALID_MESSAGE',
  'EMPTY_FINAL_CONTENT',
  'REASONING_ONLY',
  'UNSUPPORTED_FINISH_REASON',
  'TRUNCATED_RESPONSE',
  'INVALID_JSON',
  'INVALID_GENERATION_RESPONSE',
  'MISSING_RESULTS',
  'API_KEY_ECHO',
]);

const EXTRACTION_OUTCOMES = new Set([
  'NOT_ATTEMPTED',
  'DIRECT',
  'MARKDOWN_FENCE',
  'EMBEDDED',
  'FAILED',
]);

const TIMEOUT_STAGES = new Set(['REQUEST', 'RESPONSE_BODY', 'POLLING']);
const MODEL_ID_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIAGNOSTIC_TEXT = 64;
const MAX_CONTENT_LENGTH = 10_000_000;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_ATTEMPT = 10;
const MAX_ELAPSED_MS = 3_600_000;
const MAX_POLL_COUNT = 100_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

function safeDiagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeDiagnostics(value: unknown): SafeProviderDiagnostics | undefined {
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const diagnostic = value.diagnostic;
    const httpStatus = safeDiagnosticNumber(value.httpStatus);
    const contentLength = safeDiagnosticNumber(value.contentLength);
    const extractionOutcome = value.extractionOutcome;
    const finishReason = value.finishReason;
    if (
      typeof diagnostic !== 'string' ||
      !PROVIDER_DIAGNOSTICS.has(diagnostic) ||
      httpStatus === null ||
      httpStatus > 599 ||
      contentLength === null ||
      contentLength > MAX_CONTENT_LENGTH ||
      typeof extractionOutcome !== 'string' ||
      !EXTRACTION_OUTCOMES.has(extractionOutcome) ||
      !(
        finishReason === null ||
        (typeof finishReason === 'string' &&
          finishReason.length <= MAX_DIAGNOSTIC_TEXT)
      ) ||
      typeof value.contentPresent !== 'boolean' ||
      typeof value.reasoningFieldPresent !== 'boolean' ||
      typeof value.reasoningBlockPresent !== 'boolean'
    ) {
      return undefined;
    }

    let usage: SafeProviderDiagnostics['usage'] = null;
    if (isRecord(value.usage)) {
      const promptTokens = safeDiagnosticNumber(value.usage.promptTokens);
      const completionTokens = safeDiagnosticNumber(
        value.usage.completionTokens
      );
      const totalTokens = safeDiagnosticNumber(value.usage.totalTokens);
      if (
        promptTokens !== null ||
        completionTokens !== null ||
        totalTokens !== null
      ) {
        usage = { promptTokens, completionTokens, totalTokens };
      }
    }

    const optional: Partial<SafeProviderDiagnostics> = {};
    if (
      typeof value.modelId === 'string' &&
      value.modelId.length > 0 &&
      value.modelId.length <= MAX_MODEL_ID_LENGTH &&
      MODEL_ID_PATTERN.test(value.modelId)
    ) {
      optional.modelId = value.modelId;
    }
    const attempt = safeDiagnosticNumber(value.attempt);
    if (attempt !== null && attempt >= 1 && attempt <= MAX_ATTEMPT) {
      optional.attempt = attempt;
    }
    const elapsedMs = safeDiagnosticNumber(value.elapsedMs);
    if (elapsedMs !== null && elapsedMs <= MAX_ELAPSED_MS) {
      optional.elapsedMs = elapsedMs;
    }
    if (typeof value.fallbackUsed === 'boolean') {
      optional.fallbackUsed = value.fallbackUsed;
    }
    if (typeof value.pollingUsed === 'boolean') {
      optional.pollingUsed = value.pollingUsed;
    }
    const pollCount = safeDiagnosticNumber(value.pollCount);
    if (pollCount !== null && pollCount <= MAX_POLL_COUNT) {
      optional.pollCount = pollCount;
    }
    if (value.requestId === null) {
      optional.requestId = null;
    } else if (
      typeof value.requestId === 'string' &&
      REQUEST_ID_PATTERN.test(value.requestId)
    ) {
      optional.requestId = value.requestId;
    }
    if (value.retryAfterMs === null) {
      optional.retryAfterMs = null;
    } else {
      const retryAfter = safeDiagnosticNumber(value.retryAfterMs);
      if (retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_MS) {
        optional.retryAfterMs = retryAfter;
      }
    }
    if (value.timeoutStage === null) {
      optional.timeoutStage = null;
    } else if (
      typeof value.timeoutStage === 'string' &&
      TIMEOUT_STAGES.has(value.timeoutStage)
    ) {
      optional.timeoutStage = value.timeoutStage;
    }

    return {
      diagnostic,
      httpStatus,
      finishReason,
      contentPresent: value.contentPresent,
      contentLength,
      reasoningFieldPresent: value.reasoningFieldPresent,
      reasoningBlockPresent: value.reasoningBlockPresent,
      extractionOutcome,
      usage,
      ...optional,
    };
  } catch {
    return undefined;
  }
}

const PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
  'INVALID_REQUEST',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'INCOMPLETE_PROVIDER_RESPONSE',
  'MALFORMED_PROVIDER_RESPONSE',
  'NETWORK_FAILURE',
  'PROVIDER_FAILURE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function providerErrorFromContract(error: unknown): SafeProviderError | null {
  try {
    if (!isRecord(error)) {
      return null;
    }
    const safeCode = error.safeCode;
    if (
      typeof safeCode !== 'string' ||
      !PROVIDER_ERROR_CODES.has(safeCode as ProviderErrorCode)
    ) {
      return null;
    }
    const safeMessageCode = error.safeMessageCode;
    const providerId = error.providerId;
    const diagnostics = safeDiagnostics(error.diagnostics);
    return {
      code: safeCode as ProviderErrorCode,
      message:
        safeCode === 'PERMISSION_DENIED' && providerId === 'nvidia'
          ? NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE
          : safeCode === 'PROVIDER_UNAVAILABLE' &&
              safeMessageCode === 'SERVER_BUSY'
            ? "The AI provider's server is temporarily unavailable or overloaded. This can happen during periods of high demand. Try switching providers or try again later. Error 503: Service Unavailable."
            : SAFE_MESSAGES[safeCode as ProviderErrorCode],
      ...(diagnostics ? { diagnostics } : {}),
    };
  } catch {
    return null;
  }
}

export function sanitizeProviderError(error: unknown): SafeProviderError {
  const providerError = providerErrorFromContract(error);
  if (providerError) {
    return providerError;
  }

  try {
    if (error instanceof TypeError) {
      return {
        code: 'NETWORK_FAILURE',
        message: SAFE_MESSAGES.NETWORK_FAILURE,
      };
    }
  } catch {
    // Malformed objects must not escape the sanitization boundary.
  }

  return {
    code: 'PROVIDER_FAILURE',
    message: SAFE_MESSAGES.PROVIDER_FAILURE,
  };
}
