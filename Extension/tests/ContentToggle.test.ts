import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  supported: false,
  listener: null as ((request: { type: string }, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | null,
}));

const mountOverlay = vi.hoisted(() => vi.fn(async () => ({
  refresh: vi.fn(async () => undefined),
  close: vi.fn(),
})));

vi.mock('../src/Forms/Detection', () => ({
  isSupportedGoogleFormsPage: () => testState.supported,
}));

vi.mock('../src/Overlay/Overlay', () => ({ mountOverlay }));

vi.mock('../src/Content/Navigation', () => ({
  pageNavigationMutationOptions: { childList: true },
  processObservedNavigation: vi.fn(),
  shouldGeneratePage: vi.fn(() => true),
  waitForInitialDiscovery: vi.fn(async () => null),
}));

function installChrome(): { set: ReturnType<typeof vi.fn> } {
  const set = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: (listener: typeof testState.listener) => {
          testState.listener = listener;
        },
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set,
      },
    },
  });
  return { set };
}

async function loadContent(): Promise<void> {
  await import('../src/Content/Content');
  await Promise.resolve();
}

function dispatchToggle(): Promise<unknown> {
  return new Promise((resolve) => {
    testState.listener?.({ type: 'toggle-overlay' }, {}, resolve);
  });
}

describe('browser-action overlay toggle', () => {
  beforeEach(() => {
    vi.resetModules();
    testState.supported = false;
    testState.listener = null;
    mountOverlay.mockClear();
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('alerts and stops on an unsupported page', async () => {
    const { set } = installChrome();
    await loadContent();

    await expect(dispatchToggle()).resolves.toEqual({
      status: 'unsupported-page',
      supported: false,
    });

    expect(window.alert).toHaveBeenCalledWith(
      'Page not supported\nPlease open a Google Form in respondent view to use AnswerSense.'
    );
    expect(mountOverlay).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(document.querySelector('#answersense-overlay-host')).toBeNull();
  });

  it('keeps opening the overlay on a supported page', async () => {
    testState.supported = true;
    const { set } = installChrome();
    await loadContent();

    await expect(dispatchToggle()).resolves.toEqual({
      status: 'opened',
      supported: true,
    });

    expect(window.alert).not.toHaveBeenCalled();
    expect(mountOverlay).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ 'answersense-overlay-opened': true });
  });
});