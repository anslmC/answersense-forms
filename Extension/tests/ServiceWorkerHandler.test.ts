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
import type { LifecycleSnapshot } from '../src/Lifecycle/PageLifecycle';

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
  sessionValues?: Record<string, unknown>;
  queryCount: number;
  removedListener?: (tabId: number) => Promise<void>;
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
      onRemoved: {
        addListener: (listener: (tabId: number) => Promise<void>) => {
          state.removedListener = listener;
        },
      },
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
      session: {
        get: async (key: string) => ({
          [key]: state.sessionValues?.[key],
        }),
        set: async (values: Record<string, unknown>) => {
          state.sessionValues ??= {};
          Object.assign(state.sessionValues, values);
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

describe('Service Worker Generate terminal projection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function prepareGenerationResponse(response: unknown) {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.tabs.sendMessage.mockResolvedValue(response);
    const storage = testStorage();
    const authorized = await authorizedState(storage);
    const handleMessage = await loadHandler();
    return { state, handleMessage, authorized };
  }

  const validResult = {
    report: { cycleId: 'cycle-1', status: 'complete', results: [] },
    fillReport: { cycleId: 'cycle-1', outcomes: [] },
  };

  function lifecycleSnapshot(pageId: string, cycleId: string): LifecycleSnapshot {
    return {
      activePage: {
        form: { formId: 'form-1', activePageId: pageId, questions: [] },
        questionResults: [],
        processingCycle: { cycleId },
      },
      activeCycle: { cycleId },
      pending: null,
      settledPages: [],
      visits: [{ pageId, cycleId, status: 'active' }],
      navigation: null,
    };
  }

  it('stores a valid content result as REVIEW', async () => {
    const { handleMessage, state, authorized } =
      await prepareGenerationResponse(validResult);

    await expect(
      handleMessage(
        {
          type: 'p7-generate',
        },
        { id: extensionId } as HandlerSender
      )
    ).resolves.toEqual(validResult);
    expect(state.sessionValues).toBeDefined();
    expect(state.sessionValues).toEqual(
      expect.objectContaining({
        answerSenseIntegrationState: expect.objectContaining({
          [activeTabId]: expect.objectContaining({
            uiState: 'REVIEW',
            result: validResult,
          }),
        }),
        })
      );
      await vi.waitFor(() =>
        expect(
          (globalThis as typeof globalThis & {
            chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
          }).chrome.runtime.sendMessage
        ).toHaveBeenCalledWith({
          type: 'p7-state-updated',
          snapshot: expect.objectContaining({
            uiState: 'REVIEW',
            result: validResult,
          }),
        })
      );
    expect(authorized.resolved.configurationDigest).toBeTruthy();
  });

  it('rejects Override during Content pre-flight before claiming generation', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.tabs.sendMessage.mockRejectedValue(
      new Error('Override selection is invalid: disappeared')
    );
    await authorizedState(testStorage());
    const handleMessage = await loadHandler();

    await expect(
      handleMessage(
        {
          type: 'p7-generate',
          intent: {
            type: 'OVERRIDE_FILLED',
            selectedQuestionIds: ['disappeared'],
          },
        },
        { id: extensionId } as HandlerSender
      )
    ).rejects.toMatchObject({ code: 'GENERATION_PAGE_NOT_SYNCHRONIZED' });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(activeTabId, {
      type: 'preflight-generation',
      intent: {
        type: 'OVERRIDE_FILLED',
        selectedQuestionIds: ['disappeared'],
      },
    });
    expect(
      chromeApi.tabs.sendMessage.mock.calls.some(
        ([, message]) => message.type === 'generate-current-page'
      )
    ).toBe(false);
    expect(state.sessionValues).toBeUndefined();
  });

  it('allows ordinary Generate after a confirmed page transition to a new cycle', async () => {
    const { handleMessage } = await prepareGenerationResponse(validResult);
    const uiSender = { id: extensionId } as HandlerSender;
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;

    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    await handleMessage(
      {
        type: 'lifecycle-transition-confirmed',
        page: { pageId: 'page-2', questionCount: 0 },
        snapshot: lifecycleSnapshot('page-2', 'cycle-2'),
      },
      sender(activeTabId)
    );

    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('allows Generate after discovery reconciles a changed revisit cycle', async () => {
    const { handleMessage } = await prepareGenerationResponse(validResult);
    const uiSender = { id: extensionId } as HandlerSender;
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    chromeApi.tabs.sendMessage.mockImplementation(
      async (_tabId: number, message: { type?: string }) => {
        if (message.type === 'get-current-state') {
          return {
            status: 'current-state',
            supported: true,
            lifecycle: lifecycleSnapshot('page-1', 'cycle-changed'),
            page: { pageId: 'page-1', questionCount: 0 },
          };
        }
        return validResult;
      }
    );
    await handleMessage(
      {
        type: 'lifecycle-snapshot',
        snapshot: lifecycleSnapshot('page-1', 'cycle-original'),
      },
      sender(activeTabId)
    );

    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    await expect(
      handleMessage({ type: 'p7-discover' }, uiSender)
    ).resolves.toMatchObject({
      uiState: 'READY',
      page: { pageId: 'page-1' },
      result: null,
    });
    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledTimes(5);
  });

  it('allows Generate after Force Unsettle All reset state is published', async () => {
    const { handleMessage } = await prepareGenerationResponse(validResult);
    const uiSender = { id: extensionId } as HandlerSender;
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;

    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    await handleMessage(
      {
        type: 'lifecycle-snapshot',
        reset: true,
        snapshot: lifecycleSnapshot('page-1', 'cycle-reset'),
      },
      sender(activeTabId)
    );

    await expect(
      handleMessage({ type: 'p7-generate' }, uiSender)
    ).resolves.toEqual(validResult);
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['content error', { error: 'Generation response was stale.' }],
    ['empty response', undefined],
    ['malformed response', { report: {} }],
  ])('projects %s as ERROR instead of REVIEW', async (_label, response) => {
    const { handleMessage, state } = await prepareGenerationResponse(response);

    await expect(
      handleMessage(
        { type: 'p7-generate' },
        { id: extensionId } as HandlerSender
      )
    ).rejects.toThrow();
    expect(state.sessionValues).toEqual(
      expect.objectContaining({
        answerSenseIntegrationState: expect.objectContaining({
          [activeTabId]: expect.objectContaining({
            uiState: 'ERROR',
            result: null,
          }),
        }),
      })
    );
  });

  it('preserves the first operation when an overlapping request is rejected', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    const responses: Array<{
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }> = [];
    chromeApi.tabs.sendMessage.mockImplementation(
      (_tabId: number, message: { type?: string }) => {
        if (message.type !== 'generate-current-page') {
          return Promise.resolve({});
        }
        return new Promise((resolve, reject) => {
          responses.push({ resolve, reject });
        });
      }
    );
    await authorizedState(testStorage());
    const handleMessage = await loadHandler();
    const first = handleMessage(
      { type: 'p7-generate' },
      { id: extensionId } as HandlerSender
    );
    const second = handleMessage(
      { type: 'p7-generate' },
      { id: extensionId } as HandlerSender
    ).then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    await expect(second).resolves.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
    responses[0].resolve(validResult);
    await expect(first).resolves.toEqual(validResult);

    await expect(
      handleMessage(
        { type: 'get-lifecycle-snapshot' },
        sender(activeTabId)
      )
    ).resolves.toMatchObject({
      uiState: 'REVIEW',
      result: validResult,
      generationOperationId: null,
    });
  });

  it('rejects overlapping Generate requests before a second provider call', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    const responses: Array<{
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }> = [];
    chromeApi.tabs.sendMessage.mockImplementation(
      (_tabId: number, message: { type?: string }) =>
        message.type === 'generate-current-page'
          ? new Promise((resolve, reject) => responses.push({ resolve, reject }))
          : Promise.resolve({})
    );
    await authorizedState(testStorage());
    const handleMessage = await loadHandler();

    const first = handleMessage(
        { type: 'p7-generate' },
        { id: extensionId } as HandlerSender
      );
    const second = handleMessage(
        { type: 'p7-generate' },
        { id: extensionId } as HandlerSender
      ).then(
        () => null,
        (error: unknown) => error
      );
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    await expect(second).resolves.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
    responses[0].resolve(validResult);
    await expect(first).resolves.toEqual(validResult);
    await expect(
      handleMessage({ type: 'get-lifecycle-snapshot' }, sender(activeTabId))
    ).resolves.toMatchObject({
      uiState: 'REVIEW',
      result: validResult,
      generationOperationId: null,
    });

    expect(responses).toHaveLength(1);
  });

  it('retires generation when discovery reconciles a changed lifecycle', async () => {
    const state: ChromeTestState = { values: {}, queryCount: 0 };
    installChrome(state);
    const chromeApi = (globalThis as typeof globalThis & {
      chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } };
    }).chrome;
    let resolveGeneration!: (value: unknown) => void;
    chromeApi.tabs.sendMessage.mockImplementation(
      (_tabId: number, message: { type?: string }) => {
        if (message.type === 'generate-current-page') {
          return new Promise((resolve) => {
            resolveGeneration = resolve;
          });
        }
        return Promise.resolve({
          status: 'current-state',
          supported: true,
          lifecycle: {
            activePage: {
              form: {
                formId: 'form-1',
                activePageId: 'page-2',
                questions: [],
              },
              questionResults: [],
              processingCycle: { cycleId: 'cycle-2' },
            },
            activeCycle: { cycleId: 'cycle-2' },
            pending: null,
            settledPages: [],
            visits: [{ pageId: 'page-2', cycleId: 'cycle-2', status: 'active' }],
            navigation: null,
            documentPathname: '/formResponse',
          },
          page: { pageId: 'page-2', questionCount: 0 },
        });
      }
    );
    await authorizedState(testStorage());
    const handleMessage = await loadHandler();
    const generation = handleMessage(
      { type: 'p7-generate' },
      { id: extensionId } as HandlerSender
    );
    await vi.waitFor(async () => {
      await expect(
        handleMessage({ type: 'get-lifecycle-snapshot' }, sender(activeTabId))
      ).resolves.toMatchObject({ uiState: 'GENERATING' });
    });

    await expect(
      handleMessage(
        { type: 'p7-discover' },
        { id: extensionId } as HandlerSender
      )
    ).resolves.toMatchObject({
      uiState: 'READY',
      page: { pageId: 'page-2' },
    });

    resolveGeneration(validResult);
    await expect(generation).rejects.toThrow('superseded');
    await expect(
      handleMessage({ type: 'get-lifecycle-snapshot' }, sender(activeTabId))
    ).resolves.toMatchObject({
      uiState: 'READY',
      page: { pageId: 'page-2' },
      result: null,
      generationOperationId: null,
    });
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
    const staleLifecycle: LifecycleSnapshot = {
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
    const cached: LifecycleSnapshot = {
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

  it('restores lifecycle state from session storage after worker module restart', async () => {
    const state: ChromeTestState = {
      values: {},
      sessionValues: {},
      queryCount: 0,
    };
    installChrome(state);
    const handleMessage = await loadHandler();
    const cached: LifecycleSnapshot = {
      activePage: {
        form: { formId: 'form-1', activePageId: 'entry:3-6', questions: [] },
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

    await handleMessage(
      { type: 'lifecycle-snapshot', snapshot: cached },
      sender(activeTabId)
    );
    await handleMessage(
      {
        type: 'lifecycle-snapshot',
        snapshot: {
          ...cached,
          activePage: {
            ...cached.activePage,
            form: {
              ...cached.activePage.form,
              formId: 'form-2',
              activePageId: 'entry:0-3',
            },
          },
          activeCycle: { cycleId: 'cycle-other' },
          visits: [
            { pageId: 'entry:0-3', cycleId: 'cycle-other', status: 'active' },
          ],
        },
      },
      sender(activeTabId + 1)
    );

    vi.resetModules();
    installChrome(state);
    const restartedHandleMessage = await loadHandler();

    await expect(
      restartedHandleMessage(
        { type: 'get-lifecycle-snapshot' },
        sender(activeTabId)
      )
    ).resolves.toMatchObject({
      lifecycle: { activeCycle: { cycleId: 'cycle-2' } },
      page: { pageId: 'entry:3-6' },
    });
    await expect(
      restartedHandleMessage(
        { type: 'get-lifecycle-snapshot' },
        sender(activeTabId + 1)
      )
    ).resolves.toMatchObject({
      lifecycle: {
        activePage: { form: { formId: 'form-2', activePageId: 'entry:0-3' } },
      },
    });
  });

  it('cleans the closed tab entry without affecting another tab', async () => {
    const state: ChromeTestState = {
      values: {},
      sessionValues: {},
      queryCount: 0,
    };
    installChrome(state);
    const handleMessage = await loadHandler();
    const snapshot: LifecycleSnapshot = {
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
    await expect(handleMessage(
      { type: 'lifecycle-snapshot', snapshot },
      sender(activeTabId)
    )).resolves.toEqual({ status: 'snapshot-stored' });
    await handleMessage(
      { type: 'lifecycle-snapshot', snapshot },
      sender(activeTabId + 1)
    );

    await state.removedListener?.(activeTabId);

    vi.resetModules();
    installChrome(state);
    const restartedHandleMessage = await loadHandler();
    await expect(
      restartedHandleMessage(
        { type: 'get-lifecycle-snapshot' },
        sender(activeTabId)
      )
    ).resolves.toBeNull();
    await expect(
      restartedHandleMessage(
        { type: 'get-lifecycle-snapshot' },
        sender(activeTabId + 1)
      )
    ).resolves.toMatchObject({ page: { pageId: 'entry:0-3' } });
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
    ).resolves.toMatchObject({
      status: 'transition-stored',
      snapshot: { page: { pageId: 'entry:3-6' } },
    });
  });

});

describe('Service Worker lifecycle reset durability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('persists a reset snapshot and clears the popup projection', async () => {
    const state: ChromeTestState = { values: {}, sessionValues: {}, queryCount: 0 };
    installChrome(state);
    const handleMessage = await loadHandler();
    const settledSnapshot: LifecycleSnapshot = {
      activePage: {
        form: { formId: 'form-1', activePageId: 'entry:3-6', questions: [] },
        questionResults: [],
        processingCycle: { cycleId: 'cycle-3' },
      },
      activeCycle: { cycleId: 'cycle-3' },
      pending: null,
      settledPages: [
        { pageId: 'entry:0-3', pageFingerprint: 'old', answers: [] },
      ],
      visits: [
        { pageId: 'entry:0-3', cycleId: 'cycle-1', status: 'settled' },
        { pageId: 'entry:3-6', cycleId: 'cycle-3', status: 'active' },
      ],
      navigation: null,
      documentPathname: '/formResponse',
    };

    await handleMessage(
      { type: 'lifecycle-snapshot', snapshot: settledSnapshot },
      sender(activeTabId)
    );
    await handleMessage(
      { type: 'lifecycle-snapshot', reset: true, snapshot: {
        ...settledSnapshot,
        settledPages: [],
        visits: [{ pageId: 'entry:3-6', cycleId: 'cycle-4', status: 'active' }],
        activeCycle: { cycleId: 'cycle-4' },
      } },
      sender(activeTabId)
    );

    await expect(
      handleMessage({ type: 'get-lifecycle-snapshot' }, sender(activeTabId))
    ).resolves.toMatchObject({
      lifecycle: { settledPages: [], activeCycle: { cycleId: 'cycle-4' } },
      uiState: 'READY',
      result: null,
      error: null,
    });
    expect(state.sessionValues).toBeDefined();
  });

  it('forwards normal filled lifecycle snapshots to the live UI projection', async () => {
    const state: ChromeTestState = { values: {}, sessionValues: {}, queryCount: 0 };
    installChrome(state);
    const handleMessage = await loadHandler();
    const snapshot: LifecycleSnapshot = {
      activePage: {
        form: {
          formId: 'form-1',
          activePageId: 'entry:0-3',
          questions: [
            {
              id: 'name',
              text: 'Name',
              type: 'short-text',
              required: false,
              options: [],
              existingInput: { value: 'Ada', hasValue: true },
              supported: true,
              unsupportedReason: null,
            },
          ],
        },
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
      { type: 'lifecycle-snapshot', snapshot },
      sender(activeTabId)
    );

    expect(
      (globalThis as typeof globalThis & {
        chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
      }).chrome.runtime.sendMessage
    ).toHaveBeenCalledWith({
      type: 'p7-state-updated',
      snapshot: expect.objectContaining({ lifecycle: snapshot }),
    });
  });
});
