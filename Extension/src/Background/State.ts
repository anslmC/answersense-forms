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

export class IntegrationStateStore {
  private readonly snapshots = new Map<number, IntegrationSnapshot>();

  get(tabId: number): IntegrationSnapshot | null {
    return this.snapshots.get(tabId) ?? null;
  }

  set(tabId: number, snapshot: IntegrationSnapshot): IntegrationSnapshot {
    this.snapshots.set(tabId, snapshot);
    return snapshot;
  }

  update(
    tabId: number,
    update: Partial<IntegrationSnapshot>
  ): IntegrationSnapshot {
    const current = this.get(tabId) ?? {
      lifecycle: null,
      uiState: 'UNSUPPORTED' as const,
      page: null,
      result: null,
      error: null,
    };
    return this.set(tabId, { ...current, ...update });
  }
}
