import {
  sanitizeProviderError,
  NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE,
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
      | 'UNAUTHORIZED_SENDER',
    message: string
  ) {
    super(message);
    this.name = 'SafeServiceWorkerError';
  }
}

export interface ServiceWorkerErrorResponse {
  error: string;
  code: SafeServiceWorkerError['code'];
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
  UNAUTHORIZED_SENDER: [
    'Generation request is not from a valid content tab.',
    'Generation request is not from the active tab.',
  ],
};

const GENERIC_PROVIDER_FAILURE: ServiceWorkerErrorResponse = {
  error: 'Provider request failed.',
  code: 'PROVIDER_FAILURE',
};

function safeServiceWorkerErrorResponse(
  error: SafeServiceWorkerError
): ServiceWorkerErrorResponse {
  const { code, message } = error;
  const providerError = sanitizeProviderError({ safeCode: code });
  if (providerError.code === code && providerError.message === message) {
    return { error: providerError.message, code: providerError.code };
  }

  if (
    code === 'PROVIDER_UNAVAILABLE' &&
    message === 'Server was busy. Try again.'
  ) {
    const unavailableError = sanitizeProviderError({
      safeCode: code,
      safeMessageCode: 'SERVER_BUSY',
    });
    return { error: unavailableError.message, code: unavailableError.code };
  }

  if (
    code === 'PERMISSION_DENIED' &&
    message === NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE
  ) {
    return { error: message, code };
  }

  if (
    code in SERVICE_WORKER_MESSAGES &&
    SERVICE_WORKER_MESSAGES[code as ServiceWorkerOnlyErrorCode].includes(message)
  ) {
    return { error: message, code };
  }

  return GENERIC_PROVIDER_FAILURE;
}

export function serviceWorkerErrorResponse(
  error: unknown
): ServiceWorkerErrorResponse {
  try {
    if (error instanceof SafeServiceWorkerError) {
      return safeServiceWorkerErrorResponse(error);
    }
    const safe = sanitizeProviderError(error);
    return { error: safe.message, code: safe.code };
  } catch {
    return GENERIC_PROVIDER_FAILURE;
  }
}
