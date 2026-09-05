import type { Answer } from '../Models/Logical';
import type { SettledContextItem } from './Contract';

export interface SettledAnswer {
  answer: Answer | null;
  questionText: string;
  skipped?: boolean;
}

export interface SettledPageState {
  pageId: string;
  answers: SettledAnswer[];
}

export function buildSettledContext(
  settledPages: readonly SettledPageState[],
): SettledContextItem[] {
  return settledPages.flatMap((page) =>
    page.answers
      .filter(
        (answer): answer is SettledAnswer & { answer: Answer } =>
          !answer.skipped && answer.answer !== null,
      )
      .map((answer) => ({
        questionId: answer.answer.questionId as string,
        questionText: answer.questionText,
        answer: answer.answer.value,
      })),
  );
}
