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

export function questionTitleRejectionReason(
  title: string | null
): string | null {
  if (title === null) {
    return 'Question text is unavailable.';
  }

  const qualificationText = title
    .normalize('NFKC')
    .replace(/[\s\p{Cf}]/gu, '')
    .replace(/^\p{N}+\.(?=\p{L})/u, '');
  const meaningfulCharacters = qualificationText.match(/[\p{L}\p{N}]/gu);
  if ((meaningfulCharacters?.length ?? 0) < 2) {
    return 'Question title must contain at least two letters or numbers.';
  }

  return null;
}
