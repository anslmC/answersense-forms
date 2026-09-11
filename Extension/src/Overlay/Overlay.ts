import { EXTENSION_NAME, log } from '../Shared/Utils';
import { mountAnswerSenseApp } from '../Popup/WorkflowApp';
import overlayCss from './Overlay.css?inline';

const OVERLAY_HOST_ID = 'answersense-overlay-host';

export interface OverlayHandle {
  refresh: () => void;
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

  const title = document.createElement('h1');
  title.textContent = EXTENSION_NAME;

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'overlay-refresh';
  refresh.textContent = 'Refresh';
  refresh.setAttribute('aria-label', 'Refresh the current workflow state');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'overlay-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close the panel');

  const body = document.createElement('div');
  body.className = 'overlay-body';

  header.append(title, refresh, close);
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
          <button type="button" class="secondary" data-force-clear>
            Force Unsettle All
          </button>
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
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.left = 'auto';
  host.style.width = '360px';
  host.style.maxWidth = 'calc(100vw - 32px)';
  host.style.maxHeight = 'calc(100vh - 32px)';
  host.style.zIndex = '2147483647';
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
    if (event.target instanceof HTMLElement && event.target.closest('button.overlay-close')) {
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
    refresh.textContent = isRefreshing ? 'Refreshing…' : 'Refresh';
  };

  refresh.addEventListener('click', async () => {
    if (refreshing) {
      return;
    }

    refreshing = true;
    setRefreshState(true);

    try {
      await Promise.resolve(options.onRefresh?.());
    } catch (error) {
      console.error('AnswerSense refresh failed.', error);
    } finally {
      refreshing = false;
      setRefreshState(false);
    }
  });

  close.addEventListener('click', (event) => {
    event.stopPropagation();
    host.remove();
    void chrome.storage.local.set({ [OVERLAY_UI_STORAGE_KEY]: false });
    options.onClose?.();
  });

  header.addEventListener('pointerdown', onPointerDown);

  buildWorkflowAppScaffold(body);

  const handle = mountAnswerSenseApp({ root: body, surface: 'overlay' });

  return {
    refresh: () => void handle.refresh(),
    close: () => {
      host.remove();
      options.onClose?.();
    },
  };
}
