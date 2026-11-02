import type { Answer, Form } from '../Models/Logical';
import { cloneAnswerValue } from '../Shared/Utils';
import type { FillFailureCode } from './Filler';
import { readResolvedTargetAnswer } from './Handoff';
import {
  createQuestionTargetIndex,
  resolveCurrentQuestionTarget,
  type ResolutionFailureCode,
  type QuestionTargetIndex,
} from './Resolver';

export type OverrideTargetStatus = 'eligible' | 'empty' | 'unavailable';

export interface OverrideTarget {
  readonly questionId: string;
  readonly status: OverrideTargetStatus;
  readonly code: FillFailureCode | null;
  readonly reason: string | null;
  readonly answer: Answer | null;
}

export const OVERRIDE_EMPTY_REASON =
  'The question was empty. Consider manually entering an answer or using Auto-Generate.';

const RESOLUTION_FAILURE_REASONS: Readonly<
  Record<ResolutionFailureCode, string>
> = {
  ELEMENT_NOT_FOUND:
    'The question is no longer present in the form, so there is nothing to override.',
  TYPE_MISMATCH:
    'The question type changed in the form after it was answered, so it cannot be overridden.',
  TARGET_NOT_FOUND:
    'The question no longer has an answer control that Override can write to.',
};

function storedAnswer(
  question: Form['questions'][number],
  questionId: string
): Answer | null {
  const value = question.existingInput?.value;
  if (value === null || value === undefined) {
    return null;
  }
  return { questionId, value: cloneAnswerValue(value) };
}

export function inspectOverrideTarget(
  document: Document,
  form: Form,
  questionId: string,
  index?: QuestionTargetIndex
): OverrideTarget {
  const question = form.questions.find(
    (candidate) => candidate.id === questionId
  );
  if (!question) {
    return {
      questionId,
      status: 'unavailable',
      code: 'ELEMENT_NOT_FOUND',
      reason: RESOLUTION_FAILURE_REASONS.ELEMENT_NOT_FOUND,
      answer: null,
    };
  }

  const resolved = resolveCurrentQuestionTarget(document, question, index);
  if (!resolved.ok) {
    return {
      questionId,
      status: 'unavailable',
      code: resolved.code,
      reason: RESOLUTION_FAILURE_REASONS[resolved.code],
      answer: null,
    };
  }

  const liveAnswer = readResolvedTargetAnswer(resolved.target);
  const recordHasValue = question.existingInput?.hasValue === true;
  if (liveAnswer === null && !recordHasValue) {
    return {
      questionId,
      status: 'empty',
      code: 'OVERRIDE_VALIDATION_FAILED',
      reason: OVERRIDE_EMPTY_REASON,
      answer: null,
    };
  }

  return {
    questionId,
    status: 'eligible',
    code: null,
    reason: null,
    answer: liveAnswer ?? storedAnswer(question, questionId),
  };
}

export function inspectOverrideTargets(
  document: Document,
  form: Form,
  questionIds: readonly string[]
): readonly OverrideTarget[] {
  const index = createQuestionTargetIndex(document);
  return questionIds.map((questionId) =>
    inspectOverrideTarget(document, form, questionId, index)
  );
}

export function eligibleOverrideQuestionIds(
  targets: readonly OverrideTarget[]
): readonly string[] {
  return targets
    .filter((target) => target.status === 'eligible')
    .map((target) => target.questionId);
}
