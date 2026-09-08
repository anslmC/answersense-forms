export const SUPPORTED_QUESTION_TYPES = [
  'short-text',
  'paragraph',
  'single-choice',
  'multiple-choice',
] as const;

export type SupportedQuestionType = (typeof SUPPORTED_QUESTION_TYPES)[number];

export function isSupportedQuestionType(
  value: unknown
): value is SupportedQuestionType {
  return (
    typeof value === 'string' &&
    (SUPPORTED_QUESTION_TYPES as readonly string[]).includes(value)
  );
}
