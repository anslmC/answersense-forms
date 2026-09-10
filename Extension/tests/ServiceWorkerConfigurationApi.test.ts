import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIGURATION_STATE_STORAGE_KEY,
  type CredentialStorage,
} from '../src/Generation/Credentials';
import { GEMINI_MODEL } from '../src/Generation/GeminiProvider';
import { GEMINI_PROVIDER_ID } from '../src/Generation/ProviderRegistry';

const validationMock = vi.hoisted(() => ({
  validate: vi.fn(async () => undefined),
}));

vi.mock('../src/Generation/GeminiProvider', async () => {
  const actual = await vi.importActual<
    typeof import('../src/Generation/GeminiProvider')
  >('../src/Generation/GeminiProvider');
  return {
    ...actual,
    validateGeminiCredential: validationMock.validate,
  };
});

const extensionId = 'extension-id';
type Handler = Awaited<ReturnType<typeof loadHandler>>;
type HandlerSender = Parameters<Handler>[1];
type StoredState = Record<string, unknown>;

type ChromeTestState = {
  values: Record<string, unknown>;
};

function installChrome(state: ChromeTestState): void {
  vi.stubGlobal('chrome', {
    runtime: {
      id: extensionId,
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 17 }]),
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
      } satisfies CredentialStorage,
    },
  });
}

function popupSender(): HandlerSender {
  return { id: extensionId } as HandlerSender;
}

function untrustedSender(): HandlerSender {
  return { id: extensionId, tab: { id: 17 } } as HandlerSender;
}

async function loadHandler(): Promise<
  typeof import('../src/Background/ServiceWorker').handleMessage
> {
  const module = await import('../src/Background/ServiceWorker');
  return module.handleMessage;
}

async function storedState(state: ChromeTestState): Promise<StoredState> {
  return (state.values[CONFIGURATION_STATE_STORAGE_KEY] ?? {}) as StoredState;
}

describe('Service Worker configuration API boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    validationMock.validate.mockResolvedValue(undefined);
  });

  it('rejects untrusted configuration mutation, credential, and validation messages from a content sender without mutation', async () => {
    const state: ChromeTestState = { values: {} };
    installChrome(state);
    const handleMessage = await loadHandler();
    const messages = [
      {
        type: 'credential-create',
        providerId: GEMINI_PROVIDER_ID,
        label: 'Primary',
        secret: 'raw-secret',
      },
      {
        type: 'credential-replace',
        credentialId: 'missing',
        providerId: GEMINI_PROVIDER_ID,
        label: 'Replacement',
        secret: 'replacement-secret',
      },
      { type: 'credential-delete-selected', credentialId: 'missing' },
      {
        type: 'configuration-set',
        providerId: GEMINI_PROVIDER_ID,
        modelId: GEMINI_MODEL,
        credentialId: 'missing',
      },
      { type: 'configuration-clear' },
      { type: 'configuration-validate' },
    ];

    for (const message of messages) {
      await expect(handleMessage(message, untrustedSender())).rejects.toThrow();
    }
    expect(state.values[CONFIGURATION_STATE_STORAGE_KEY]).toBeUndefined();
  });

  it('allows a trusted content sender to read configuration state without mutating', async () => {
    const state: ChromeTestState = { values: {} };
    installChrome(state);
    const handleMessage = await loadHandler();

    const response = (await handleMessage(
      { type: 'configuration-state' },
      untrustedSender()
    )) as { providers: unknown[]; validation: unknown };

    expect(Array.isArray(response.providers)).toBe(true);
    expect(state.values[CONFIGURATION_STATE_STORAGE_KEY]).toBeUndefined();
  });

  it('accepts API keys through the authorized path but never returns raw secrets', async () => {
    const state: ChromeTestState = { values: {} };
    installChrome(state);
    const handleMessage = await loadHandler();

    const created = await handleMessage(
      {
        type: 'credential-create',
        providerId: GEMINI_PROVIDER_ID,
        label: 'Primary',
        secret: 'raw-secret',
      },
      popupSender()
    );
    expect(JSON.stringify(created)).not.toContain('raw-secret');
    const credentialId = (created as { credentialId: string }).credentialId;

    const replaced = await handleMessage(
      {
        type: 'credential-replace',
        credentialId,
        providerId: GEMINI_PROVIDER_ID,
        label: 'Replacement',
        secret: 'replacement-secret',
      },
      popupSender()
    );
    expect(JSON.stringify(replaced)).not.toContain('replacement-secret');
    expect((replaced as { credentialId: string }).credentialId).not.toBe(
      credentialId
    );

    const popupState = await handleMessage(
      { type: 'configuration-state' },
      popupSender()
    );
    expect(JSON.stringify(popupState)).not.toContain('raw-secret');
    expect(JSON.stringify(popupState)).not.toContain('replacement-secret');
    expect(
      (popupState as { credentials: Array<Record<string, unknown>> })
        .credentials
    ).toEqual([expect.objectContaining({ label: 'Replacement' })]);
    expect(JSON.stringify(await storedState(state))).toContain(
      'replacement-secret'
    );
  });

  it('accepts compiled registry combinations and rejects unsupported values', async () => {
    const state: ChromeTestState = { values: {} };
    installChrome(state);
    const handleMessage = await loadHandler();
    const created = (await handleMessage(
      {
        type: 'credential-create',
        providerId: GEMINI_PROVIDER_ID,
        label: 'Primary',
        secret: 'raw-secret',
      },
      popupSender()
    )) as { credentialId: string };

    const selected = await handleMessage(
      {
        type: 'configuration-set',
        providerId: GEMINI_PROVIDER_ID,
        modelId: GEMINI_MODEL,
        credentialId: created.credentialId,
        providerConfig: {
          providerId: 'attacker-provider',
          modelId: 'attacker-model',
          endpointHost: 'attacker.example',
        },
      },
      popupSender()
    );
    expect(selected).toMatchObject({
      activeConfiguration: {
        providerId: GEMINI_PROVIDER_ID,
        modelId: GEMINI_MODEL,
      },
      providers: [
        expect.objectContaining({
          providerId: GEMINI_PROVIDER_ID,
          models: [expect.objectContaining({ modelId: GEMINI_MODEL })],
        }),
      ],
    });

    await expect(
      handleMessage(
        {
          type: 'configuration-set',
          providerId: 'unsupported-provider',
          modelId: GEMINI_MODEL,
          credentialId: created.credentialId,
        },
        popupSender()
      )
    ).rejects.toThrow('Unsupported provider configuration');
    await expect(
      handleMessage(
        {
          type: 'configuration-set',
          providerId: GEMINI_PROVIDER_ID,
          modelId: 'unsupported-model',
          credentialId: created.credentialId,
        },
        popupSender()
      )
    ).rejects.toThrow('Unsupported provider configuration');
  });

  it('authorizes validation only for the trusted popup boundary', async () => {
    const state: ChromeTestState = { values: {} };
    installChrome(state);
    const handleMessage = await loadHandler();
    const created = (await handleMessage(
      {
        type: 'credential-create',
        providerId: GEMINI_PROVIDER_ID,
        label: 'Primary',
        secret: 'raw-secret',
      },
      popupSender()
    )) as { credentialId: string };
    await handleMessage(
      {
        type: 'configuration-set',
        providerId: GEMINI_PROVIDER_ID,
        modelId: GEMINI_MODEL,
        credentialId: created.credentialId,
      },
      popupSender()
    );

    await expect(
      handleMessage({ type: 'configuration-validate' }, untrustedSender())
    ).rejects.toThrow();
    await expect(
      handleMessage({ type: 'configuration-validate' }, popupSender())
    ).resolves.toEqual({ valid: true });
    expect(validationMock.validate).toHaveBeenCalledWith('raw-secret');
  });
});
