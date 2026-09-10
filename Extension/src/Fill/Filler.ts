import type {
  Answer,
  Form,
  Question,
  QuestionResultStatus,
} from '../Models/Logical';
import type { GenerationReport } from '../Generation/Report';
import type { ReviewDecision } from '../Review/Decisions';
import {
  getOptionLabel,
  isOptionSelected,
  resolveCurrentQuestionTarget,
  type ResolutionFailure,
  type ResolvedChoiceTarget,
  type ResolvedTextTarget,
} from './Resolver';

export type FillStatus =
  'FILLED' | 'FILL_FAILED' | 'PARTIAL_FILL' | 'PRESERVED_EXISTING' | 'SKIPPED';

export type FillFailureCode =
  | 'ELEMENT_NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_OPTION'
  | 'INVALID_ANSWER';

export interface FillOutcome {
  questionId: string | null;
  status: FillStatus;
  answer: Answer | null;
  reason: string | null;
  code: FillFailureCode | null;
}

export interface FillReport {
  readonly cycleId: string;
  readonly outcomes: readonly FillOutcome[];
}

export interface SkipDiagnostic {
  readonly questionId: string;
  readonly generationStatus: QuestionResultStatus | 'unknown';
  readonly generationReason: string | null;
  readonly fillStatus: FillStatus;
  readonly fillReason: string | null;
}

export function createSkipDiagnostics(
  report: GenerationReport,
  fillReport: FillReport
): readonly SkipDiagnostic[] {
  const resultsByQuestionId = new Map(
    report.results.map((result) => [result.questionId, result])
  );

  return fillReport.outcomes
    .filter(
      (outcome): outcome is FillOutcome & { questionId: string } =>
        outcome.status === 'SKIPPED' && typeof outcome.questionId === 'string'
    )
    .map((outcome) => {
      const generation = resultsByQuestionId.get(outcome.questionId);
      return {
        questionId: outcome.questionId,
        generationStatus: generation?.status ?? 'unknown',
        generationReason: generation?.reason ?? null,
        fillStatus: outcome.status,
        fillReason: outcome.reason,
      } satisfies SkipDiagnostic;
    });
}

const CHOICE_VERIFICATION_ATTEMPTS = 3;
const CHOICE_VERIFICATION_DELAY_MS = 16;

function failureOutcome(
  questionId: string | null,
  failure: ResolutionFailure | { code: FillFailureCode; reason: string },
  answer: Answer | null
): FillOutcome {
  return {
    questionId,
    status: 'FILL_FAILED',
    answer,
    reason: failure.reason,
    code: failure.code,
  };
}

function currentTextValue(target: ResolvedTextTarget): string {
  if ('value' in target.control) {
    return target.control.value;
  }
  return target.control.textContent ?? '';
}

function currentChoiceAnswer(target: ResolvedChoiceTarget): Answer | null {
  const selected = target.options.filter(isOptionSelected).map(getOptionLabel);
  return selected.length > 0
    ? {
        questionId: target.questionId,
        value: target.kind === 'multiple-choice' ? selected : selected[0],
      }
    : null;
}

function preserveExisting(
  target: ResolvedTextTarget | ResolvedChoiceTarget
): FillOutcome | null {
  if (target.kind === 'short-text' || target.kind === 'paragraph') {
    const value = currentTextValue(target);
    if (value) {
      return {
        questionId: target.questionId,
        status: 'PRESERVED_EXISTING',
        answer: { questionId: target.questionId, value },
        reason: 'The current DOM already contains an answer.',
        code: null,
      };
    }
    return null;
  }

  if (target.kind === 'single-choice') {
    return currentChoiceAnswer(target)
      ? {
          questionId: target.questionId,
          status: 'PRESERVED_EXISTING',
          answer: currentChoiceAnswer(target),
          reason: 'The current DOM already contains an answer.',
          code: null,
        }
      : null;
  }

  return null;
}

function dispatchInputEvents(control: HTMLElement): void {
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillText(target: ResolvedTextTarget, answer: Answer): FillOutcome {
  if (typeof answer.value !== 'string') {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Text questions require a string answer.',
      },
      answer
    );
  }

  if ('value' in target.control) {
    target.control.value = answer.value;
  } else {
    target.control.textContent = answer.value;
  }
  dispatchInputEvents(target.control);
  if (currentTextValue(target) !== answer.value) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'The text control did not retain the requested value.',
      },
      answer
    );
  }
  return {
    questionId: target.questionId,
    status: 'FILLED',
    answer,
    reason: null,
    code: null,
  };
}

function activateOption(option: HTMLElement): void {
  option.click();
}

function deactivateOption(option: HTMLElement): void {
  option.click();
}

async function verifyChoiceSelection(
  isSelected: () => boolean
): Promise<boolean> {
  for (let attempt = 0; attempt < CHOICE_VERIFICATION_ATTEMPTS; attempt += 1) {
    if (isSelected()) return true;
    if (attempt < CHOICE_VERIFICATION_ATTEMPTS - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, CHOICE_VERIFICATION_DELAY_MS);
      });
    }
  }
  return false;
}

async function fillSingleChoice(
  target: ResolvedChoiceTarget,
  answer: Answer
): Promise<FillOutcome> {
  if (typeof answer.value !== 'string') {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Multiple-choice questions require a single string answer.',
      },
      answer
    );
  }

  const option = target.options.find(
    (candidate) => getOptionLabel(candidate) === answer.value
  );
  if (!option) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason: 'The requested choice is not present in the current DOM.',
      },
      answer
    );
  }
  activateOption(option);
  if (!(await verifyChoiceSelection(() => isOptionSelected(option)))) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason: 'The requested choice was not selected in the current DOM.',
      },
      answer
    );
  }
  return {
    questionId: target.questionId,
    status: 'FILLED',
    answer,
    reason: null,
    code: null,
  };
}

async function fillCheckboxes(
  target: ResolvedChoiceTarget,
  answer: Answer
): Promise<FillOutcome> {
  if (!Array.isArray(answer.value)) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Checkbox questions require an array answer.',
      },
      answer
    );
  }

  const optionsByLabel = new Map(
    target.options.map((option) => [getOptionLabel(option), option])
  );
  const requested = [...new Set(answer.value)];
  const available = requested.filter((label) => optionsByLabel.has(label));
  const missing = requested.filter((label) => !optionsByLabel.has(label));
  const selectedBefore = new Set(
    target.options.filter(isOptionSelected).map(getOptionLabel)
  );

  if (available.length === 0) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason:
          'None of the requested checkbox options are present in the current DOM.',
      },
      answer
    );
  }

  const newlySelected: HTMLElement[] = [];
  try {
    for (const label of available) {
      const option = optionsByLabel.get(label);
      if (option && !isOptionSelected(option)) {
        newlySelected.push(option);
        activateOption(option);
      }
    }
  } catch {
    try {
      for (const option of newlySelected) {
        if (isOptionSelected(option)) {
          deactivateOption(option);
        }
      }
      if (newlySelected.some((option) => isOptionSelected(option))) {
        throw new Error(
          'Checkbox rollback could not restore the original state.'
        );
      }
    } catch {
      return {
        questionId: target.questionId,
        status: 'PARTIAL_FILL',
        answer,
        reason:
          'Checkbox filling failed and rollback could not restore the original state.',
        code: 'INVALID_OPTION',
      };
    }
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason: 'The requested checkbox selections could not be applied.',
      },
      answer
    );
  }

  const alreadyComplete = requested.every((label) => selectedBefore.has(label));
  if (alreadyComplete) {
    return {
      questionId: target.questionId,
      status: 'PRESERVED_EXISTING',
      answer: currentChoiceAnswer(target),
      reason: 'The requested checkbox selections already existed.',
      code: null,
    };
  }

  const labelsToVerify = missing.length > 0 ? available : requested;
  const verified = await verifyChoiceSelection(() =>
    labelsToVerify.every((label) => {
      const option = optionsByLabel.get(label);
      return option !== undefined && isOptionSelected(option);
    })
  );
  if (!verified) {
    try {
      for (const option of newlySelected) {
        if (isOptionSelected(option)) {
          deactivateOption(option);
        }
      }
      if (newlySelected.some((option) => isOptionSelected(option))) {
        throw new Error(
          'Checkbox rollback could not restore the original state.'
        );
      }
    } catch {
      return {
        questionId: target.questionId,
        status: 'PARTIAL_FILL',
        answer,
        reason:
          'Checkbox verification failed and rollback could not restore the original state.',
        code: 'INVALID_OPTION',
      };
    }
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason:
          'The requested checkbox selections were not retained by the current DOM.',
      },
      answer
    );
  }

  return {
    questionId: target.questionId,
    status: missing.length > 0 ? 'PARTIAL_FILL' : 'FILLED',
    answer: missing.length > 0 ? answer : currentChoiceAnswer(target),
    reason:
      missing.length > 0
        ? 'Some requested checkbox options were unavailable.'
        : null,
    code: missing.length > 0 ? 'INVALID_OPTION' : null,
  };
}

async function fillQuestion(
  document: Document,
  question: Question,
  answer: Answer
): Promise<FillOutcome> {
  const resolved = resolveCurrentQuestionTarget(document, question);
  if (!resolved.ok) {
    return failureOutcome(question.id, resolved, answer);
  }

  const preserved = preserveExisting(resolved.target);
  if (preserved) {
    return preserved;
  }

  if (
    resolved.target.kind === 'short-text' ||
    resolved.target.kind === 'paragraph'
  ) {
    return fillText(resolved.target, answer);
  }
  if (resolved.target.kind === 'single-choice') {
    return fillSingleChoice(resolved.target, answer);
  }
  if (resolved.target.kind === 'multiple-choice') {
    return fillCheckboxes(resolved.target, answer);
  }
  return failureOutcome(
    question.id,
    {
      code: 'TARGET_NOT_FOUND',
      reason: 'The current question type is not supported by P4 filling.',
    },
    answer
  );
}

export async function fillReviewedAnswers(
  document: Document,
  form: Form,
  report: GenerationReport,
  decisions: readonly ReviewDecision[]
): Promise<FillReport> {
  const decisionsById = new Map(
    decisions.map((decision) => [decision.questionId, decision])
  );
  const outcomes: FillOutcome[] = [];
  for (const result of report.results) {
    const questionId = result.questionId;
    const decision =
      questionId === null ? undefined : decisionsById.get(questionId);
    if (!decision || decision.decision === 'skip' || decision.answer === null) {
      outcomes.push({
        questionId,
        status: 'SKIPPED',
        answer: null,
        reason: 'The reviewed answer was skipped.',
        code: null,
      });
      continue;
    }

    if (decision.answer.questionId !== questionId) {
      outcomes.push(failureOutcome(
        questionId,
        {
          code: 'INVALID_ANSWER',
          reason: 'The reviewed answer questionId does not match the decision.',
        },
        decision.answer
      ));
      continue;
    }

    const question = form.questions.find(
      (candidate) => candidate.id === questionId
    );
    if (!question) {
      outcomes.push(failureOutcome(
        questionId,
        {
          code: 'ELEMENT_NOT_FOUND',
          reason:
            'The reviewed question is not present in the normalized form.',
        },
        decision.answer
      ));
      continue;
    }

    outcomes.push(await fillQuestion(document, question, decision.answer));
  }

  return Object.freeze({
    cycleId: report.cycleId,
    outcomes: Object.freeze(outcomes),
  });
}
