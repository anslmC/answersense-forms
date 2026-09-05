import type { FillReport } from '../Fill/Filler';
import type { GenerationReport } from '../Generation/Report';
import type { PageSummary, UiGenerationResult, WorkflowSnapshot } from './State';

export interface PopupWorkflow {
  discover(): Promise<PageSummary | WorkflowSnapshot | null>;
  generate(): Promise<UiGenerationResult>;
  reviewComplete?(): Promise<void>;
}

interface DiscoveryResponse {
  status: 'unsupported-page' | 'no-active-page' | 'discovered';
  supported: boolean;
  page?: { pageId: string; questions: unknown[] };
}

interface SnapshotResponse extends WorkflowSnapshot {
  supported: boolean;
}

export function createBrowserPopupWorkflow(): PopupWorkflow {
  return {
    async discover(): Promise<PageSummary | WorkflowSnapshot | null> {
      let response: DiscoveryResponse | SnapshotResponse;
      try {
        response = (await chrome.runtime.sendMessage({ type: 'p7-discover' })) as DiscoveryResponse;
      } catch {
        return null;
      }
      if (!response.supported || !response.page) {
        return null;
      }
      if ('uiState' in response) {
        const snapshot = response as unknown as SnapshotResponse;
        return {
          uiState: snapshot.uiState,
          page: snapshot.page,
          result: snapshot.result ?? null,
          error: snapshot.error ?? null,
        };
      }
      return {
        pageId: response.page.pageId,
        questionCount: response.page.questions.length,
      };
    },
    async generate(): Promise<UiGenerationResult> {
      const response = await chrome.runtime.sendMessage({ type: 'p7-generate' });
      if (response?.error) {
        throw new Error(response.error);
      }
      return response as UiGenerationResult;
    },
    async reviewComplete(): Promise<void> {
      await chrome.runtime.sendMessage({ type: 'p7-review-complete' });
    },
  };
}

export function createUiGenerationResult(
  report: GenerationReport,
  fillReport: FillReport,
): UiGenerationResult {
  return { report, fillReport };
}
