import type { GenerationReport } from '../Generation/Report';
import type { FillReport } from '../Fill/Filler';

export type UiStateName =
  | 'UNSUPPORTED'
  | 'READY'
  | 'GENERATING'
  | 'REVIEW'
  | 'ERROR';

export interface PageSummary {
  pageId: string;
  questionCount: number;
}

export interface GeneratedUiResult {
  report: GenerationReport;
  fillReport: FillReport;
}

export interface ReusedUiResult {
  status: 'reused';
  pageId: string;
}

export type UiGenerationResult = GeneratedUiResult | ReusedUiResult;

export interface WorkflowSnapshot {
  uiState: UiStateName;
  page: PageSummary | null;
  result: UiGenerationResult | null;
  error: string | null;
}

export type UiState =
  | { name: 'UNSUPPORTED'; message: string }
  | { name: 'READY'; page: PageSummary }
  | { name: 'GENERATING'; page: PageSummary }
  | { name: 'REVIEW'; page: PageSummary; result: UiGenerationResult }
  | { name: 'ERROR'; page: PageSummary | null; message: string };

export function unsupportedState(
  message = "This page isn't supported."
): UiState {
  return { name: 'UNSUPPORTED', message };
}

export function readyState(page: PageSummary): UiState {
  return { name: 'READY', page };
}

export class PopupStateMachine {
  private current: UiState = unsupportedState();
  private operationToken = 0;

  get state(): UiState {
    return this.current;
  }

  setPage(page: PageSummary | null): UiState {
    this.operationToken += 1;
    this.current = page ? readyState(page) : unsupportedState();
    return this.current;
  }

  restore(snapshot: WorkflowSnapshot): UiState {
    this.operationToken += 1;
    const normalizedUiState =
      (snapshot.uiState as string) === 'READY_FOR_NEXT'
        ? 'READY'
        : snapshot.uiState;

    if (normalizedUiState === 'UNSUPPORTED' || !snapshot.page) {
      this.current = unsupportedState();
    } else if (normalizedUiState === 'GENERATING') {
      this.current = { name: 'GENERATING', page: snapshot.page };
    } else if (normalizedUiState === 'ERROR') {
      this.current = {
        name: 'ERROR',
        page: snapshot.page,
        message: snapshot.error ?? 'Generation failed.',
      };
    } else if (normalizedUiState === 'REVIEW' && snapshot.result) {
      this.current = {
        name: 'REVIEW',
        page: snapshot.page,
        result: snapshot.result,
      };
    } else {
      this.current = readyState(snapshot.page);
    }
    return this.current;
  }

  beginGeneration(): UiState {
    if (
      this.current.name !== 'READY' &&
      this.current.name !== 'REVIEW' &&
      this.current.name !== 'ERROR'
    ) {
      return this.current;
    }
    const page =
      this.current.name === 'ERROR' ? this.current.page : this.current.page;
    if (!page) {
      return this.current;
    }
    this.operationToken += 1;
    this.current = { name: 'GENERATING', page };
    return this.current;
  }

  get activeOperationToken(): number {
    return this.operationToken;
  }

  completeGeneration(token: number, result: UiGenerationResult): UiState {
    if (token !== this.operationToken || this.current.name !== 'GENERATING') {
      return this.current;
    }
    this.current = {
      name: 'REVIEW',
      page: this.current.page,
      result,
    };
    return this.current;
  }

  failGeneration(token: number, message: string): UiState {
    if (token !== this.operationToken || this.current.name !== 'GENERATING') {
      return this.current;
    }
    this.current = {
      name: 'ERROR',
      page: this.current.page,
      message,
    };
    return this.current;
  }

  confirmedPage(page: PageSummary | null): UiState {
    return this.setPage(page);
  }

  rejectedNext(): UiState {
    return this.current;
  }
}
