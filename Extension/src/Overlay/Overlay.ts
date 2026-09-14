import { EXTENSION_NAME, log } from '../Shared/Utils';
import { mountAnswerSenseApp } from '../Workflow/WorkflowApp';
import overlayCss from './Overlay.css?inline';

const OVERLAY_HOST_ID = 'answersense-overlay-host';

export interface OverlayHandle {
  refresh: () => Promise<void>;
  close: () => void;
}

export interface OverlayOptions {
  onClose?: () => void;
  onRefresh?: () => void | Promise<void>;
}

const OVERLAY_UI_STORAGE_KEY = 'answersense-overlay-opened';

function createStylesheet(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = overlayCss;
  return style;
}

function buildShell(): {
  panel: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  shell: HTMLDivElement;
  refresh: HTMLButtonElement;
  close: HTMLButtonElement;
} {
  const shell = document.createElement('div');
  shell.className = 'overlay-shell';

  const panel = document.createElement('div');
  panel.className = 'overlay-panel';

  const header = document.createElement('div');
  header.className = 'overlay-header';
  header.setAttribute('role', 'banner');
  header.setAttribute('aria-label', 'Drag to move the panel');

  const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  logo.setAttribute('class', 'overlay-logo');
  logo.setAttribute('viewBox', '0 0 24 24');
  logo.setAttribute('aria-hidden', 'true');
  logo.setAttribute('focusable', 'false');
  logo.innerHTML = `
    <path class="cls-1" d="M16,13H8a3,3,0,0,1-3-3V6A3,3,0,0,1,8,3h8a3,3,0,0,1,3,3v4A3,3,0,0,1,16,13ZM8,5A1,1,0,0,0,7,6v4a1,1,0,0,0,1,1h8a1,1,0,0,0,1-1V6a1,1,0,0,0-1-1Z"></path>
    <path class="cls-1" d="M10,9a1.05,1.05,0,0,1-.71-.29A1,1,0,0,1,10.19,7a.6.6,0,0,1,.19.06.56.56,0,0,1,.17.09l.16.12A1,1,0,0,1,10,9Z"></path>
    <path class="cls-1" d="M14,9a1,1,0,0,1-.71-1.71,1,1,0,0,1,1.42,1.42,1,1,0,0,1-.16.12.56.56,0,0,1-.17.09.6.6,0,0,1-.19.06Z"></path>
    <path class="cls-1" d="M12,4a1,1,0,0,1-1-1V2a1,1,0,0,1,2,0V3A1,1,0,0,1,12,4Z"></path>
    <path class="cls-1" d="M9,22a1,1,0,0,1-1-1V18a1,1,0,0,1,2,0v3A1,1,0,0,1,9,22Z"></path>
    <path class="cls-1" d="M15,22a1,1,0,0,1-1-1V18a1,1,0,0,1,2,0v3A1,1,0,0,1,15,22Z"></path>
    <path class="cls-1" d="M15,19H9a1,1,0,0,1-1-1V12a1,1,0,0,1,1-1h6a1,1,0,0,1,1,1v6A1,1,0,0,1,15,19Zm-5-2h4V13H10Z"></path>
    <path class="cls-1 logo-arm logo-arm-left" d="M5,17a1,1,0,0,1-.89-.55,1,1,0,0,1,.44-1.34l4-2a1,1,0,1,1,.9,1.78l-4,2A.93.93,0,0,1,5,17Z"></path>
      <g class="logo-arm-mirror" transform="translate(24 0) scale(-1 1)">
        <path class="cls-1 logo-arm logo-arm-right" d="M5,17a1,1,0,0,1-.89-.55,1,1,0,0,1,.44-1.34l4-2a1,1,0,1,1,.9,1.78l-4,2A.93.93,0,0,1,5,17Z"></path>
      </g>`;

  const title = document.createElement('h1');
  title.textContent = EXTENSION_NAME;

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'overlay-refresh';
    refresh.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M20.453 12.8932C20.1752 15.5031 18.6964 17.9488 16.2494 19.3616C12.1839 21.7088 6.98539 20.3158 4.63818 16.2503L4.38818 15.8173M3.54613 11.1071C3.82393 8.49723 5.30272 6.05151 7.74971 4.63874C11.8152 2.29153 17.0137 3.68447 19.3609 7.74995L19.6109 8.18297M3.49316 18.0662L4.22521 15.3341L6.95727 16.0662M17.0424 7.93413L19.7744 8.66618L20.5065 5.93413" stroke="#D1D5DB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>`;
  refresh.title = 'Refresh';
  refresh.setAttribute('aria-label', 'Refresh');
  const github = document.createElement('a');
  github.className = 'overlay-github';
  github.href = 'https://example.com';
  github.target = '_blank';
  github.rel = 'noopener noreferrer';
  github.title = 'GitHub';
  github.setAttribute('aria-label', 'GitHub');
  github.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.69c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.85c.85 0 1.71.11 2.51.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.79c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>`;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'overlay-close';
  close.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M5.29289 5.29289C5.68342 4.90237 6.31658 4.90237 6.70711 5.29289L12 10.5858L17.2929 5.29289C17.6834 4.90237 18.3166 4.90237 18.7071 5.29289C19.0976 5.68342 19.0976 6.31658 18.7071 6.70711L13.4142 12L18.7071 17.2929C19.0976 17.6834 19.0976 18.3166 18.7071 18.7071C18.3166 19.0976 17.6834 19.0976 17.2929 18.7071L12 13.4142L6.70711 18.7071C6.31658 19.0976 5.68342 19.0976 5.29289 18.7071C4.90237 18.3166 5.29289 17.2929 5.29289 17.2929L10.5858 12L5.29289 6.70711C4.90237 6.31658 5.68342 5.29289 5.29289 5.29289Z" fill="#D1D5DB"/>
    </svg>`;
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close the panel');

  const body = document.createElement('div');
  body.className = 'overlay-body';

  header.append(logo, title, github, refresh, close);
  panel.append(header, body);
  shell.append(panel);
  return { panel, header, body, shell, refresh, close };
}

function applyDragPosition(host: HTMLElement, x: number, y: number): void {
  host.style.left = `${x}px`;
  host.style.top = `${y}px`;
  host.style.right = 'auto';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function buildWorkflowAppScaffold(body: HTMLElement): void {
  body.innerHTML = `
    <main class="popup-shell" data-app-root>
      <header class="status-row"></header>
      <section class="status-panel" aria-live="polite">
        <p class="status" data-status>Checking this page...</p>
        <p class="detail" data-detail></p>
      </section>
      <section class="configuration-section" aria-labelledby="configuration-section-heading">
        <button
          type="button"
          class="configuration-toggle"
          data-configuration-toggle
          aria-expanded="false"
          aria-controls="configuration-content"
          aria-label="Expand Configuration"
        >
          <span id="configuration-section-heading">Configuration</span>
          <span aria-hidden="true" data-configuration-toggle-icon>►</span>
        </button>
        <p class="configuration-guidance" data-configuration-guidance>
          Configure the extension before generating.
        </p>
        <div id="configuration-content" class="configuration-content" data-configuration-content hidden>
      <section class="credential-panel" aria-labelledby="credential-heading">
        <h2 id="credential-heading">API Keys</h2>
        <div class="actions">
          <button type="button" data-add-credential>Add API key</button>
          <button type="button" class="secondary" data-replace-credential>
            Replace API key
          </button>
        </div>

        <div class="credential-form" data-add-credential-form hidden>
          <label for="credential-label">Key Name</label>
          <input
            id="credential-label"
            type="text"
            autocomplete="off"
            data-credential-label
          />
          <label for="credential-secret">API key</label>
          <input
            id="credential-secret"
            type="password"
            autocomplete="new-password"
            data-credential-secret
          />
          <div class="actions">
            <button type="button" data-save-add-credential>Save</button>
            <button type="button" class="secondary" data-cancel-add-credential>
              Cancel
            </button>
          </div>
        </div>

        <div class="credential-form" data-replace-credential-form hidden>
          <label for="replace-credential-select">Key to replace</label>
          <select
            id="replace-credential-select"
            data-replace-credential-select
          ></select>
          <label for="replace-credential-secret">New API Key</label>
          <input
            id="replace-credential-secret"
            type="password"
            autocomplete="new-password"
            data-replace-credential-secret
          />
          <div class="actions">
            <button type="button" data-save-replace-credential>Replace</button>
            <button type="button" class="secondary" data-cancel-replace-credential>
              Cancel
            </button>
          </div>
        </div>

        <p class="message" data-credential-message hidden></p>
      </section>
      <section
        class="configuration-panel"
        aria-labelledby="configuration-heading"
      >
        <h2 id="configuration-heading">Configuration</h2>
        <label for="provider-select">Provider</label>
        <select id="provider-select" data-provider-select></select>
        <label for="model-select">Model</label>
        <select id="model-select" data-model-select></select>
        <label for="credential-select">API Key</label>
        <select id="credential-select" data-credential-select>
          <option value="">No API keys added yet</option>
        </select>
        <div class="actions">
          <button type="button" data-save-configuration>
            Save configuration
          </button>
          <button type="button" class="secondary" data-delete-credential>
            Delete All keys
          </button>
        </div>
        <p class="detail" data-credential-status>Loading configuration...</p>
      </section>
      <section class="validation-panel" aria-labelledby="validation-heading">
        <h2 id="validation-heading">Key Validation</h2>
        <p class="status" data-validation-status></p>
        <p class="detail" data-unsaved-configuration hidden>
          Save the configuration before validating
        </p>
        <button type="button" data-validate-configuration>
          Validate configuration
        </button>
        <p class="message" data-validation-message hidden></p>
      </section>
        </div>
      </section>
      <section class="generation-panel" aria-labelledby="generation-heading">
        <h2 id="generation-heading">Generate &amp; Auto-Fill</h2>
        <section class="workflow-progress" data-workflow-progress hidden>
          <div class="workflow-progress-track">
            <div
              class="workflow-progress-bar"
              data-workflow-progress-bar
              role="progressbar"
              aria-label="Generate and Auto-Fill progress"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="workflow-progress-fill" data-workflow-progress-fill></div>
            </div>
          </div>
          <p class="workflow-progress-text" data-workflow-progress-text></p>
        </section>
        <section class="results" data-results hidden></section>
        <p class="message" data-message hidden></p>
        <div class="actions">
          <button type="button" data-primary-action hidden>
            Generate &amp; Auto-Fill
          </button>
          <span data-filled-status hidden></span>
          <button type="button" class="secondary" data-override-action hidden>
            Override Filled Answer(s)
          </button>
          <button type="button" class="secondary" data-force-clear hidden>
            Force Unsettle This Page
          </button>
          <p class="result-note all-filled-note force-clear-note" data-force-clear-note hidden>
            Force unsettling this page re-enables generation for this page. Once unsettled, you can generate answers again.
          </p>
        </div>
        <div class="override-flow" data-override-flow hidden>
          <div class="actions">
            <button type="button" data-override-all>All filled answers</button>
            <button type="button" class="secondary" data-override-uncheck>
              Uncheck All
            </button>
          </div>
          <div class="override-list" data-override-specific-list hidden></div>
          <div class="override-confirmation" data-override-confirmation hidden>
            <p data-override-confirmation-text></p>
            <p class="detail">
              These answers will be regenerated and may be replaced if generation succeeds.
            </p>
            <div class="actions">
              <button type="button" class="secondary" data-override-cancel>
                Cancel
              </button>
              <button type="button" data-override-confirm>Override</button>
            </div>
          </div>
          <p class="message" data-override-message hidden></p>
        </div>
      </section>
    </main>
  `;
}

async function readStoredOverlayPosition(): Promise<
  { left: number; top: number } | null
> {
  const items = await chrome.storage.local.get('answersense-overlay-position');
  const stored = items['answersense-overlay-position'] as
    | { left?: number; top?: number }
    | undefined;

  if (
    !stored ||
    !Number.isFinite(stored.left ?? Number.NaN) ||
    !Number.isFinite(stored.top ?? Number.NaN)
  ) {
    return null;
  }

  return { left: stored.left ?? 16, top: stored.top ?? 16 };
}

export async function mountOverlay(
  options: OverlayOptions = {}
): Promise<OverlayHandle> {
  log(`${EXTENSION_NAME} overlay initializing.`);

  const storedPosition = await readStoredOverlayPosition();

  const host = document.createElement('div');
  host.id = OVERLAY_HOST_ID;
  host.style.position = 'fixed';
  if (storedPosition) {
    applyDragPosition(host, storedPosition.left, storedPosition.top);
  } else {
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.left = 'auto';
  }
  host.style.width = '360px';
  host.style.maxWidth = 'calc(100vw - 32px)';
  host.style.maxHeight = 'calc(100vh - 32px)';
  host.style.zIndex = '2147483647';
  host.style.visibility = 'hidden';
  (document.documentElement ?? document.body ?? document).append(host);
  const root = host.attachShadow({ mode: 'open' });

  root.append(createStylesheet());
  const { header, body, shell, refresh, close } = buildShell();
  root.append(shell);

  if (storedPosition) {
    const hostWidth = host.getBoundingClientRect().width || 360;
    const hostHeight = host.getBoundingClientRect().height || 420;
    const safeLeft = clamp(
      storedPosition.left,
      8,
      Math.max(8, window.innerWidth - hostWidth - 8)
    );
    const safeTop = clamp(
      storedPosition.top,
      8,
      Math.max(8, window.innerHeight - hostHeight - 8)
    );
    applyDragPosition(host, safeLeft, safeTop);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest('button.overlay-close, button.overlay-refresh, a.overlay-github')
    ) {
      return;
    }
    const headerRect = header.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const offsetX = event.clientX - headerRect.left;
    const offsetY = event.clientY - headerRect.top;
    const hostWidth = hostRect.width;
    const hostHeight = hostRect.height;
    let dragging = false;

    event.preventDefault();
    header.setPointerCapture?.(event.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      dragging = true;
      const nextX = clamp(
        moveEvent.clientX - offsetX,
        8,
        window.innerWidth - hostWidth - 8
      );
      const nextY = clamp(
        moveEvent.clientY - offsetY,
        8,
        window.innerHeight - hostHeight - 8
      );
      applyDragPosition(host, nextX, nextY);
    };

    const onPointerUp = () => {
      if (dragging) {
        event.preventDefault();
      }
      const rect = host.getBoundingClientRect();
      void chrome.storage.local.set({
        'answersense-overlay-position': { left: rect.left, top: rect.top },
      });
      header.releasePointerCapture?.(event.pointerId);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', onPointerUp);
      header.removeEventListener('pointercancel', onPointerUp);
    };

    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);
  };

  let refreshing = false;

  const setRefreshState = (isRefreshing: boolean): void => {
    refresh.disabled = isRefreshing;
    refresh.classList.toggle('is-refreshing', isRefreshing);
    refresh.setAttribute('aria-busy', String(isRefreshing));
  };

  const runRefresh = async (): Promise<void> => {
    if (refreshing) {
      return;
    }

    refreshing = true;
    setRefreshState(true);

    let refreshError: unknown;
    try {
      await Promise.resolve(options.onRefresh?.());
    } catch (error) {
      refreshError = error;
      console.error('AnswerSense refresh failed.', error);
    }
    if (refreshError !== undefined) {
      const status = body.querySelector<HTMLElement>('[data-status]');
      const detail = body.querySelector<HTMLElement>('[data-detail]');
      if (status) {
        status.textContent = 'Refresh failed.';
      }
      if (detail) {
        detail.textContent =
          refreshError instanceof Error
            ? refreshError.message
            : 'Could not refresh this page.';
      }
    }
    refreshing = false;
    setRefreshState(false);
  };

  refresh.addEventListener('click', () => {
    void runRefresh();
  });

  close.addEventListener('click', (event) => {
    event.stopPropagation();
    host.remove();
    void chrome.storage.local.set({ [OVERLAY_UI_STORAGE_KEY]: false });
    options.onClose?.();
  });

  header.addEventListener('pointerdown', onPointerDown);

  buildWorkflowAppScaffold(body);

  const configurationToggle = body.querySelector<HTMLButtonElement>(
    '[data-configuration-toggle]'
  );
  const configurationContent = body.querySelector<HTMLElement>(
    '[data-configuration-content]'
  );
  const configurationToggleIcon = body.querySelector<HTMLElement>(
    '[data-configuration-toggle-icon]'
  );
  configurationToggle?.addEventListener('click', () => {
    if (!configurationContent) return;
    const expanded = configurationContent.hidden;
    configurationContent.hidden = !expanded;
    configurationToggle.setAttribute('aria-expanded', String(expanded));
    configurationToggle.setAttribute(
      'aria-label',
      `${expanded ? 'Collapse' : 'Expand'} Configuration`
    );
    if (configurationToggleIcon) {
      configurationToggleIcon.textContent = expanded ? '▼' : '►';
    }
  });

  const handle = mountAnswerSenseApp({
    root: body,
    onRefresh: runRefresh,
    surface: 'overlay',
  });
  try {
    await handle.ready;
    host.style.visibility = 'visible';
  } catch (error) {
    host.remove();
    throw error;
  }

  return {
    refresh: () => handle.refresh(),
    close: () => {
      host.remove();
      options.onClose?.();
    },
  };
}
