import type { Answer } from '../Models/Logical';
import type { GenerationReport } from '../Generation/Report';

export type ReviewDecisionKind = 'accept' | 'edit' | 'skip';

export interface ReviewDecision {
  questionId: string;
  decision: ReviewDecisionKind;
  answer: Answer | null;
}

export function acceptGeneratedAnswer(
  questionId: string,
  answer: Answer,
): ReviewDecision {
  return { questionId, decision: 'accept', answer };
}

export function editReviewedAnswer(
  questionId: string,
  answer: Answer,
): ReviewDecision {
  return { questionId, decision: 'edit', answer };
}

export function skipReviewedAnswer(questionId: string): ReviewDecision {
  return { questionId, decision: 'skip', answer: null };
}

export function createAcceptedReviewDecisions(
  report: GenerationReport,
): ReviewDecision[] {
  return report.results.map((result) => {
    if (result.status === 'GENERATED' && result.answer !== null) {
      return acceptGeneratedAnswer(result.questionId as string, result.answer);
    }
    return skipReviewedAnswer(result.questionId as string);
  });
}
