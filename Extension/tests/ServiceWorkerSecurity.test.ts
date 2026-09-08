import { describe, expect, it } from 'vitest';
import { GeminiProviderError } from '../src/Generation/GeminiProvider';
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
  });
});
