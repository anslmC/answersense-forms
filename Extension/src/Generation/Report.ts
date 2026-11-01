import type { QuestionResult } from '../Models/Logical';
import { cloneAnswerValue } from '../Shared/Utils';

export type GenerationReportStatus = 'complete' | 'partial';

export interface GenerationReport {
  readonly cycleId: string;
  readonly status: GenerationReportStatus;
  readonly results: readonly QuestionResult[];
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nestedValue of Object.values(value)) {
      freezeDeep(nestedValue);
    }
  }
  return value;
}

export function createGenerationReport(
  cycleId: string,
  results: QuestionResult[]
): GenerationReport {
  const supportedResults = results.filter(
    (result) => result.status !== 'unsupported'
  );
  const status = supportedResults.every(
    (result) => result.status === 'GENERATED'
  )
    ? 'complete'
    : 'partial';
  return freezeDeep({
    cycleId,
    status,
    results: results.map((result) => ({
      questionId: result.questionId,
      status: result.status,
      answer: result.answer
        ? {
            questionId: result.answer.questionId,
            value: cloneAnswerValue(result.answer.value),
          }
        : null,
      reason: result.reason,
    })),
  });
}
