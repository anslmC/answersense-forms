import { describe, expect, it } from 'vitest';
import {
  isSafeProviderErrorCode,
  sanitizeProviderError,
  type SafeProviderDiagnostics,
} from '../src/Background/ProviderErrorSanitizer';
import {
  SafeServiceWorkerError,
  serviceWorkerErrorResponse,
} from '../src/Background/ServiceWorkerResponse';

const lightningDiagnostics: SafeProviderDiagnostics = {
  diagnostic: 'HTTP_STATUS',
  httpStatus: 504,
  finishReason: null,
  contentPresent: false,
  contentLength: 0,
  reasoningFieldPresent: false,
  reasoningBlockPresent: false,
  extractionOutcome: 'NOT_ATTEMPTED',
  usage: null,
  modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  attempt: 1,
  elapsedMs: 60_001,
  fallbackUsed: false,
  pollingUsed: true,
  pollCount: 4,
  requestId: '10000000-0000-4000-8000-000000000000',
  retryAfterMs: null,
  timeoutStage: 'POLLING',
};

describe('Generation failure propagation', () => {
  it('preserves provider classification and diagnostics across the content boundary', () => {
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError(
          'TIMEOUT',
          'Provider request timed out.',
          lightningDiagnostics
        )
      )
    ).toEqual({
      error: 'Provider request timed out.',
      code: 'TIMEOUT',
      diagnostics: lightningDiagnostics,
    });
  });

  it('does not collapse Lightning truncation into the generic failure', () => {
    const response = serviceWorkerErrorResponse(
      new SafeServiceWorkerError(
        'INCOMPLETE_PROVIDER_RESPONSE',
        'NVIDIA output was truncated. Try fewer or shorter questions.',
        { ...lightningDiagnostics, diagnostic: 'TRUNCATED_RESPONSE' }
      )
    );

    expect(response).toMatchObject({
      code: 'INCOMPLETE_PROVIDER_RESPONSE',
      error: 'NVIDIA output was truncated. Try fewer or shorter questions.',
    });
    expect(response.error).not.toBe('Provider request failed.');
    expect(response.diagnostics).toMatchObject({ httpStatus: 504 });
  });

  it('reports a superseded generation as superseded rather than a provider failure', () => {
    expect(
      serviceWorkerErrorResponse(
        new Error('Generation response was stale or invalidated.')
      )
    ).toEqual({
      error:
        'Generation was superseded before it completed. Generate the page again.',
      code: 'GENERATION_SUPERSEDED',
    });
  });

  it('reports an invalid Override selection accurately', () => {
    expect(
      serviceWorkerErrorResponse(
        new Error('Override selection is invalid: <empty-selection>')
      )
    ).toEqual({
      error:
        'Override selection is invalid. Select at least one filled answer.',
      code: 'OVERRIDE_SELECTION_INVALID',
    });
  });

  it.each([
    'Generation requires a synchronized current page.',
    'Override generation requires a synchronized current page.',
  ])('reports %j as a page synchronization failure', (message) => {
    expect(serviceWorkerErrorResponse(new Error(message))).toMatchObject({
      code: 'GENERATION_PAGE_NOT_SYNCHRONIZED',
      error: 'The page changed during generation. Try again.',
    });
  });

  it('reports a page transition block as a page synchronization failure', () => {
    expect(
      serviceWorkerErrorResponse(
        new Error('Generation is unavailable while page transition is pending.')
      )
    ).toMatchObject({
      code: 'GENERATION_PAGE_NOT_SYNCHRONIZED',
      error: 'Generation is unavailable while the page transition is pending.',
    });
  });

  it('preserves other provider classifications unchanged', () => {
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError(
          'MALFORMED_PROVIDER_RESPONSE',
          'Provider returned an invalid response.'
        )
      )
    ).toEqual({
      error: 'Provider returned an invalid response.',
      code: 'MALFORMED_PROVIDER_RESPONSE',
    });
  });

  it('drops injected diagnostics and unapproved messages', () => {
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError('TIMEOUT', 'Provider request timed out.', {
          diagnostic: 'RAW_PROVIDER_BODY',
        } as unknown as SafeProviderDiagnostics)
      )
    ).toEqual({
      error: 'Provider request timed out.',
      code: 'TIMEOUT',
    });
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError('TIMEOUT', 'authorization: bearer secret')
      )
    ).toEqual({
      error: 'Provider request failed.',
      code: 'PROVIDER_FAILURE',
    });
  });

  it('keeps unrecognized content text out of the response', () => {
    const response = serviceWorkerErrorResponse(
      new Error('Authorization: Bearer sensitive-token')
    );

    expect(response).toEqual({
      error: 'Provider request failed.',
      code: 'PROVIDER_FAILURE',
    });
    expect(JSON.stringify(response)).not.toContain('sensitive-token');
  });

  it('validates provider error codes for the boundary wrapper', () => {
    expect(isSafeProviderErrorCode('TIMEOUT')).toBe(true);
    expect(isSafeProviderErrorCode('PROVIDER_FAILURE')).toBe(true);
    expect(isSafeProviderErrorCode('RAW_PROVIDER_BODY')).toBe(false);
    expect(isSafeProviderErrorCode(undefined)).toBe(false);
    expect(isSafeProviderErrorCode({})).toBe(false);
    expect(sanitizeProviderError({ safeCode: 'TIMEOUT' })).toEqual({
      code: 'TIMEOUT',
      message: 'Provider request timed out.',
    });
  });
});
