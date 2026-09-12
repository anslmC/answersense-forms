import type { FillReport } from '../Fill/Filler';
import type { GenerationReport } from '../Generation/Report';
import type {
  PageSummary,
  UiGenerationResult,
  WorkflowSnapshot,
} from './State';
import type { PopupQuestion } from './State';
import { isUiGenerationResult } from './State';

export interface PopupWorkflow {
  discover(): Promise<PageSummary | WorkflowSnapshot | null>;
  generate(retry?: boolean): Promise<UiGenerationResult>;
  forceClear(): Promise<WorkflowSnapshot>;
}

interface DiscoveryResponse {
  status: 'unsupported-page' | 'no-active-page' | 'discovered';
  supported: boolean;
  page?: { pageId: string; questions: unknown[] };
}

interface SnapshotResponse extends WorkflowSnapshot {
  supported: boolean;
  lifecycle?: {
    activePage?: { form?: { questions?: PopupQuestion[] } };
  };
}

export function createBrowserPopupWorkflow(): PopupWorkflow {
  return {
    async discover(): Promise<PageSummary | WorkflowSnapshot | null> {
      let response: DiscoveryResponse | SnapshotResponse;
      try {
        response = (await chrome.runtime.sendMessage({
          type: 'p7-discover',
        })) as DiscoveryResponse;
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
          page: snapshot.page
            ? {
                ...snapshot.page,
                questions: snapshot.lifecycle?.activePage?.form?.questions,
              }
            : null,
          result: snapshot.result ?? null,
          error: snapshot.error ?? null,
        };
      }
      return {
        pageId: response.page.pageId,
        questionCount: response.page.questions.length,
      };
    },
    async generate(retry = false): Promise<UiGenerationResult> {
      const response = await chrome.runtime.sendMessage({
        type: 'p7-generate',
        retry,
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      if (!isUiGenerationResult(response)) {
        throw new Error('Generation returned an invalid result.');
      }
      return response as UiGenerationResult;
    },
    async forceClear(): Promise<WorkflowSnapshot> {
      const response = await chrome.runtime.sendMessage({
        type: 'p7-force-clear',
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      const snapshot = response?.snapshot;
      if (!snapshot) {
        throw new Error('Force Clear did not return lifecycle state.');
      }
      return {
        uiState: 'READY',
        page: {
          pageId: snapshot.activePage.form.activePageId,
          questionCount: snapshot.activePage.form.questions.length,
        },
        result: null,
        error: null,
      };
    },
  };
}

export function createUiGenerationResult(
  report: GenerationReport,
  fillReport: FillReport
): UiGenerationResult {
  return { report, fillReport };
}
