import type { ProviderErrorCode } from '../Generation/Contract';

export type SafeProviderErrorCode = ProviderErrorCode;

export interface SafeProviderError {
  code: SafeProviderErrorCode;
  message: string;
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
    return {
      code: safeCode as ProviderErrorCode,
      message:
        safeCode === 'PERMISSION_DENIED' && providerId === 'nvidia'
          ? NVIDIA_PROVIDER_ACCESS_DENIED_MESSAGE
          :
        safeCode === 'PROVIDER_UNAVAILABLE' &&
        safeMessageCode === 'SERVER_BUSY'
          ? 'Server was busy. Try again.'
          : SAFE_MESSAGES[safeCode as ProviderErrorCode],
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
