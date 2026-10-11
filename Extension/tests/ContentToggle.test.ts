import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  supported: false,
  respondent: true,
  listener: null as ((request: { type: string }, sender: unknown, sendResponse: (response: unknown) => void) => boolean) | null,
}));

const mountOverlay = vi.hoisted(() => vi.fn(async (options?: {
  onClose?: () => void;
}) => ({
  refresh: vi.fn(async () => undefined),
  close: vi.fn(() => options?.onClose?.()),
})));

vi.mock('../src/Forms/Detection', () => ({
  isSupportedGoogleFormsPage: () => testState.supported,
  isGoogleFormsRespondentPage: () => testState.respondent,
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
    testState.respondent = true;
    testState.listener = null;
    mountOverlay.mockClear();
    document.getElementById('answersense-launcher-host')?.remove();
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
      "This page isn't supported.\nOpen a Google Forms respondent page to use AnswerSense."
    );
    expect(mountOverlay).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(document.querySelector('#answersense-overlay-host')).toBeNull();
    expect(document.querySelector('#answersense-launcher-host')).toBeNull();
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
    expect(
      document.querySelector('#answersense-launcher-host')?.classList.contains('is-open')
    ).toBe(true);
  });

  it('does not show the launcher on a supported form editor page', async () => {
    testState.supported = true;
    testState.respondent = false;
    installChrome();
    await loadContent();

    expect(document.querySelector('#answersense-launcher-host')).toBeNull();
    await expect(dispatchToggle()).resolves.toMatchObject({
      status: 'opened',
      supported: true,
    });
    expect(mountOverlay).toHaveBeenCalledTimes(1);
  });

  it('opens the existing overlay from the floating launcher and restores it on close', async () => {
    testState.supported = true;
    const { set } = installChrome();
    await loadContent();

    const host = document.querySelector<HTMLDivElement>(
      '#answersense-launcher-host'
    );
    const button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-label')).toBe('Open AnswerSense');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.querySelector('.tooltip')?.textContent).toBe('Open AnswerSense');
    expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain(
      '@media (prefers-reduced-motion: reduce)'
    );
    expect(host?.style.right).toBe('24px');
    expect(host?.style.top).toBe('24px');
    expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain(
      'background: #000;'
    );
    expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain(
      'justify-content: center;'
    );

    button?.click();
    await vi.waitFor(() => expect(mountOverlay).toHaveBeenCalledTimes(1));
    expect(host?.classList.contains('is-open')).toBe(true);
    await vi.waitFor(() =>
      expect(set).toHaveBeenCalledWith({ 'answersense-overlay-opened': true })
    );

    mountOverlay.mock.calls[0]?.[0]?.onClose?.();
    expect(host?.classList.contains('is-open')).toBe(false);
    expect(host?.getAttribute('aria-hidden')).toBe('false');
  });

  it('shares one in-flight mount across concurrent open requests', async () => {
    testState.supported = true;
    const { set } = installChrome();
    let releaseMount!: (handle: Awaited<ReturnType<typeof mountOverlay>>) => void;
    mountOverlay.mockImplementationOnce(
      () => new Promise((resolve) => (releaseMount = resolve))
    );
    await loadContent();

    const firstOpen = dispatchToggle();
    const secondOpen = dispatchToggle();
    await Promise.resolve();

    expect(mountOverlay).toHaveBeenCalledTimes(1);
    releaseMount({
      refresh: vi.fn(async () => undefined),
      close: vi.fn(),
    });

    await expect(Promise.all([firstOpen, secondOpen])).resolves.toEqual([
      { status: 'opened', supported: true },
      { status: 'opened', supported: true },
    ]);
    expect(set).toHaveBeenCalledTimes(2);
  });
});