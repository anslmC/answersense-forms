import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('renders the GitHub link beside the existing header controls', async () => {
    await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const header = shadowRoot?.querySelector('.overlay-header');
    const github = shadowRoot?.querySelector<HTMLAnchorElement>('.overlay-github');

    expect(github).not.toBeNull();
    expect(github?.getAttribute('aria-label')).toBe('GitHub');
    expect(github?.getAttribute('title')).toBe('GitHub');
    expect(github?.getAttribute('href')).toBe('https://example.com');
    expect(github?.target).toBe('_blank');
    const githubIcon = github?.querySelector('svg');
    expect(githubIcon).not.toBeNull();
    const githubPointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    githubIcon?.dispatchEvent(githubPointerDown);
    expect(githubPointerDown.defaultPrevented).toBe(false);
    expect(header?.children[1]).toBe(github);
    expect(header?.children[2]).toBe(header?.querySelector('.overlay-refresh'));
    expect(header?.children[3]).toBe(header?.querySelector('.overlay-close'));
  });

  it('uses independent equal-sized SVG controls for Refresh and Close', async () => {
    await mountOverlay();
    const shadowRoot = document.querySelector('#answersense-overlay-host')?.shadowRoot;
    const refresh = shadowRoot?.querySelector<HTMLButtonElement>('.overlay-refresh');
    const close = shadowRoot?.querySelector<HTMLButtonElement>('.overlay-close');
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/Overlay/Overlay.css'), 'utf8');

    expect(refresh?.tagName).toBe('BUTTON');
    expect(close?.tagName).toBe('BUTTON');
    expect(refresh?.querySelector('svg')).not.toBeNull();
    expect(close?.querySelector('svg')).not.toBeNull();
    expect(refresh?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(refresh?.querySelector('path')?.getAttribute('stroke')).toBe('#D1D5DB');
    expect(refresh?.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(refresh?.querySelector('svg')?.getAttribute('height')).toBe('16');
    expect(close?.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(close?.querySelector('svg')?.getAttribute('height')).toBe('16');
    expect(close?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(close?.querySelector('path')?.getAttribute('fill')).toBe('#D1D5DB');
    expect(refresh?.getAttribute('aria-label')).toBe('Refresh');
    expect(close?.getAttribute('aria-label')).toBe('Close the panel');
    expect(close?.title).toBe('Close');
    expect(stylesheet).toContain('background: #374151;');
    expect(stylesheet).toContain('background: #4b5563;');
    expect(stylesheet).not.toMatch(/\.overlay-github\s*\{[^}]*background:/s);
    close?.click();
    expect(document.querySelector('#answersense-overlay-host')).toBeNull();
  });

  it('uses the refresh icon and completes without an artificial wait', async () => {
    const onRefresh = vi.fn(async () => {
      await workflowRefresh();
    });
    await mountOverlay({ onRefresh });
    const host = document.querySelector('#answersense-overlay-host');
    const refresh = host?.shadowRoot?.querySelector<HTMLButtonElement>(
      '.overlay-refresh'
    );
    expect(refresh).not.toBeNull();
    expect(refresh?.querySelector('svg')).not.toBeNull();
    expect(refresh?.getAttribute('aria-label')).toBe('Refresh');
    expect(refresh?.title).toBe('Refresh');

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
    expect(refresh?.querySelector('svg')).not.toBeNull();
    expect(refresh?.disabled).toBe(false);
    expect(workflowRefresh).toHaveBeenCalledOnce();
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
    expect(refresh?.querySelector('svg')).not.toBeNull();
    expect(refresh?.disabled).toBe(false);
    expect(host?.shadowRoot?.querySelector('[data-status]')?.textContent).toBe(
      'Refresh failed.'
    );
  });
});