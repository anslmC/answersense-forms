import type { Answer } from '../Models/Logical';
import type { SettledContextItem } from './Contract';

export interface SettledAnswer {
  answer: Answer | null;
  questionText: string;
  skipped?: boolean;
}

export interface SettledPageState {
  pageId: string;
  pageFingerprint?: string | null;
  answers: SettledAnswer[];
}

export function buildSettledContext(
  settledPages: readonly SettledPageState[]
): SettledContextItem[] {
  const uniquePages = new Map<string, SettledPageState>();
  for (const page of settledPages) {
    uniquePages.set(page.pageId, page);
  }

  const seen = new Set<string>();
  return [...uniquePages.values()].flatMap((page) =>
    page.answers
      .filter(
        (answer): answer is SettledAnswer & { answer: Answer } =>
          !answer.skipped && answer.answer !== null
      )
      .flatMap((answer) => {
        const questionId = answer.answer.questionId as string;
        if (seen.has(questionId)) {
          return [];
        }
        seen.add(questionId);
        return [
          {
            questionId,
            questionText: answer.questionText,
            answer: answer.answer.value,
          },
        ];
      })
  );
}
