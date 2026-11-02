import type { SupportedQuestionType } from '../Models/Logical';

const BLANK_MARKER = /[_\uFF3F]{2,}/g;
const ANSWER_PART_SEPARATOR = /[,;\n]+/;

export interface AnswerPartQuestion {
  questionId: string;
  text: string;
  type: SupportedQuestionType;
  answerParts?: number;
}

export function countAnswerParts(text: string): number {
  const markers = text.match(BLANK_MARKER);
  return Math.max(1, markers?.length ?? 0);
}

export function resolveAnswerParts(question: {
  text: string | null;
  answerParts?: number;
}): number {
  if (typeof question.answerParts === 'number') {
    return Number.isSafeInteger(question.answerParts) &&
      question.answerParts > 1
      ? question.answerParts
      : 1;
  }
  return question.text === null ? 1 : countAnswerParts(question.text);
}

export function splitAnswerParts(value: string): string[] {
  return value
    .split(ANSWER_PART_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function formatAnswerParts(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

export function buildAnswerPartsInstructions(
  questions: readonly AnswerPartQuestion[]
): string[] {
  return questions.flatMap((question) => {
    if (question.type !== 'paragraph' && question.type !== 'short-text') {
      return [];
    }
    const parts = resolveAnswerParts({
      text: question.text,
      answerParts: question.answerParts,
    });
    if (parts < 2) {
      return [];
    }
    return [
      `Question ${question.questionId} contains ${parts} blank markers. Return only the blank values separated by commas in blank order, with exactly one answer value per blank. Do not concatenate the values into a single token.`,
    ];
  });
}
