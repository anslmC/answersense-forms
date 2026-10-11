import { describe, expect, it } from 'vitest';
import { GeminiProviderError } from '../src/Generation/GeminiProvider';
import { NvidiaProviderError } from '../src/Generation/NvidiaProvider';
import { sanitizeProviderError } from '../src/Background/ProviderErrorSanitizer';
import {
  SafeServiceWorkerError,
  serviceWorkerErrorResponse,
} from '../src/Background/ServiceWorkerResponse';
import {
  isTrustedContentSender,
  isTrustedContentTabSender,
  isTrustedExtensionSender,
  isTrustedPopupSender,
} from '../src/Background/ServiceWorkerSecurity';

describe('Service Worker provider error sanitization', () => {
  it('maps known provider failures to safe categories and messages', () => {
    const error = new GeminiProviderError(
      'AUTHENTICATION_FAILED',
      'secret=raw-key provider body'
    );
    const safe = sanitizeProviderError(error);

    expect(safe).toEqual({
      code: 'AUTHENTICATION_FAILED',
      message: 'Credential invalid.',
    });
    expect(JSON.stringify(safe)).not.toContain('raw-key');
  });

  it('explains 403 permission failures without exposing raw provider details', () => {
    const safe = sanitizeProviderError(
      new GeminiProviderError('PERMISSION_DENIED', 'PERMISSION_DENIED raw body')
    );

    expect(safe).toEqual({
      code: 'PERMISSION_DENIED',
      message:
        'This key or project doesn’t have access to the selected model. Check your API key and project permissions.',
    });
    expect(JSON.stringify(safe)).not.toContain('raw body');
  });

  it('preserves the sanitized 503 message for the final UI', () => {
    const safe = sanitizeProviderError(
      new GeminiProviderError('PROVIDER_UNAVAILABLE', 'Server was busy. Try again.')
    );

    expect(safe).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Server was busy. Try again.',
    });
  });

  it('sanitizes provider-neutral error metadata without exposing provider details', () => {
    const safe = sanitizeProviderError({
      safeCode: 'PERMISSION_DENIED',
      safeMessageCode: 'UNRECOGNIZED',
      message: 'Authorization: Bearer sensitive-token; raw provider body',
      headers: { authorization: 'sensitive-token' },
    });

    expect(safe).toEqual({
      code: 'PERMISSION_DENIED',
      message:
        'This key or project doesn’t have access to the selected model. Check your API key and project permissions.',
    });
    expect(JSON.stringify(safe)).not.toContain('sensitive-token');
    expect(JSON.stringify(safe)).not.toContain('provider body');
  });

  it('preserves the sanitized timeout category', () => {
    expect(sanitizeProviderError({ safeCode: 'TIMEOUT' })).toEqual({
      code: 'TIMEOUT',
      message: 'Provider request timed out.',
    });
  });

  it('sanitizes unrecognized provider contract codes as generic failures', () => {
    const safe = sanitizeProviderError({
      safeCode: 'RAW_PROVIDER_BODY',
      message: 'sensitive-token raw provider response',
    });

    expect(safe).toEqual({
      code: 'PROVIDER_FAILURE',
      message: 'Provider request failed.',
    });
    expect(JSON.stringify(safe)).not.toContain('sensitive-token');
  });

  it('fails closed when provider metadata getters throw', () => {
    const getterError = Object.defineProperty({}, 'safeCode', {
      get() {
        throw new Error('getter exposed sensitive-token');
      },
    });
    const proxyError = new Proxy({}, {
      get(_target, property) {
        if (property === 'safeCode') {
          throw new Error('proxy exposed sensitive-token');
        }
        return undefined;
      },
    });

    for (const error of [getterError, proxyError]) {
      expect(sanitizeProviderError(error)).toEqual({
        code: 'PROVIDER_FAILURE',
        message: 'Provider request failed.',
      });
    }
  });

  it('maps Gemini malformed-output errors through the shared contract', () => {
    expect(
      sanitizeProviderError(
        new GeminiProviderError(
          'MALFORMED_PROVIDER_OUTPUT',
          'raw provider response and sensitive-token'
        )
      )
    ).toEqual({
      code: 'MALFORMED_PROVIDER_RESPONSE',
      message: 'Provider returned an invalid response.',
    });
  });

  it('preserves the sanitized NVIDIA truncation category through the runtime boundary', () => {
    const safe = sanitizeProviderError(
      new NvidiaProviderError('INCOMPLETE_PROVIDER_RESPONSE')
    );
    expect(safe).toEqual({
      code: 'INCOMPLETE_PROVIDER_RESPONSE',
      message: 'NVIDIA output was truncated. Try fewer or shorter questions.',
    });

    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError(safe.code, safe.message)
      )
    ).toEqual({
      code: 'INCOMPLETE_PROVIDER_RESPONSE',
      error: 'NVIDIA output was truncated. Try fewer or shorter questions.',
    });
  });

  it('does not expose bodies, headers, secrets, or stacks for unknown failures', () => {
    const error = new Error('api-key=secret raw provider response');
    error.stack = 'Error at C:\\private\\provider.ts:1';
    const safe = sanitizeProviderError(error);

    expect(safe.code).toBe('PROVIDER_FAILURE');
    expect(safe.message).toBe('Provider request failed.');
    expect(JSON.stringify(safe)).not.toContain('secret');
    expect(JSON.stringify(safe)).not.toContain('provider.ts');
  });

  it('classifies network-like TypeErrors without exposing the exception', () => {
    expect(sanitizeProviderError(new TypeError('network secret'))).toEqual({
      code: 'NETWORK_FAILURE',
      message: 'Provider network request failed.',
    });
  });

  it('preserves only the sanitized provider code at the runtime response boundary', () => {
    const response = serviceWorkerErrorResponse(
      new SafeServiceWorkerError(
        'AUTHENTICATION_FAILED',
        'Credential invalid.'
      )
    );

    expect(response).toEqual({
      code: 'AUTHENTICATION_FAILED',
      error: 'Credential invalid.',
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('replaces arbitrary safe-error messages with a generic response', () => {
    const response = serviceWorkerErrorResponse(
      new SafeServiceWorkerError(
        'AUTHENTICATION_FAILED',
        'Authorization: Bearer sensitive-token'
      )
    );

    expect(response).toEqual({
      code: 'PROVIDER_FAILURE',
      error: 'Provider request failed.',
    });
    expect(JSON.stringify(response)).not.toContain('sensitive-token');
  });

  it('replaces unapproved safe-error codes with a generic response', () => {
    const response = serviceWorkerErrorResponse(
      new SafeServiceWorkerError(
        'UNAPPROVED_CODE' as SafeServiceWorkerError['code'],
        'Credential invalid.'
      )
    );

    expect(response).toEqual({
      code: 'PROVIDER_FAILURE',
      error: 'Provider request failed.',
    });
  });

  it('preserves established safe service-worker messages', () => {
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError(
          'CONFIGURATION_STALE',
          'Configuration changed during validation.'
        )
      )
    ).toEqual({
      code: 'CONFIGURATION_STALE',
      error: 'Configuration changed during validation.',
    });
    expect(
      serviceWorkerErrorResponse(
        new SafeServiceWorkerError(
          'PROVIDER_UNAVAILABLE',
          'Server was busy. Try again.'
        )
      )
    ).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      error: 'Server was busy. Try again.',
    });
  });

  it('serializes hostile unexpected errors as a fixed safe response', () => {
    const error = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('proxy exposed sensitive-token');
      },
    });

    const response = serviceWorkerErrorResponse(error);

    expect(response).toEqual({
      code: 'PROVIDER_FAILURE',
      error: 'Provider request failed.',
    });
    expect(JSON.stringify(response)).not.toContain('sensitive-token');
  });
});

describe('Service Worker sender provenance', () => {
  const extensionId = 'extension-id';

  it('accepts only the extension identity', () => {
    expect(isTrustedExtensionSender({ id: extensionId }, extensionId)).toBe(true);
    expect(isTrustedExtensionSender({ id: 'other-extension' }, extensionId)).toBe(
      false
    );
    expect(isTrustedExtensionSender({}, extensionId)).toBe(false);
  });

  it('distinguishes trusted popup and content senders', () => {
    expect(isTrustedPopupSender({ id: extensionId }, extensionId)).toBe(true);
    expect(
      isTrustedPopupSender({ id: extensionId, tab: { id: 1 } }, extensionId)
    ).toBe(false);
    expect(isTrustedContentSender({ id: extensionId, tab: { id: 1 } }, extensionId)).toBe(
      true
    );
    expect(isTrustedContentSender({ id: extensionId }, extensionId)).toBe(false);
    expect(
      isTrustedContentSender({ id: extensionId, tab: {} }, extensionId)
    ).toBe(false);
    expect(
      isTrustedContentSender({ id: 'other-extension', tab: { id: 1 } }, extensionId)
    ).toBe(false);
    expect(
      isTrustedContentTabSender({ id: extensionId, tab: { id: 7 } }, extensionId, 7)
    ).toBe(true);
    expect(
      isTrustedContentTabSender({ id: extensionId, tab: { id: 7 } }, extensionId, 8)
    ).toBe(false);
    const subframeSender = {
      id: extensionId,
      tab: { id: 7 },
      frameId: 2,
    };
      expect(
      isTrustedContentSender(subframeSender, extensionId)
      ).toBe(false);
  });
});
