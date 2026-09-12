import type { NormalizedActivePage } from '../Models/Logical';

export type GenerationIntent =
  | { type: 'GENERATE_UNANSWERED' }
  | {
      type: 'OVERRIDE_FILLED';
      selectedQuestionIds: readonly string[];
    };

export const GENERATE_UNANSWERED: GenerationIntent = {
  type: 'GENERATE_UNANSWERED',
};

export function createOverrideFilledIntent(
  selectedQuestionIds: readonly string[]
): GenerationIntent {
  return {
    type: 'OVERRIDE_FILLED',
    selectedQuestionIds: Object.freeze([...selectedQuestionIds]),
  };
}

export function parseGenerationIntent(value: unknown): GenerationIntent {
  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'GENERATE_UNANSWERED'
  ) {
    return GENERATE_UNANSWERED;
  }
  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'OVERRIDE_FILLED' &&
    'selectedQuestionIds' in value &&
    Array.isArray(value.selectedQuestionIds) &&
    value.selectedQuestionIds.every((questionId) => typeof questionId === 'string')
  ) {
    return createOverrideFilledIntent(value.selectedQuestionIds);
  }
  throw new Error('Generation intent is invalid.');
}

export interface OverrideSelectionValidation {
  valid: boolean;
  invalidQuestionIds: readonly string[];
}

export function validateOverrideSelection(
  page: NormalizedActivePage,
  intent: GenerationIntent
): OverrideSelectionValidation {
  if (intent.type !== 'OVERRIDE_FILLED') {
    return { valid: true, invalidQuestionIds: [] };
  }

  const invalidQuestionIds: string[] = [];
  const seenQuestionIds = new Set<string>();
  for (const questionId of intent.selectedQuestionIds) {
    const question = page.form.questions.find(
      (candidate) => candidate.id === questionId
    );
    if (
      seenQuestionIds.has(questionId) ||
      !question ||
      question.id === null ||
      question.id.trim() === '' ||
      question.text === null ||
      question.text.trim() === '' ||
      question.type === null ||
      !question.supported ||
      question.existingInput?.hasValue !== true
    ) {
      invalidQuestionIds.push(questionId);
    }
    seenQuestionIds.add(questionId);
  }

  return {
    valid: invalidQuestionIds.length === 0 && intent.selectedQuestionIds.length > 0,
    invalidQuestionIds:
      intent.selectedQuestionIds.length > 0
        ? invalidQuestionIds
        : ['<empty-selection>'],
  };
}

export function assertValidOverrideSelection(
  page: NormalizedActivePage,
  intent: GenerationIntent
): void {
  const validation = validateOverrideSelection(page, intent);
  if (!validation.valid) {
    throw new Error(
      `Override selection is invalid: ${validation.invalidQuestionIds.join(', ')}`
    );
  }
}