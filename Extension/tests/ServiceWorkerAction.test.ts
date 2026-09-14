import { beforeEach, describe, expect, it, vi } from 'vitest';

type AlertInjection = {
  func: (message: string) => void;
  args?: [string];
};

type ActionListener = (tab: { id?: number; url?: string }) => void;

let actionListener: ActionListener | undefined;

function installChrome(): {
  executeScript: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const executeScript = vi.fn(async (injection: AlertInjection) => {
    injection.func(...(injection.args ?? ['']));
    return [];
  });
  const sendMessage = vi.fn(async () => undefined);
  const set = vi.fn(async () => undefined);
  actionListener = undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      sendMessage,
    },
    tabs: {
      query: vi.fn(async () => [{ id: 17 }]),
      sendMessage,
      onRemoved: { addListener: vi.fn() },
    },
    scripting: { executeScript },
    action: {
      onClicked: {
        addListener: (listener: ActionListener) => {
          actionListener = listener;
        },
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set,
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
  return { executeScript, sendMessage, set };
}

async function loadActionListener(): Promise<ActionListener> {
  await import('../src/Background/ServiceWorker');
  if (!actionListener) {
    throw new Error('The browser-action listener was not registered.');
  }
  return actionListener;
}

describe('browser-action entry point', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('alert', vi.fn());
  });

  it('alerts on an unsupported page without a content script or state write', async () => {
    const { executeScript, sendMessage, set } = installChrome();
    const listener = await loadActionListener();

    listener({ id: 17, url: 'https://freshbrewed.science/2023/06/29/btop.html' });
    await Promise.resolve();

    expect(window.alert).toHaveBeenCalledWith(
      'Page not supported\nPlease open a Google Form in respondent view to use AnswerSense.'
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps the existing content-script toggle path for supported Forms', async () => {
    const { executeScript, sendMessage } = installChrome();
    const listener = await loadActionListener();

    listener({
      id: 17,
      url: 'https://docs.google.com/forms/d/e/example/viewform',
    });
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(17, { type: 'toggle-overlay' });
    expect(executeScript).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });
});