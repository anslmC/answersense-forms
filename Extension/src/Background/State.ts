import type { LifecycleSnapshot } from '../Lifecycle/PageLifecycle';
import type {
  PageSummary,
  UiGenerationResult,
  UiStateName,
} from '../Popup/State';

export interface IntegrationSnapshot {
  lifecycle: LifecycleSnapshot | null;
  uiState: UiStateName;
  page: PageSummary | null;
  result: UiGenerationResult | null;
  error: string | null;
}

export interface CurrentContentState {
  lifecycle: LifecycleSnapshot | null;
  page: PageSummary | null;
}

export const INTEGRATION_STATE_STORAGE_KEY = 'answerSenseIntegrationState';

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

const UI_STATE_NAMES: readonly UiStateName[] = [
  'UNSUPPORTED',
  'READY',
  'GENERATING',
  'REVIEW',
  'READY_FOR_NEXT',
  'ERROR',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLifecycleSnapshot(value: unknown): value is LifecycleSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const activePage = value.activePage;
  const activeCycle = value.activeCycle;
  const pending = value.pending;
  const settledPages = value.settledPages;
  const visits = value.visits;
  const navigation = value.navigation;
  if (
    !isRecord(activePage) ||
    !isRecord(activePage.form) ||
    !isRecord(activePage.processingCycle) ||
    typeof activePage.form.activePageId !== 'string' ||
    (activePage.form.formId !== null &&
      typeof activePage.form.formId !== 'string') ||
    !Array.isArray(activePage.form.questions) ||
    !isRecord(activeCycle) ||
    typeof activeCycle.cycleId !== 'string' ||
    !Array.isArray(settledPages) ||
    !Array.isArray(visits) ||
    (pending !== null && !isRecord(pending)) ||
    (navigation !== null && !isRecord(navigation))
  ) {
    return false;
  }
  return (
    typeof activePage.processingCycle.cycleId === 'string' &&
    visits.every(
      (visit) =>
        isRecord(visit) &&
        typeof visit.pageId === 'string' &&
        typeof visit.cycleId === 'string' &&
        (visit.status === 'active' ||
          visit.status === 'settled' ||
          visit.status === 'abandoned')
    )
  );
}

function isIntegrationSnapshot(value: unknown): value is IntegrationSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const page = value.page;
  return (
    (value.lifecycle === null || isLifecycleSnapshot(value.lifecycle)) &&
    typeof value.uiState === 'string' &&
    UI_STATE_NAMES.includes(value.uiState as UiStateName) &&
    (page === null ||
      (isRecord(page) &&
        typeof page.pageId === 'string' &&
        typeof page.questionCount === 'number' &&
        Number.isSafeInteger(page.questionCount) &&
        page.questionCount >= 0)) &&
    (value.result === null || isRecord(value.result)) &&
    (value.error === null || typeof value.error === 'string')
  );
}

function sameSerializedContentState(
  current: IntegrationSnapshot,
  content: CurrentContentState
): boolean {
  return (
    JSON.stringify(current.lifecycle) === JSON.stringify(content.lifecycle) &&
    JSON.stringify(current.page) === JSON.stringify(content.page)
  );
}

export function reconcileContentState(
  current: IntegrationSnapshot | null,
  content: CurrentContentState
): IntegrationSnapshot {
  if (!content.lifecycle || !content.page) {
    return (
      current ?? {
        lifecycle: null,
        uiState: 'UNSUPPORTED',
        page: null,
        result: null,
        error: null,
      }
    );
  }

  const isCurrent =
    current?.lifecycle !== null &&
    current?.lifecycle !== undefined &&
    sameSerializedContentState(current, content);
  if (isCurrent && current) {
    return current;
  }
  return {
    lifecycle: content.lifecycle,
    uiState: isCurrent ? current.uiState : 'READY',
    page: content.page,
    result: isCurrent ? current.result : null,
    error: isCurrent ? current.error : null,
  };
}

export class IntegrationStateStore {
  private readonly snapshots = new Map<number, IntegrationSnapshot>();
  private readonly ready: Promise<void>;
  private writeQueue = Promise.resolve();

  constructor(private readonly storage?: SessionStorageArea) {
    this.ready = this.hydrate();
  }

  private async hydrate(): Promise<void> {
    if (!this.storage) {
      return;
    }
    try {
      const stored = await this.storage.get(INTEGRATION_STATE_STORAGE_KEY);
      const entries = stored[INTEGRATION_STATE_STORAGE_KEY];
      if (!isRecord(entries)) {
        return;
      }
      for (const [tabId, snapshot] of Object.entries(entries)) {
        const numericTabId = Number(tabId);
        if (
          Number.isSafeInteger(numericTabId) &&
          numericTabId >= 0 &&
          isIntegrationSnapshot(snapshot)
        ) {
          this.snapshots.set(numericTabId, snapshot);
        }
      }
    } catch (error) {
      console.error('AnswerSense session state hydration failed.', error);
    }
  }

  private persist(): Promise<void> {
    if (!this.storage) {
      return Promise.resolve();
    }
    const persistence = this.writeQueue
      .then(async () => {
        await this.storage!.set({
          [INTEGRATION_STATE_STORAGE_KEY]: Object.fromEntries(
            this.snapshots.entries()
          ),
        });
      });
    this.writeQueue = persistence.catch((error: unknown) => {
      console.error('AnswerSense session state persistence failed.', error);
    });
    return persistence;
  }

  async get(tabId: number): Promise<IntegrationSnapshot | null> {
    await this.ready;
    return this.snapshots.get(tabId) ?? null;
  }

  async set(
    tabId: number,
    snapshot: IntegrationSnapshot
  ): Promise<IntegrationSnapshot> {
    await this.ready;
    this.snapshots.set(tabId, snapshot);
    await this.persist();
    return snapshot;
  }

  async update(
    tabId: number,
    update: Partial<IntegrationSnapshot>
  ): Promise<IntegrationSnapshot> {
    await this.ready;
    const current = this.snapshots.get(tabId) ?? {
      lifecycle: null,
      uiState: 'UNSUPPORTED' as const,
      page: null,
      result: null,
      error: null,
    };
    return this.set(tabId, { ...current, ...update });
  }

  async remove(tabId: number): Promise<void> {
    await this.ready;
    this.snapshots.delete(tabId);
    await this.persist();
  }
}
