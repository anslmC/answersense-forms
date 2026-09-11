import { EXTENSION_NAME, log } from '../Shared/Utils';
import {
  createCredential,
  clearActiveConfiguration,
  deleteGeminiCredential,
  deleteCredential,
  getActiveConfiguration,
  getConfigurationStateRevision,
  getValidation,
  hasGeminiCredential,
  listCredentials,
  replaceCredential,
  saveValidation,
  setActiveConfiguration,
  storeGeminiCredential,
} from '../Generation/Credentials';
import { validateGeminiCredential } from '../Generation/GeminiProvider';
import {
  PROVIDER_REGISTRY,
  resolveProvider,
  resolveProviderModel,
} from '../Generation/ProviderRegistry';
import { configurationIdentity } from '../Generation/Credentials';
import type { GenerationRequest } from '../Generation/Contract';
import {
  resolveActiveProviderConfiguration,
  resolveAuthorizedProviderConfiguration,
} from './ServiceWorkerConfiguration';
import { sanitizeProviderError } from './ProviderErrorSanitizer';
import {
  isTrustedContentSender,
  isTrustedContentTabSender,
  isTrustedUiSender,
} from './ServiceWorkerSecurity';
import {
  SafeServiceWorkerError,
  serviceWorkerErrorResponse,
} from './ServiceWorkerResponse';
import { isUiGenerationResult } from '../Popup/State';
import {
  IntegrationStateStore,
  reconcileContentState,
  type CurrentContentState,
} from './State';

log(`${EXTENSION_NAME} service worker initialized.`);

interface WorkerMessage {
  type?: string;
  request?: unknown;
  snapshot?: import('../Lifecycle/PageLifecycle').LifecycleSnapshot;
  reset?: boolean;
  page?: { pageId: string; questionCount: number };
  result?: unknown;
  error?: string;
  apiKey?: unknown;
  retry?: boolean;
  configurationDigest?: unknown;
  configurationRevision?: unknown;
  credentialId?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  label?: unknown;
  secret?: unknown;
  providerConfig?: unknown;
}

const stateStore = new IntegrationStateStore(chrome.storage.session);

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) {
    throw new Error('No active tab is available.');
  }
  return tabId;
}

async function sendToActiveContent(message: WorkerMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(await activeTabId(), message);
}

const actionApi = (chrome as unknown as {
  action?: {
    onClicked?: {
      addListener?: (listener: (tab: chrome.tabs.Tab) => void) => void;
    };
  };
}).action;
if (actionApi?.onClicked?.addListener) {
  actionApi.onClicked.addListener((tab) => {
    if (!tab.id) {
      return;
    }
    void chrome.tabs.sendMessage(tab.id, { type: 'toggle-overlay' }).catch(() => {
      // The page may not be a supported AnswerSense form page; close silently.
    });
  });
}

function isMissingMessageReceiver(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Could not establish connection|Receiving end does not exist/i.test(
      error.message
    )
  );
}

async function notifyPopup(message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (!isMissingMessageReceiver(error)) {
      throw error;
    }
  }
}

async function configurationState(): Promise<Record<string, unknown>> {
  const activeConfiguration = await getActiveConfiguration();
  const identity = activeConfiguration
    ? await configurationIdentity(activeConfiguration)
    : null;
  return {
    providers: PROVIDER_REGISTRY.map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      models: provider.models.map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
      })),
      supportsValidation: provider.supportsValidation,
    })),
    credentials: await listCredentials(),
    activeConfiguration,
    configurationDigest: identity?.digest ?? null,
    configurationRevision: await getConfigurationStateRevision(),
    validation: identity ? await getValidation(identity.digest) : null,
  };
}

async function validateActiveConfiguration(): Promise<{ valid: true }> {
  const resolved = await resolveActiveProviderConfiguration();
  if (resolved.provider.providerId !== 'gemini') {
    throw new Error('Provider validation unavailable.');
  }
  try {
    await validateGeminiCredential(resolved.secret);
  } catch (error) {
    const safe = sanitizeProviderError(error);
    const current = await resolveActiveProviderConfiguration();
    if (current.configurationDigest !== resolved.configurationDigest) {
      throw new SafeServiceWorkerError(
        'CONFIGURATION_STALE',
        'Configuration changed during validation.'
      );
    }
    await saveValidation({
      configurationDigest: resolved.configurationDigest,
      providerId: resolved.provider.providerId,
      modelId: resolved.model.modelId,
      credentialId: resolved.configuration.credentialId,
      status: 'INVALID',
      validatedAt: new Date().toISOString(),
      failureCode: safe.code,
    });
    throw new SafeServiceWorkerError(safe.code, safe.message);
  }
  const current = await resolveActiveProviderConfiguration();
  if (current.configurationDigest !== resolved.configurationDigest) {
    throw new SafeServiceWorkerError(
      'CONFIGURATION_STALE',
      'Configuration changed during validation.'
    );
  }
  await saveValidation({
    configurationDigest: resolved.configurationDigest,
    providerId: resolved.provider.providerId,
    modelId: resolved.model.modelId,
    credentialId: resolved.configuration.credentialId,
    status: 'VALID',
    validatedAt: new Date().toISOString(),
  });
  return { valid: true };
}

function tabIdFromSender(sender: chrome.runtime.MessageSender): number {
  if (
    !isTrustedContentSender(sender, chrome.runtime.id) ||
    sender.tab?.id === undefined
  ) {
    throw new Error('The message is not associated with a browser tab.');
  }
  return sender.tab.id;
}

export async function handleMessage(
  message: WorkerMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) {
    throw new Error('Unauthorized extension message.');
  }

  if (message.type === 'gemini-generate') {
    if (
      !isTrustedContentSender(sender, chrome.runtime.id) ||
      typeof message.configurationDigest !== 'string' ||
      !message.configurationDigest
    ) {
      throw new Error(
        'Gemini generation is only available to a content-script operation.'
      );
    }
    if (
      typeof message.configurationRevision !== 'number' ||
      !Number.isInteger(message.configurationRevision) ||
      message.configurationRevision < 0
    ) {
      throw new SafeServiceWorkerError(
        'CONFIGURATION_STALE',
        'Generation configuration is stale.'
      );
    }
    const senderTab = sender.tab;
    const requestingTabId = senderTab?.id;
    if (
      typeof requestingTabId !== 'number' ||
      !Number.isInteger(requestingTabId) ||
      requestingTabId < 0
    ) {
      throw new SafeServiceWorkerError(
        'UNAUTHORIZED_SENDER',
        'Generation request is not from a valid content tab.'
      );
    }
    const initialActiveTabId = await activeTabId();
    if (
      !isTrustedContentTabSender(sender, chrome.runtime.id, initialActiveTabId)
    ) {
      throw new SafeServiceWorkerError(
        'UNAUTHORIZED_SENDER',
        'Generation request is not from the active tab.'
      );
    }
    let resolved;
    try {
      resolved = await resolveAuthorizedProviderConfiguration(
        message.configurationDigest,
        undefined,
        message.configurationRevision
      );
    } catch (error) {
      throw new SafeServiceWorkerError(
        error instanceof Error && error.message.includes('changed')
          ? 'CONFIGURATION_STALE'
          : 'CONFIGURATION_NOT_AUTHORIZED',
        error instanceof Error && error.message.includes('changed')
          ? 'Generation configuration is stale.'
          : 'Generation configuration is not authorized.'
      );
    }
    const finalActiveTabId = await activeTabId();
    if (
      !isTrustedContentTabSender(sender, chrome.runtime.id, finalActiveTabId)
    ) {
      throw new SafeServiceWorkerError(
        'UNAUTHORIZED_SENDER',
        'Generation request is not from the active tab.'
      );
    }
    const finalRevision = await getConfigurationStateRevision();
    if (finalRevision !== resolved.authorizationRevision) {
      throw new SafeServiceWorkerError(
        'CONFIGURATION_STALE',
        'Generation configuration is stale.'
      );
    }
    try {
      return await resolved
        .adapter(resolved.secret)
        .generate(message.request as GenerationRequest);
    } catch (error) {
      const safe = sanitizeProviderError(error);
      throw new SafeServiceWorkerError(safe.code, safe.message);
    }
  }

  if (message.type === 'credential-status') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    return { configured: await hasGeminiCredential() };
  }

  if (message.type === 'configuration-state') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Configuration is only available to the extension UI.');
    }
    return configurationState();
  }

  if (message.type === 'credential-create') {
    if (
      !isTrustedUiSender(sender, chrome.runtime.id) ||
      typeof message.providerId !== 'string' ||
      typeof message.label !== 'string' ||
      typeof message.secret !== 'string'
    ) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    if (!resolveProvider(message.providerId)) {
      throw new Error('Unsupported provider configuration.');
    }
    return createCredential({
      providerId: message.providerId,
      label: message.label,
      secret: message.secret,
    });
  }

  if (message.type === 'credential-replace') {
    if (
      !isTrustedUiSender(sender, chrome.runtime.id) ||
      typeof message.credentialId !== 'string' ||
      typeof message.providerId !== 'string' ||
      typeof message.label !== 'string' ||
      typeof message.secret !== 'string'
    ) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    if (!resolveProvider(message.providerId)) {
      throw new Error('Unsupported provider configuration.');
    }
    return replaceCredential(message.credentialId, {
      providerId: message.providerId,
      label: message.label,
      secret: message.secret,
    });
  }

  if (message.type === 'credential-delete-selected') {
    if (
      !isTrustedUiSender(sender, chrome.runtime.id) ||
      typeof message.credentialId !== 'string'
    ) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    await deleteCredential(message.credentialId);
    return { deleted: true };
  }

  if (message.type === 'configuration-set') {
    if (
      !isTrustedUiSender(sender, chrome.runtime.id) ||
      typeof message.providerId !== 'string' ||
      typeof message.modelId !== 'string' ||
      typeof message.credentialId !== 'string'
    ) {
      throw new Error('Configuration is only available to the extension UI.');
    }
    if (!resolveProviderModel(message.providerId, message.modelId)) {
      throw new Error('Unsupported provider configuration.');
    }
    await setActiveConfiguration({
      providerId: message.providerId,
      modelId: message.modelId,
      credentialId: message.credentialId,
      providerConfig:
        typeof message.providerConfig === 'object' &&
        message.providerConfig !== null &&
        !Array.isArray(message.providerConfig)
          ? (message.providerConfig as Record<string, unknown>)
          : {},
    });
    return configurationState();
  }

  if (message.type === 'configuration-clear') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Configuration is only available to the extension UI.');
    }
    await clearActiveConfiguration();
    return configurationState();
  }

  if (message.type === 'configuration-validate') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Validation is only available to the extension UI.');
    }
    return validateActiveConfiguration();
  }

  if (message.type === 'credential-save') {
    if (
      !isTrustedUiSender(sender, chrome.runtime.id) ||
      typeof message.apiKey !== 'string'
    ) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    await storeGeminiCredential(message.apiKey);
    return { configured: true };
  }

  if (message.type === 'credential-delete') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    await deleteGeminiCredential();
    return { configured: false };
  }

  if (message.type === 'credential-test') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    return validateActiveConfiguration();
  }

  if (message.type === 'get-lifecycle-snapshot') {
    return stateStore.get(tabIdFromSender(sender));
  }

  if (message.type === 'lifecycle-snapshot') {
    const tabId = tabIdFromSender(sender);
    const current = await stateStore.get(tabId);
    await stateStore.update(tabId, {
      lifecycle: message.snapshot ?? null,
      page: message.snapshot
        ? {
            pageId: message.snapshot.activePage.form.activePageId,
            questionCount: message.snapshot.activePage.form.questions.length,
          }
        : (current?.page ?? null),
      uiState: message.reset ? 'READY' : current?.uiState ?? 'READY',
      ...(message.reset ? { result: null, error: null } : {}),
      ...(message.reset ? { generationOperationId: null } : {}),
    });
    if (message.reset) {
      const snapshot = await stateStore.get(tabId);
      if (snapshot) {
        await notifyPopup({ type: 'p7-state-updated', snapshot });
        return { status: 'snapshot-stored', snapshot };
      }
    }
    return { status: 'snapshot-stored' };
  }

  if (message.type === 'lifecycle-transition-confirmed') {
    const tabId = tabIdFromSender(sender);
    const snapshot = await stateStore.update(tabId, {
      lifecycle: message.snapshot ?? null,
      uiState: 'READY',
      page: message.page ?? null,
      result: null,
      error: null,
      generationOperationId: null,
    });
    void notifyPopup({ type: 'p7-state-updated', snapshot });
    return { status: 'transition-stored', snapshot };
  }

  if (message.type === 'p7-discover') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Discovery is only available to the extension UI.');
    }
    const tabId = await activeTabId();
    const snapshot = await stateStore.get(tabId);
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'get-current-state',
      });
      if (response?.supported === false) {
        return { supported: false };
      }
      if (response?.status === 'no-active-page') {
        return {
          supported: true,
          page: null,
          lifecycle: null,
          uiState: 'UNSUPPORTED',
          result: null,
          error: null,
        };
      }
      if (response?.lifecycle && response?.page) {
        const latestSnapshot = await stateStore.get(tabId);
        const reconciled = reconcileContentState(latestSnapshot, {
          lifecycle: response.lifecycle,
          page: response.page,
        } satisfies CurrentContentState);
        const stored = reconciled === latestSnapshot
          ? latestSnapshot
          : await stateStore.set(tabId, reconciled);
        return { supported: true, ...stored };
      }
    } catch {
      // Fall back to the worker projection when the tab has no content script.
    }
    return snapshot
      ? { supported: snapshot.page !== null, ...snapshot }
      : { supported: false, page: null };
  }
  if (message.type === 'p7-generate') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Generation is only available to the extension UI.');
    }
    let resolved;
    try {
      resolved = await resolveAuthorizedProviderConfiguration();
    } catch (error) {
      throw new SafeServiceWorkerError(
        error instanceof Error && error.message.includes('changed')
          ? 'CONFIGURATION_STALE'
          : 'CONFIGURATION_NOT_AUTHORIZED',
        error instanceof Error && error.message.includes('changed')
          ? 'Generation configuration is stale.'
          : 'Generation configuration is not authorized.'
      );
    }
    const tabId = await activeTabId();
    const generationOperationId = crypto.randomUUID();
    await stateStore.update(tabId, {
      uiState: 'GENERATING',
      error: null,
      generationOperationId,
    });
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'generate-current-page',
        retry: message.retry === true,
        configurationDigest: resolved.configurationDigest,
        configurationRevision: resolved.authorizationRevision,
      });
      if (result?.error) {
        throw new Error(String(result.error));
      }
      if (!isUiGenerationResult(result)) {
        throw new Error('Generation returned an invalid result.');
      }
      if ('status' in result && result.status === 'reused') {
        if (
          !(await stateStore.updateIfGenerationCurrent(
            tabId,
            generationOperationId,
            {
              uiState: 'READY',
              result: null,
              error: null,
              generationOperationId: null,
            }
          ))
        ) {
          throw new Error('Generation operation was superseded.');
        }
        return result;
      }
      if (
        !(await stateStore.updateIfGenerationCurrent(
          tabId,
          generationOperationId,
          {
            uiState: 'REVIEW',
            result,
            error: null,
            generationOperationId: null,
          }
        ))
      ) {
        throw new Error('Generation operation was superseded.');
      }
      return result;
    } catch (error) {
      await stateStore.updateIfGenerationCurrent(tabId, generationOperationId, {
        uiState: 'ERROR',
        error: error instanceof Error ? error.message : 'Generation failed.',
        result: null,
        generationOperationId: null,
      });
      throw error;
    }
  }
  if (message.type === 'p7-begin-next') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Navigation control is only available to the extension UI.'
      );
    }
    return sendToActiveContent({ type: 'begin-next' });
  }
  if (message.type === 'p7-force-clear') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error('Lifecycle control is only available to the extension UI.');
    }
    return sendToActiveContent({ type: 'force-clear' });
  }
  if (message.type === 'p7-confirm-transition') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Navigation control is only available to the extension UI.'
      );
    }
    return sendToActiveContent({ type: 'confirm-transition' });
  }
  if (message.type === 'p7-abandon') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Navigation control is only available to the extension UI.'
      );
    }
    return sendToActiveContent({ type: 'abandon' });
  }
  if (message.type === 'p7-restart') {
    if (!isTrustedUiSender(sender, chrome.runtime.id)) {
      throw new Error(
        'Navigation control is only available to the extension UI.'
      );
    }
    return sendToActiveContent({ type: 'restart' });
  }

  return { status: 'ready', extension: EXTENSION_NAME };
}

chrome.runtime.onMessage.addListener(
  (message: WorkerMessage, sender, sendResponse) => {
    void handleMessage(message ?? {}, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        if (error instanceof SafeServiceWorkerError) {
          sendResponse(serviceWorkerErrorResponse(error));
          return;
        }
        sendResponse({
          error:
            error instanceof Error
              ? error.message
              : 'Browser bridge operation failed.',
        });
      });
    return true;
  }
);

chrome.runtime.onInstalled.addListener(() => {
  log('Extension installed and ready for P7 integration.');
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  return stateStore.remove(tabId);
});
