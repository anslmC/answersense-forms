import type {
  GenerationFailure,
  GenerationRequest,
  GenerationResponse,
  GenerationResult,
} from './Contract';
import type { NvidiaBatchOutcome } from './NvidiaBatchExecution';

export interface NvidiaBatchFailureDescriptor {
  readonly code: string;
  readonly message: string;
}

export const DEFAULT_NVIDIA_BATCH_FAILURE: NvidiaBatchFailureDescriptor =
  Object.freeze({
    code: 'PROVIDER_FAILURE',
    message: 'Provider request failed.',
  });

function createFailureDescriptor(
  descriptor: NvidiaBatchFailureDescriptor
): GenerationFailure {
  return {
    code: descriptor.code,
    message: descriptor.message,
  };
}

function createFailedResult(
  questionId: string,
  descriptor: NvidiaBatchFailureDescriptor
): GenerationResult {
  return {
    questionId,
    status: 'GENERATION_FAILED',
    answer: null,
    failure: createFailureDescriptor(descriptor),
  };
}

export function assembleNvidiaBatchResponse(
  request: GenerationRequest,
  outcomes: readonly NvidiaBatchOutcome[],
  failureForError: (error: unknown) => NvidiaBatchFailureDescriptor = () =>
    DEFAULT_NVIDIA_BATCH_FAILURE
): GenerationResponse {
  const expectedIds = new Set(
    request.questions.map((question) => question.questionId)
  );
  const resultsById = new Map<string, GenerationResult>();

  for (const outcome of outcomes) {
    if (outcome.ok) {
      for (const result of outcome.response.results) {
        if (
          expectedIds.has(result.questionId) &&
          !resultsById.has(result.questionId)
        ) {
          resultsById.set(result.questionId, result);
        }
      }
      continue;
    }

    const failure = failureForError(outcome.error);
    for (const question of outcome.batch.questions) {
      if (
        expectedIds.has(question.questionId) &&
        !resultsById.has(question.questionId)
      ) {
        resultsById.set(
          question.questionId,
          createFailedResult(question.questionId, failure)
        );
      }
    }
  }

  const missingFailure = failureForError(undefined);
  return {
    cycleId: request.cycleId,
    results: request.questions.map(
      (question) =>
        resultsById.get(question.questionId) ??
        createFailedResult(question.questionId, missingFailure)
    ),
  };
}
