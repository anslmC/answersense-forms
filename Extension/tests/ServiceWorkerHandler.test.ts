import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCredential,
  replaceCredential,
  saveValidation,
  setActiveConfiguration,
  type CredentialStorage,
} from '../src/Generation/Credentials';
import { GEMINI_MODEL } from '../src/Generation/GeminiProvider';
import { GEMINI_PROVIDER_ID } from '../src/Generation/ProviderRegistry';
import { resolveActiveProviderConfiguration } from '../src/Background/ServiceWorkerConfiguration';

const handlerState = vi.hoisted(() => ({
  adapterCalls: 0,
  providerCalls: 0,
}));

vi.mock('../src/Generation/ProviderRegistry', async () => {
  const actual = await vi.importActual<
    typeof import('../src/Generation/ProviderRegistry')
  >('../src/Generation/ProviderRegistry');
  return {
    ...actual,
    resolveAdapter: (adapterId: unknown) => {
      if (adapterId !== actual.GEMINI_ADAPTER_ID) {
        return null;
      }
      return (secret: string) => {
        handlerState.adapterCalls += 1;
        expect(secret).toBe('test-secret');
        return {
          generate: async () => {
            handlerState.providerCalls += 1;
            return { cycleId: 'handler-cycle', results: [] };
          },
        };
      };
    },
  };
});

const extensionId = 'extension-id';
const activeTabId = 17;

type Handler = Awaited<ReturnType<typeof loadHandler>>;
type HandlerSender = Parameters<Handler>[1];
type ChromeTestGlobal = { chrome: { storage: { local: CredentialStorage } } };

type ChromeTestState = {
  values: Record<string, unknown>;
  queryCount: number;
};

function installChrome(
  state: ChromeTestState,
  beforeSecondQuery?: () => Promise<void>
): void {
  const chromeApi = {
    runtime: {
      id: extensionId,
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => {
        state.queryCount += 1;
        if (state.queryCount === 2 && beforeSecondQuery) {
          await beforeSecondQuery();
        }
        return [{ id: activeTabId }];
      }),
      sendMessage: vi.fn(),
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: state.values[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.values, values);
        },
        remove: async (key: string) => {
          delete state.values[key];
        },
      },
    },
  };
  vi.stubGlobal('chrome', chromeApi);
}

function sender(tabId: number): HandlerSender {
  return { id: extensionId, tab: { id: tabId } } as HandlerSender;
}

function testStorage(): CredentialStorage {
  return (globalThis as unknown as ChromeTestGlobal).chrome.storage.local;
}

async function authorizedState(storage: CredentialStorage) {
  const credential = await createCredential(
    { providerId: GEMINI_PROVIDER_ID, label: 'Primary', secret: 'test-secret' },
    storage
  );
  const configuration = {
    providerId: GEMINI_PROVIDER_ID,
    modelId: GEMINI_MODEL,
    credentialId: credential.credentialId,
    providerConfig: {},
  };
  await setActiveConfiguration(configuration, storage);
  const resolved = await resolveActiveProviderConfiguration(storage);
  await saveValidation(
    {
      configurationDigest: resolved.configurationDigest,
      providerId: resolved.provider.providerId,
      modelId: resolved.model.modelId,
      credentialId: resolved.configuration.credentialId,
      status: 'VALID',
      validatedAt: '2026-09-08T00:00:00.000Z',
    },
    storage
  );
  return {
    credentialId: credential.credentialId,
    configuration,
    resolved: await resolveActiveProviderConfiguration(storage),
  };
}

async function loadHandler() {
  const module = await import('../src/Background/ServiceWorker');
  return module.handleMessage;
}

describe('Service Worker generation handler security boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    handlerState.adapterCalls = 0;
    handlerState.providerCalls = 0;
  });

  it('rejects a stale revision before adapter and provider invocation', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state, async () => {
      const storage = testStorage();
      const current = await resolveActiveProviderConfiguration(storage);
      await setActiveConfiguration(
        {
          ...current.configuration,
          providerConfig: { changed: true },
        },
        storage
      );
    });
    const storage = testStorage();
    const authorized = await authorizedState(storage);
    const handleMessage = await loadHandler();

    await expect(
      handleMessage(
        {
          type: 'gemini-generate',
          request: {},
          configurationDigest: authorized.resolved.configurationDigest,
          configurationRevision: authorized.resolved.authorizationRevision,
        },
        sender(activeTabId)
      )
    ).rejects.toMatchObject({ code: 'CONFIGURATION_STALE' });
    expect(handlerState.adapterCalls).toBe(0);
    expect(handlerState.providerCalls).toBe(0);
  });

  it('rejects credential replacement during generation before stale adapter use', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    let oldCredentialId = '';
    installChrome(state, async () => {
      const storage = testStorage();
      await replaceCredential(
        oldCredentialId,
        { providerId: GEMINI_PROVIDER_ID, label: 'Replacement', secret: 'new-secret' },
        storage
      );
    });
    const storage = testStorage();
    const authorized = await authorizedState(storage);
    oldCredentialId = authorized.credentialId;
    const handleMessage = await loadHandler();

    await expect(
      handleMessage(
        {
          type: 'gemini-generate',
          request: {},
          configurationDigest: authorized.resolved.configurationDigest,
          configurationRevision: authorized.resolved.authorizationRevision,
        },
        sender(activeTabId)
      )
    ).rejects.toMatchObject({ code: 'CONFIGURATION_STALE' });
    expect(handlerState.adapterCalls).toBe(0);
    expect(handlerState.providerCalls).toBe(0);
  });

  it('rejects a valid extension sender from a non-active tab before adapter invocation', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const storage = testStorage();
    const authorized = await authorizedState(storage);
    const handleMessage = await loadHandler();

    await expect(
      handleMessage(
        {
          type: 'gemini-generate',
          request: {},
          configurationDigest: authorized.resolved.configurationDigest,
          configurationRevision: authorized.resolved.authorizationRevision,
        },
        sender(activeTabId + 1)
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_SENDER' });
    expect(handlerState.adapterCalls).toBe(0);
    expect(handlerState.providerCalls).toBe(0);
  });
});

describe('Service Worker current-content discovery reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the current content page instead of a stale cached page', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    const currentLifecycle = {
      activePage: {
        form: {
          formId: 'form-1',
          activePageId: 'entry:3-6',
          questions: [],
        },
        questionResults: [],
        processingCycle: { cycleId: 'cycle-2' },
      },
      activeCycle: { cycleId: 'cycle-2' },
      pending: null,
      settledPages: [],
      visits: [{ pageId: 'entry:3-6', cycleId: 'cycle-2', status: 'active' }],
      navigation: null,
      documentPathname: '/formResponse',
    };
    chromeApi.tabs.sendMessage.mockResolvedValue({
      status: 'current-state',
      supported: true,
      lifecycle: currentLifecycle,
      page: { pageId: 'entry:3-6', questionCount: 2 },
    });
    const handleMessage = await loadHandler();
    const staleLifecycle = {
      ...currentLifecycle,
      activePage: {
        ...currentLifecycle.activePage,
        form: { ...currentLifecycle.activePage.form, activePageId: 'entry:0-3' },
        processingCycle: { cycleId: 'cycle-1' },
      },
      activeCycle: { cycleId: 'cycle-1' },
      visits: [{ pageId: 'entry:0-3', cycleId: 'cycle-1', status: 'active' }],
      documentPathname: '/viewform',
    };

    await handleMessage(
      {
        type: 'lifecycle-snapshot',
        snapshot: staleLifecycle,
      },
      sender(activeTabId)
    );
    const response = await handleMessage(
      { type: 'p7-discover' },
      { id: extensionId } as HandlerSender
    );

    expect(response).toMatchObject({
      supported: true,
      page: { pageId: 'entry:3-6', questionCount: 2 },
      uiState: 'READY',
      result: null,
    });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(activeTabId, {
      type: 'get-current-state',
    });
  });

  it('falls back to the cached snapshot when the content script is unavailable', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.tabs.sendMessage.mockRejectedValue(new Error('No receiver'));
    const handleMessage = await loadHandler();
    const cached = {
      activePage: {
        form: { formId: 'form-1', activePageId: 'entry:0-3', questions: [] },
        questionResults: [],
        processingCycle: { cycleId: 'cycle-1' },
      },
      activeCycle: { cycleId: 'cycle-1' },
      pending: null,
      settledPages: [],
      visits: [{ pageId: 'entry:0-3', cycleId: 'cycle-1', status: 'active' }],
      navigation: null,
      documentPathname: '/viewform',
    };
    await handleMessage(
      { type: 'lifecycle-snapshot', snapshot: cached },
      sender(activeTabId)
    );

    await expect(
      handleMessage({ type: 'p7-discover' }, { id: extensionId } as HandlerSender)
    ).resolves.toMatchObject({
      supported: true,
      page: { pageId: 'entry:0-3' },
    });
  });
});

describe('Service Worker popup broadcast reliability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not reject when the popup receiver disappeared after a transition', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.runtime.sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );
    const handleMessage = await loadHandler();

    await expect(
      handleMessage(
        {
          type: 'lifecycle-transition-confirmed',
          page: { pageId: 'entry:3-6', questionCount: 2 },
          snapshot: {
            activePage: {
              form: {
                formId: 'form-1',
                activePageId: 'entry:3-6',
                questions: [],
              },
              questionResults: [],
              processingCycle: { cycleId: 'cycle-2' },
            },
            activeCycle: { cycleId: 'cycle-2' },
            pending: null,
            settledPages: [],
            visits: [
              {
                pageId: 'entry:3-6',
                cycleId: 'cycle-2',
                status: 'active',
              },
            ],
            navigation: null,
            documentPathname: '/formResponse',
          },
        },
        sender(activeTabId)
      )
    ).resolves.toMatchObject({ page: { pageId: 'entry:3-6' } });
  });

  it('does not reject when the popup receiver disappeared after review completion', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.runtime.sendMessage.mockRejectedValue(
      new Error('Receiving end does not exist.')
    );
    const handleMessage = await loadHandler();

    await expect(
      handleMessage({ type: 'p7-review-complete' }, { id: extensionId } as HandlerSender)
    ).resolves.toMatchObject({ uiState: 'READY_FOR_NEXT' });
  });
});
