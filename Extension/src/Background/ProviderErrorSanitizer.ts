import { GeminiProviderError } from '../Generation/GeminiProvider';

export type SafeProviderErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_FAILURE';

export interface SafeProviderError {
  code: SafeProviderErrorCode;
  message: string;
}

const SAFE_MESSAGES: Record<SafeProviderErrorCode, string> = {
  AUTHENTICATION_FAILED: 'Credential invalid.',
  INVALID_REQUEST: 'Provider request was invalid.',
  RATE_LIMITED: 'Provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'Provider unavailable.',
  MALFORMED_PROVIDER_RESPONSE: 'Provider returned an invalid response.',
  NETWORK_FAILURE: 'Provider network request failed.',
  PROVIDER_FAILURE: 'Provider request failed.',
};

export function sanitizeProviderError(error: unknown): SafeProviderError {
  if (error instanceof GeminiProviderError) {
    const code: SafeProviderErrorCode =
      error.code === 'AUTHENTICATION_FAILED'
        ? 'AUTHENTICATION_FAILED'
        : error.code === 'RATE_LIMITED'
          ? 'RATE_LIMITED'
          : error.code === 'MALFORMED_PROVIDER_OUTPUT'
            ? 'MALFORMED_PROVIDER_RESPONSE'
            : error.code === 'PROVIDER_UNAVAILABLE'
              ? 'PROVIDER_UNAVAILABLE'
              : 'PROVIDER_FAILURE';
    return { code, message: SAFE_MESSAGES[code] };
  }

  if (error instanceof TypeError) {
    return {
      code: 'NETWORK_FAILURE',
      message: SAFE_MESSAGES.NETWORK_FAILURE,
    };
  }

  return {
    code: 'PROVIDER_FAILURE',
    message: SAFE_MESSAGES.PROVIDER_FAILURE,
  };
}
