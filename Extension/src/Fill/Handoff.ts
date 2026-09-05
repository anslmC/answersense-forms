import type { Answer, Form } from '../Models/Logical';
import type { FillOutcome, FillReport } from './Filler';
import {
  getOptionLabel,
  isOptionSelected,
  resolveCurrentQuestionTarget,
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

function snapshotAnswer(
  document: Document,
  form: Form,
  questionId: string,
): Answer | null {
  const question = form.questions.find((candidate) => candidate.id === questionId);
  if (!question) {
    return null;
  }
  const resolved = resolveCurrentQuestionTarget(document, question);
  if (!resolved.ok) {
    return null;
  }

  if (resolved.target.kind === 'short-text' || resolved.target.kind === 'paragraph') {
    const control = resolved.target.control;
    const value = 'value' in control ? control.value : control.textContent ?? '';
    return value ? { questionId, value } : null;
  }

  if (resolved.target.kind !== 'single-choice' && resolved.target.kind !== 'multiple-choice') {
    return null;
  }
  const selected = resolved.target.options.filter(isOptionSelected).map(getOptionLabel);
  if (selected.length === 0) {
    return null;
  }
  return {
    questionId,
    value: resolved.target.kind === 'multiple-choice' ? selected : selected[0],
  };
}

export function createFinalizedPageHandoff(
  document: Document,
  form: Form,
  fillReport: FillReport,
  acceptedPartialQuestionIds: readonly string[] = [],
): FinalizedPageHandoff {
  const acceptedPartialIds = new Set(acceptedPartialQuestionIds);
  const entries = fillReport.outcomes.map((outcome) => {
    const question = form.questions.find((candidate) => candidate.id === outcome.questionId);
    const answer = outcome.status === 'SKIPPED' ||
      (outcome.status === 'PARTIAL_FILL' && !acceptedPartialIds.has(outcome.questionId as string))
      ? null
      : snapshotAnswer(document, form, outcome.questionId as string);
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
