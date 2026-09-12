import type { GenerationReport } from '../Generation/Report';
import type { FillReport } from '../Fill/Filler';
import { createOverrideFilledIntent, type GenerationIntent } from '../Generation/Intent';

export type UiStateName =
  | 'UNSUPPORTED'
  | 'READY'
  | 'GENERATING'
  | 'REVIEW'
  | 'ERROR';

export interface PageSummary {
  pageId: string;
  questionCount: number;
  questions?: readonly PopupQuestion[];
}

export interface PopupQuestion {
  id: string | null;
  text: string | null;
  type: string | null;
  supported: boolean;
  existingInput: { hasValue: boolean } | null;
}

export function filledSupportedQuestions(
  page: PageSummary
): readonly PopupQuestion[] {
  return (page.questions ?? []).filter(
    (question) =>
      question.supported &&
      question.id !== null &&
      question.id.trim() !== '' &&
      question.text !== null &&
      question.text.trim() !== '' &&
      question.type !== null &&
      question.existingInput?.hasValue === true
  );
}

export function overrideQuestionLabel(
  question: PopupQuestion,
  position: number
): string {
  return `Q${position + 1} — ${question.text}`;
}

export function createAllOverrideIntent(page: PageSummary): GenerationIntent {
  return createOverrideFilledIntent(
    filledSupportedQuestions(page).map((question) => question.id as string)
  );
}

export function createSpecificOverrideIntent(
  questionIds: readonly string[]
): GenerationIntent {
  return createOverrideFilledIntent(questionIds);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGeneratedUiResult(value: unknown): value is GeneratedUiResult {
  if (!isRecord(value) || !isRecord(value.report) || !isRecord(value.fillReport)) {
    return false;
  }
  const validReportStatuses = new Set([
    'ready',
    'unsupported',
    'GENERATED',
    'ABSTAINED',
    'GENERATION_FAILED',
    'VALIDATION_FAILED',
  ]);
  const validFillStatuses = new Set([
    'FILLED',
    'FILL_FAILED',
    'PARTIAL_FILL',
    'PRESERVED_EXISTING',
    'SKIPPED',
  ]);
  return (
    typeof value.report.cycleId === 'string' &&
    (value.report.status === 'complete' || value.report.status === 'partial') &&
    Array.isArray(value.report.results) &&
    value.report.results.every(
      (result) =>
        isRecord(result) &&
        (typeof result.questionId === 'string' || result.questionId === null) &&
        typeof result.status === 'string' &&
        validReportStatuses.has(result.status)
    ) &&
    typeof value.fillReport.cycleId === 'string' &&
    Array.isArray(value.fillReport.outcomes) &&
    value.fillReport.outcomes.every(
      (outcome) =>
        isRecord(outcome) &&
        (typeof outcome.questionId === 'string' || outcome.questionId === null) &&
        typeof outcome.status === 'string' &&
        validFillStatuses.has(outcome.status)
    )
  );
}

export function isUiGenerationResult(
  value: unknown
): value is UiGenerationResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === 'reused') {
    return typeof value.pageId === 'string' && value.pageId.length > 0;
  }
  return isGeneratedUiResult(value);
}

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
    const currentPage = this.current.name === 'UNSUPPORTED'
      ? null
      : this.current.page;
    const page = snapshot.page
      ? {
          ...snapshot.page,
          questions: snapshot.page.questions ??
            (currentPage?.pageId === snapshot.page.pageId
              ? currentPage.questions
              : undefined),
        }
      : null;
    const normalizedUiState =
      (snapshot.uiState as string) === 'READY_FOR_NEXT'
        ? 'READY'
        : snapshot.uiState;

    if (normalizedUiState === 'UNSUPPORTED' || !page) {
      this.current = unsupportedState();
    } else if (normalizedUiState === 'GENERATING') {
      this.current = { name: 'GENERATING', page };
    } else if (normalizedUiState === 'ERROR') {
      this.current = {
        name: 'ERROR',
        page,
        message: snapshot.error ?? 'Generation failed.',
      };
    } else if (
      normalizedUiState === 'REVIEW' &&
      isUiGenerationResult(snapshot.result)
    ) {
      this.current = {
        name: 'REVIEW',
        page,
        result: snapshot.result,
      };
    } else if (normalizedUiState === 'REVIEW') {
      this.current = {
        name: 'ERROR',
        page,
        message: 'Generation returned an invalid result.',
      };
    } else {
      this.current = readyState(page);
    }
    return this.current;
  }

  beginGeneration(intent: GenerationIntent = { type: 'GENERATE_UNANSWERED' }): UiState {
    const canGenerate =
      this.current.name === 'READY' ||
      (this.current.name === 'REVIEW' && intent.type === 'OVERRIDE_FILLED');
    if (!canGenerate) {
      return this.current;
    }
    if (this.current.name === 'UNSUPPORTED') {
      return this.current;
    }
    const page = this.current.page;
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
    if (!isUiGenerationResult(result)) {
      return this.failGeneration(token, 'Generation returned an invalid result.');
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
