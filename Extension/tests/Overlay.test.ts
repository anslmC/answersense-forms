import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOverlay } from '../src/Overlay/Overlay';

const workflowRefresh = vi.fn(async () => undefined);

vi.mock('../src/Popup/WorkflowApp', () => ({
  mountAnswerSenseApp: vi.fn(() => ({
    refresh: workflowRefresh,
  })),
}));

function setChromeMocks(): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
}

describe('overlay refresh operation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    workflowRefresh.mockClear();
    setChromeMocks();
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    document.documentElement.replaceChildren(document.head, document.body);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows Refreshing..., awaits the redraw, and holds the state for one second', async () => {
    const onRefresh = vi.fn(async () => {
      await workflowRefresh();
    });
    await mountOverlay({ onRefresh });
    const host = document.querySelector('#answersense-overlay-host');
    const refresh = host?.shadowRoot?.querySelector<HTMLButtonElement>(
      '.overlay-refresh'
    );
    expect(refresh).not.toBeNull();

    const pointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    refresh?.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(false);

    refresh?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(refresh?.textContent).toBe('Refreshing...');
    expect(refresh?.disabled).toBe(true);
    expect(workflowRefresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(refresh?.textContent).toBe('Refreshing...');

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh?.textContent).toBe('Refresh');
    expect(refresh?.disabled).toBe(false);
  });

  it('returns to Refresh and surfaces the failure after discovery fails', async () => {
    const onRefresh = vi.fn(async () => {
      throw new Error('Active page could not be discovered for refresh.');
    });
    await mountOverlay({ onRefresh });
    const host = document.querySelector('#answersense-overlay-host');
    const refresh = host?.shadowRoot?.querySelector<HTMLButtonElement>(
      '.overlay-refresh'
    );

    refresh?.click();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(refresh?.textContent).toBe('Refresh');
    expect(refresh?.disabled).toBe(false);
    expect(host?.shadowRoot?.querySelector('[data-status]')?.textContent).toBe(
      'Refresh failed.'
    );
  });
});