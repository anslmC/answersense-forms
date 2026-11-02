import type { Answer, Form } from '../Models/Logical';
import type { FillOutcome, FillReport } from './Filler';
import {
  createQuestionTargetIndex,
  getOptionLabel,
  isOptionSelected,
  resolveCurrentQuestionTarget,
  type QuestionTargetIndex,
  type ResolvedQuestionTarget,
  type ResolvedTextTarget,
} from './Resolver';

export interface FinalizedPageAnswer {
  questionId: string;
  questionText: string;
  answer: Answer | null;
  outcome: FillOutcome['status'];
  reason: string | null;
  code: FillOutcome['code'];
}

export interface FinalizedPageHandoff {
  readonly cycleId: string;
  readonly pageId: string;
  readonly entries: readonly FinalizedPageAnswer[];
}

export type AnswerSnapshot =
  | { status: 'unavailable'; answer: null }
  | { status: 'captured'; answer: Answer | null };

export function readResolvedTargetAnswer(
  target: ResolvedQuestionTarget
): Answer | null {
  if (target.kind === 'single-choice') {
    const selected = target.options
      .filter(isOptionSelected)
      .map(getOptionLabel);
    return selected.length > 0
      ? { questionId: target.questionId, value: selected[0] }
      : null;
  }
  if (target.kind === 'multiple-choice') {
    const selected = target.options
      .filter(isOptionSelected)
      .map(getOptionLabel);
    return selected.length > 0
      ? { questionId: target.questionId, value: selected }
      : null;
  }

  const control = (target as ResolvedTextTarget).control;
  const value =
    'value' in control ? control.value : (control.textContent ?? '');
  return value ? { questionId: target.questionId, value } : null;
}

export function captureAnswerSnapshot(
  document: Document,
  form: Form,
  questionId: string,
  index?: QuestionTargetIndex
): AnswerSnapshot {
  const question = form.questions.find(
    (candidate) => candidate.id === questionId
  );
  if (!question) {
    return { status: 'unavailable', answer: null };
  }
  const resolved = resolveCurrentQuestionTarget(document, question, index);
  if (!resolved.ok) {
    return { status: 'unavailable', answer: null };
  }
  return {
    status: 'captured',
    answer: readResolvedTargetAnswer(resolved.target),
  };
}

export function snapshotAnswer(
  document: Document,
  form: Form,
  questionId: string,
  index?: QuestionTargetIndex
): Answer | null {
  return captureAnswerSnapshot(document, form, questionId, index).answer;
}

export function createFinalizedPageHandoff(
  document: Document,
  form: Form,
  fillReport: FillReport,
  acceptedPartialQuestionIds: readonly string[] = []
): FinalizedPageHandoff {
  const acceptedPartialIds = new Set(acceptedPartialQuestionIds);
  const index = createQuestionTargetIndex(document);
  const questionsById = new Map(
    form.questions.map((question) => [question.id, question])
  );
  const entries = fillReport.outcomes.map((outcome) => {
    const question = questionsById.get(outcome.questionId as string) ?? null;
    const answer =
      outcome.status === 'SKIPPED' ||
      (outcome.status === 'PARTIAL_FILL' &&
        !acceptedPartialIds.has(outcome.questionId as string))
        ? null
        : snapshotAnswer(document, form, outcome.questionId as string, index);
    return {
      questionId: outcome.questionId as string,
      questionText: question?.text ?? '',
      answer,
      outcome: outcome.status,
      reason: outcome.reason,
      code: outcome.code,
    };
  });

  return Object.freeze({
    cycleId: fillReport.cycleId,
    pageId: form.activePageId,
    entries: Object.freeze(entries),
  });
}
