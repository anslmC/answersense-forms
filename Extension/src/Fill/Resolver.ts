import type { Question, SupportedQuestionType } from '../Models/Logical';
import { isSupportedQuestionType } from '../../../Shared/QuestionTypes';

export type ResolutionFailureCode =
  | 'ELEMENT_NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'TARGET_NOT_FOUND';

interface ResolvedQuestionBase {
  questionElement: HTMLElement;
  questionId: string;
}

export interface ResolvedTextTarget extends ResolvedQuestionBase {
  kind: 'short-text' | 'paragraph';
  control: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
}

export interface ResolvedChoiceTarget extends ResolvedQuestionBase {
  kind: 'single-choice' | 'multiple-choice';
  options: HTMLElement[];
}

export type ResolvedQuestionTarget = ResolvedTextTarget | ResolvedChoiceTarget;

export interface ResolutionSuccess {
  ok: true;
  target: ResolvedQuestionTarget;
}

export interface ResolutionFailure {
  ok: false;
  questionId: string;
  code: ResolutionFailureCode;
  reason: string;
}

export type ResolutionResult = ResolutionSuccess | ResolutionFailure;

function getQuestionId(element: HTMLElement): string | null {
  return (
    element.dataset.questionId ??
    element.getAttribute('data-params') ??
    element.id ??
    element.getAttribute('aria-labelledby')
  );
}

function getCurrentQuestionType(question: HTMLElement): SupportedQuestionType | null {
  const explicitType = question.dataset.questionType;
  if (isSupportedQuestionType(explicitType)) {
    return explicitType;
  }

  if (question.querySelector('[role="radio"]')) {
    return 'single-choice';
  }
  if (question.querySelector('[role="checkbox"]')) {
    return 'multiple-choice';
  }
  if (question.querySelector('textarea, [contenteditable="true"]')) {
    return 'paragraph';
  }
  if (question.querySelector('input[type="text"]')) {
    return 'short-text';
  }
  return null;
}

function findQuestionElement(document: Document, questionId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="listitem"], [data-question-id], [data-params], [aria-labelledby], [id]',
  );
  return Array.from(candidates).find((candidate) => getQuestionId(candidate) === questionId) ?? null;
}

function getChoiceOptions(question: HTMLElement, type: 'single-choice' | 'multiple-choice') {
  const role = type === 'single-choice' ? 'radio' : 'checkbox';
  return Array.from(question.querySelectorAll<HTMLElement>(`[role="${role}"]`));
}

export function resolveCurrentQuestionTarget(
  document: Document,
  question: Question,
): ResolutionResult {
  const questionId = question.id;
  if (questionId === null) {
    return {
      ok: false,
      questionId: '',
      code: 'ELEMENT_NOT_FOUND',
      reason: 'The normalized question has no questionId.',
    };
  }

  const questionElement = findQuestionElement(document, questionId);
  if (!questionElement) {
    return {
      ok: false,
      questionId,
      code: 'ELEMENT_NOT_FOUND',
      reason: 'The current DOM question was not found.',
    };
  }

  const currentType = getCurrentQuestionType(questionElement);
  if (currentType !== question.type) {
    return {
      ok: false,
      questionId,
      code: 'TYPE_MISMATCH',
      reason: 'The current DOM question type does not match the normalized question type.',
    };
  }

  if (currentType === 'single-choice' || currentType === 'multiple-choice') {
    const options = getChoiceOptions(questionElement, currentType);
    if (options.length === 0) {
      return {
        ok: false,
        questionId,
        code: 'TARGET_NOT_FOUND',
        reason: 'The current DOM question has no choice controls.',
      };
    }
    return { ok: true, target: { kind: currentType, questionElement, questionId, options } };
  }

  if (currentType === 'short-text') {
    const control = questionElement.querySelector<HTMLInputElement>('input[type="text"]');
    if (!control) {
      return {
        ok: false,
        questionId,
        code: 'TARGET_NOT_FOUND',
        reason: 'The current DOM question has no text input.',
      };
    }
    return { ok: true, target: { kind: currentType, questionElement, questionId, control } };
  }

  if (currentType === 'paragraph') {
    const control = questionElement.querySelector<HTMLTextAreaElement>(
      'textarea, [contenteditable="true"]',
    );
    if (!control) {
      return {
        ok: false,
        questionId,
        code: 'TARGET_NOT_FOUND',
        reason: 'The current DOM question has no paragraph control.',
      };
    }
    return { ok: true, target: { kind: currentType, questionElement, questionId, control } };
  }

  return {
    ok: false,
    questionId,
    code: 'TARGET_NOT_FOUND',
    reason: 'The current question type is not supported by P4 filling.',
  };
}

export function getOptionLabel(option: HTMLElement): string {
  return (option.getAttribute('aria-label') ?? option.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function isOptionSelected(option: HTMLElement): boolean {
  return (
    option.getAttribute('aria-checked') === 'true' ||
    option.getAttribute('aria-selected') === 'true'
  );
}
