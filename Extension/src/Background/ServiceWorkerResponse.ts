import {
  sanitizeProviderError,
  NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE,
  type SafeProviderDiagnostics,
  type SafeProviderErrorCode,
} from './ProviderErrorSanitizer';

export class SafeServiceWorkerError extends Error {
  constructor(
    public readonly code:
      | SafeProviderErrorCode
      | 'CONFIGURATION_NOT_AUTHORIZED'
      | 'CONFIGURATION_STALE'
      | 'GENERATION_IN_PROGRESS'
      | 'GENERATION_PAGE_NOT_SYNCHRONIZED'
      | 'GENERATION_SUPERSEDED'
      | 'GENERATION_INVALID_RESULT'
      | 'OVERRIDE_SELECTION_INVALID'
      | 'UNAUTHORIZED_SENDER',
    message: string,
    public readonly diagnostics?: SafeProviderDiagnostics
  ) {
    super(message);
    this.name = 'SafeServiceWorkerError';
  }
}

export interface ServiceWorkerErrorResponse {
  error: string;
  code: SafeServiceWorkerError['code'];
  diagnostics?: SafeProviderDiagnostics;
}

type ServiceWorkerOnlyErrorCode = Exclude<
  SafeServiceWorkerError['code'],
  SafeProviderErrorCode
>;

const SERVICE_WORKER_MESSAGES: Record<
  ServiceWorkerOnlyErrorCode,
  readonly string[]
> = {
  CONFIGURATION_NOT_AUTHORIZED: ['Generation configuration is not authorized.'],
  CONFIGURATION_STALE: [
    'Configuration changed during validation.',
    'Generation configuration is stale.',
  ],
  GENERATION_IN_PROGRESS: [
    'Generation is already in progress for the current page.',
  ],
  GENERATION_PAGE_NOT_SYNCHRONIZED: [
    'The current page is not synchronized for generation.',
    'Override selection could not be validated.',
  ],
  GENERATION_SUPERSEDED: [
    'Generation was superseded before it completed. Generate the page again.',
    'The page changed before the answers could be saved. Generate the page again.',
  ],
  GENERATION_INVALID_RESULT: ['Generation returned an invalid result.'],
  OVERRIDE_SELECTION_INVALID: [
    'Override selection is invalid. Select at least one filled answer.',
  ],
  UNAUTHORIZED_SENDER: [
    'Generation request is not from a valid content tab.',
    'Generation request is not from the active tab.',
  ],
};

const CONTENT_GENERATION_FAILURES = new Map<string, ServiceWorkerErrorResponse>(
  [
    [
      'Generation response was stale or invalidated.',
      {
        error:
          'Generation was superseded before it completed. Generate the page again.',
        code: 'GENERATION_SUPERSEDED',
      },
    ],
    [
      'Finalized handoff does not belong to the active page visit.',
      {
        error:
          'The page changed before the answers could be saved. Generate the page again.',
        code: 'GENERATION_SUPERSEDED',
      },
    ],
    [
      'Generation requires a synchronized current page.',
      {
        error: 'The page changed during generation. Try again.',
        code: 'GENERATION_PAGE_NOT_SYNCHRONIZED',
      },
    ],
    [
      'Override generation requires a synchronized current page.',
      {
        error: 'The page changed during generation. Try again.',
        code: 'GENERATION_PAGE_NOT_SYNCHRONIZED',
      },
    ],
    [
      'Generation is unavailable while page transition is pending.',
      {
        error:
          'Generation is unavailable while the page transition is pending.',
        code: 'GENERATION_PAGE_NOT_SYNCHRONIZED',
      },
    ],
    [
      'Override selection is invalid: <empty-selection>',
      {
        error:
          'Override selection is invalid. Select at least one filled answer.',
        code: 'OVERRIDE_SELECTION_INVALID',
      },
    ],
    [
      'Generation returned an invalid result.',
      {
        error: 'Generation returned an invalid result.',
        code: 'GENERATION_INVALID_RESULT',
      },
    ],
    [
      'Generation configuration is missing.',
      {
        error: 'Generation configuration is not authorized.',
        code: 'CONFIGURATION_NOT_AUTHORIZED',
      },
    ],
  ]
);

const GENERIC_PROVIDER_FAILURE: ServiceWorkerErrorResponse = {
  error: 'Provider request failed.',
  code: 'PROVIDER_FAILURE',
};

function providerResponse(
  safe: { message: string; code: ServiceWorkerErrorResponse['code'] },
  diagnostics?: SafeProviderDiagnostics
): ServiceWorkerErrorResponse {
  return {
    error: safe.message,
    code: safe.code,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function safeServiceWorkerErrorResponse(
  error: SafeServiceWorkerError
): ServiceWorkerErrorResponse {
  const { code, message, diagnostics } = error;
  const providerError = sanitizeProviderError({
    safeCode: code,
    diagnostics,
  });
  if (providerError.code === code && providerError.message === message) {
    return providerResponse(providerError, providerError.diagnostics);
  }

  if (
    code === 'PROVIDER_UNAVAILABLE' &&
    message ===
      "The AI provider's server is temporarily unavailable or overloaded. This can happen during periods of high demand. Try switching providers or try again later. Error 503: Service Unavailable."
  ) {
    const unavailableError = sanitizeProviderError({
      safeCode: code,
      safeMessageCode: 'SERVER_BUSY',
      diagnostics,
    });
    return providerResponse(unavailableError, unavailableError.diagnostics);
  }

  if (
    code === 'PERMISSION_DENIED' &&
    message === NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE
  ) {
    return { error: message, code, ...(diagnostics ? { diagnostics } : {}) };
  }

  if (
    code in SERVICE_WORKER_MESSAGES &&
    SERVICE_WORKER_MESSAGES[code as ServiceWorkerOnlyErrorCode].includes(
      message
    )
  ) {
    return { error: message, code };
  }

  return GENERIC_PROVIDER_FAILURE;
}

function contentGenerationFailure(
  error: unknown
): ServiceWorkerErrorResponse | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return CONTENT_GENERATION_FAILURES.get(error.message) ?? null;
}

export function serviceWorkerErrorResponse(
  error: unknown
): ServiceWorkerErrorResponse {
  try {
    if (error instanceof SafeServiceWorkerError) {
      return safeServiceWorkerErrorResponse(error);
    }
    const contentFailure = contentGenerationFailure(error);
    if (contentFailure) {
      return contentFailure;
    }
    const safe = sanitizeProviderError(error);
    return providerResponse(safe, safe.diagnostics);
  } catch {
    return GENERIC_PROVIDER_FAILURE;
  }
}
