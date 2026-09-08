import { EXTENSION_NAME, log } from '../Shared/Utils';
import {
  deleteGeminiCredential,
  hasGeminiCredential,
  readGeminiCredential,
  storeGeminiCredential,
} from '../Generation/Credentials';
import {
  GeminiProvider,
  GeminiProviderError,
  validateGeminiCredential,
} from '../Generation/GeminiProvider';
import { IntegrationStateStore } from './State';

log(`${EXTENSION_NAME} service worker initialized.`);

interface WorkerMessage {
  type?: string;
  request?: unknown;
  snapshot?: import('../Lifecycle/PageLifecycle').LifecycleSnapshot;
  page?: { pageId: string; questionCount: number };
  result?: unknown;
  error?: string;
  apiKey?: unknown;
  retry?: boolean;
}

const stateStore = new IntegrationStateStore();

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

function tabIdFromSender(sender: chrome.runtime.MessageSender): number {
  if (sender.tab?.id === undefined) {
    throw new Error('The message is not associated with a browser tab.');
  }
  return sender.tab.id;
}

async function handleMessage(
  message: WorkerMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  if (message.type === 'gemini-generate') {
    if (!sender.tab) {
      throw new Error(
        'Gemini generation is only available to a content-script operation.'
      );
    }
    const apiKey = await readGeminiCredential();
    if (!apiKey) {
      throw new Error('Configuration required.');
    }
    try {
      return await new GeminiProvider(apiKey).generate(
        message.request as Parameters<GeminiProvider['generate']>[0]
      );
    } catch (error) {
      if (error instanceof GeminiProviderError) {
        throw new Error(error.message);
      }
      throw new Error('Provider unavailable.');
    }
  }

  if (message.type === 'credential-status') {
    return { configured: await hasGeminiCredential() };
  }

  if (message.type === 'credential-save') {
    if (
      sender.tab ||
      sender.id !== chrome.runtime.id ||
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
    if (sender.tab || sender.id !== chrome.runtime.id) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    await deleteGeminiCredential();
    return { configured: false };
  }

  if (message.type === 'credential-test') {
    if (sender.tab || sender.id !== chrome.runtime.id) {
      throw new Error(
        'Credential configuration is only available to the extension UI.'
      );
    }
    const apiKey = await readGeminiCredential();
    if (!apiKey) {
      throw new Error('Configuration required.');
    }
    try {
      await validateGeminiCredential(apiKey);
      return { valid: true };
    } catch (error) {
      if (error instanceof GeminiProviderError) {
        throw new Error(error.message);
      }
      throw new Error('Provider unavailable.');
    }
  }

  if (message.type === 'get-lifecycle-snapshot') {
    return stateStore.get(tabIdFromSender(sender));
  }

  if (message.type === 'lifecycle-snapshot') {
    const tabId = tabIdFromSender(sender);
    const current = stateStore.get(tabId);
    stateStore.update(tabId, {
      lifecycle: message.snapshot ?? null,
      page: message.snapshot
        ? {
            pageId: message.snapshot.activePage.form.activePageId,
            questionCount: message.snapshot.activePage.form.questions.length,
          }
        : (current?.page ?? null),
      uiState: current?.uiState ?? 'READY',
    });
    return { status: 'snapshot-stored' };
  }

  if (message.type === 'lifecycle-transition-confirmed') {
    const tabId = tabIdFromSender(sender);
    const snapshot = stateStore.update(tabId, {
      lifecycle: message.snapshot ?? null,
      uiState: 'READY',
      page: message.page ?? null,
      result: null,
      error: null,
    });
    void chrome.runtime.sendMessage({ type: 'p7-state-updated', snapshot });
    return snapshot;
  }

  if (message.type === 'p7-discover') {
    const tabId = await activeTabId();
    const snapshot = stateStore.get(tabId);
    if (snapshot) {
      return { supported: snapshot.page !== null, ...snapshot };
    }
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'discover-active-page',
    });
    if (response?.page) {
      const stored = stateStore.update(tabId, {
        uiState: 'READY',
        page: {
          pageId: response.page.pageId,
          questionCount: response.page.questions.length,
        },
      });
      return { supported: true, ...stored };
    }
    return response;
  }
  if (message.type === 'p7-generate') {
    const tabId = await activeTabId();
    stateStore.update(tabId, { uiState: 'GENERATING', error: null });
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'generate-current-page',
        retry: message.retry === true,
      });
      if (result?.status === 'reused') {
        stateStore.update(tabId, { uiState: 'READY', result: null });
        return result;
      }
      stateStore.update(tabId, { uiState: 'REVIEW', result });
      return result;
    } catch (error) {
      stateStore.update(tabId, {
        uiState: 'ERROR',
        error: error instanceof Error ? error.message : 'Generation failed.',
      });
      throw error;
    }
  }
  if (message.type === 'p7-review-complete') {
    const snapshot = stateStore.update(await activeTabId(), {
      uiState: 'READY_FOR_NEXT',
    });
    void chrome.runtime.sendMessage({ type: 'p7-state-updated', snapshot });
    return snapshot;
  }
  if (message.type === 'p7-begin-next') {
    return sendToActiveContent({ type: 'begin-next' });
  }
  if (message.type === 'p7-confirm-transition') {
    return sendToActiveContent({ type: 'confirm-transition' });
  }
  if (message.type === 'p7-abandon') {
    return sendToActiveContent({ type: 'abandon' });
  }
  if (message.type === 'p7-restart') {
    return sendToActiveContent({ type: 'restart' });
  }

  return { status: 'ready', extension: EXTENSION_NAME };
}

chrome.runtime.onMessage.addListener(
  (message: WorkerMessage, sender, sendResponse) => {
    void handleMessage(message ?? {}, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
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
