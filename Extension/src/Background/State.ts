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
