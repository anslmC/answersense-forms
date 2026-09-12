import {
  sanitizeProviderError,
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

export function serviceWorkerErrorResponse(
  error: unknown
): ServiceWorkerErrorResponse {
  if (error instanceof SafeServiceWorkerError) {
    return { error: error.message, code: error.code };
  }
  const safe = sanitizeProviderError(error);
  return { error: safe.message, code: safe.code };
}
