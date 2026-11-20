import type {
  PageSummary,
  UiGenerationResult,
  WorkflowSnapshot,
} from './State';
import { isGenerationProgress, isUiGenerationResult } from './State';
import type { GenerationIntent } from '../Generation/Intent';
import { isProviderSafeMessageCode } from '../Generation/Contract';
import { isRecognizedProviderId } from '../Generation/ProviderIdentity';
import {
  attachPerformanceToError,
  readPerformanceReport,
} from '../Shared/Performance';

export interface Workflow {
  discover(): Promise<PageSummary | WorkflowSnapshot | null>;
  generate(intent?: GenerationIntent): Promise<UiGenerationResult>;
  forceClear(): Promise<WorkflowSnapshot>;
}

interface DiscoveryResponse {
  status: 'unsupported-page' | 'no-active-page' | 'discovered';
  supported: boolean;
  page?: { pageId: string; questions: unknown[] };
}

interface SnapshotResponse extends WorkflowSnapshot {
  supported: boolean;
}

export function createBrowserWorkflow(): Workflow {
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
        const lifecycleForm = snapshot.lifecycle?.activePage?.form;
        const lifecycleQuestions =
          lifecycleForm &&
          (lifecycleForm.activePageId === undefined ||
            lifecycleForm.activePageId === snapshot.page?.pageId)
            ? lifecycleForm.questions
            : undefined;
        return {
          uiState: snapshot.uiState,
          page: snapshot.page
            ? {
                ...snapshot.page,
                questions: lifecycleQuestions ?? snapshot.page.questions,
              }
            : null,
          result: snapshot.result ?? null,
          error: snapshot.error ?? null,
          ...(isProviderSafeMessageCode(snapshot.safeMessageCode)
            ? { safeMessageCode: snapshot.safeMessageCode }
            : {}),
          ...(isRecognizedProviderId(snapshot.providerId)
            ? { providerId: snapshot.providerId }
            : {}),
          lifecycle: snapshot.lifecycle ?? null,
          ...(snapshot.performance
            ? { performance: snapshot.performance }
            : {}),
          ...(typeof snapshot.generationOperationId === 'string'
            ? { generationOperationId: snapshot.generationOperationId }
            : {}),
          ...(isGenerationProgress(snapshot.generationProgress)
            ? { generationProgress: snapshot.generationProgress }
            : {}),
        };
      }
      return {
        pageId: response.page.pageId,
        questionCount: response.page.questions.length,
      };
    },
    async generate(intent?: GenerationIntent): Promise<UiGenerationResult> {
      const response = await chrome.runtime.sendMessage({
        type: 'p7-generate',
        ...(intent ? { intent } : {}),
      });
      if (response?.error) {
        const error = attachPerformanceToError(
          new Error(response.error),
          readPerformanceReport(response)
        );
        Object.assign(error, {
          ...(isProviderSafeMessageCode(response.safeMessageCode)
            ? { safeMessageCode: response.safeMessageCode }
            : {}),
          ...(isRecognizedProviderId(response.providerId)
            ? { providerId: response.providerId }
            : {}),
        });
        throw error;
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
        lifecycle: snapshot,
      };
    },
  };
}
