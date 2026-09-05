import type { FillReport } from '../Fill/Filler';
import type { GenerationReport } from '../Generation/Report';
import type { PageSummary, UiGenerationResult } from './State';

export interface PopupWorkflow {
  discover(): Promise<PageSummary | null>;
  generate(): Promise<UiGenerationResult>;
}

interface DiscoveryResponse {
  status: 'unsupported-page' | 'no-active-page' | 'discovered';
  supported: boolean;
  page?: { pageId: string; questions: unknown[] };
}

export function createBrowserPopupWorkflow(): PopupWorkflow {
  return {
    async discover(): Promise<PageSummary | null> {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) {
        return null;
      }
      let response: DiscoveryResponse;
      try {
        response = (await chrome.tabs.sendMessage(tabId, {
          type: 'discover-active-page',
        })) as DiscoveryResponse;
      } catch {
        return null;
      }
      if (!response.supported || !response.page) {
        return null;
      }
      return {
        pageId: response.page.pageId,
        questionCount: response.page.questions.length,
      };
    },
    async generate(): Promise<UiGenerationResult> {
      throw new Error('Generation workflow is not connected to the popup transport yet.');
    },
  };
}

export function createUiGenerationResult(
  report: GenerationReport,
  fillReport: FillReport,
): UiGenerationResult {
  return { report, fillReport };
}
