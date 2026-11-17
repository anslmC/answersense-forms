import type {
  FailedQuestionResult,
  GeneratedAnswer,
  GenerationQuestion,
  GenerationRequest,
  GenerationResult,
} from './Contract';
import { resolveAnswerParts, splitAnswerParts } from './AnswerParts';
import {
  isNvidiaProviderErrorCode,
  nvidiaFailureDetails,
} from './NvidiaBatchExecution';

const ABSTENTION_REASONS = new Set([
  'LOW_CONFIDENCE',
  'UNABLE_TO_DETERMINE',
  'NOT_APPLICABLE',
]);

export interface NvidiaSalvageResult {
  readonly results: readonly GenerationResult[];
  readonly acceptedQuestionIds: readonly string[];
  readonly failedQuestionIds: readonly string[];
  readonly missingQuestionIds: readonly string[];
  readonly invalidQuestionIds: readonly string[];
  readonly duplicateQuestionIds: readonly string[];
  readonly unknownQuestionIds: readonly string[];
  readonly ignoredResultCount: number;
  readonly candidateCount: number;
  readonly hasUsableResult: boolean;
}

export interface NvidiaResultFailureDetails {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isAnswerValue(value: unknown): value is string | string[] {
  return typeof value === 'string' || isStringArray(value);
}

function answerValueForQuestion(
  question: GenerationQuestion,
  value: unknown
): string | string[] | null {
  if (!isAnswerValue(value)) {
    return null;
  }
  if (question.type === 'short-text' || question.type === 'paragraph') {
    const answerParts = resolveAnswerParts({
      text: question.text,
      answerParts: question.answerParts,
    });
    if (answerParts < 2) {
      return typeof value === 'string' ? value : null;
    }
    if (Array.isArray(value)) {
      return value.map((part) => part.trim()).filter(Boolean).length >=
        answerParts
        ? [...value]
        : null;
    }
    return splitAnswerParts(value).length >= answerParts ? value : null;
  }

  const options = new Set(question.options);
  if (question.type === 'multiple-choice') {
    return Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((option) => options.has(option))
      ? [...value]
      : null;
  }
  return typeof value === 'string' && options.has(value) ? value : null;
}

function canonicalResultForQuestion(
  result: Record<string, unknown>,
  question: GenerationQuestion
): GenerationResult | null {
  if (result.questionId !== question.questionId) {
    return null;
  }
  if (result.status === 'GENERATED') {
    if (
      !isRecord(result.answer) ||
      result.answer.questionId !== question.questionId
    ) {
      return null;
    }
    const value = answerValueForQuestion(question, result.answer.value);
    if (value === null) {
      return null;
    }
    const answer: GeneratedAnswer = {
      questionId: question.questionId,
      value,
    };
    return {
      questionId: question.questionId,
      status: 'GENERATED',
      answer,
    };
  }
  if (result.status === 'ABSTAINED') {
    return result.answer === null &&
      typeof result.reason === 'string' &&
      ABSTENTION_REASONS.has(result.reason)
      ? {
          questionId: question.questionId,
          status: 'ABSTAINED',
          answer: null,
          reason: result.reason as
            'LOW_CONFIDENCE' | 'UNABLE_TO_DETERMINE' | 'NOT_APPLICABLE',
        }
      : null;
  }
  if (result.status === 'GENERATION_FAILED') {
    return result.answer === null &&
      isRecord(result.failure) &&
      typeof result.failure.code === 'string' &&
      result.failure.code.trim().length > 0 &&
      typeof result.failure.message === 'string'
      ? {
          questionId: question.questionId,
          status: 'GENERATION_FAILED',
          answer: null,
          failure: {
            code: result.failure.code,
            message: result.failure.message,
          },
        }
      : null;
  }
  return null;
}

export function nvidiaResultFailureDetails(
  result: FailedQuestionResult
): NvidiaResultFailureDetails {
  const code = result.failure.code;
  if (isNvidiaProviderErrorCode(code)) {
    const details = nvidiaFailureDetails(code);
    return {
      code,
      message: details.message,
      retryable: details.retryable === true,
    };
  }
  return {
    code: 'PROVIDER_FAILURE',
    message: nvidiaFailureDetails('PROVIDER_FAILURE').message,
    retryable: false,
  };
}

export function parseNvidiaSalvageObjects(
  objects: readonly unknown[],
  request: GenerationRequest
): NvidiaSalvageResult {
  const expected = new Map(
    request.questions.map((question) => [question.questionId, question])
  );
  const resultsById = new Map<string, GenerationResult>();
  const invalidIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const unknownIds = new Set<string>();
  let ignoredResultCount = 0;
  let candidateCount = 0;

  for (const object of objects) {
    if (
      !isRecord(object) ||
      object.cycleId !== request.cycleId ||
      !Array.isArray(object.results)
    ) {
      continue;
    }
    candidateCount += 1;
    for (const rawResult of object.results) {
      if (!isRecord(rawResult)) {
        ignoredResultCount += 1;
        continue;
      }
      const questionId = rawResult.questionId;
      if (typeof questionId !== 'string' || questionId.trim().length === 0) {
        ignoredResultCount += 1;
        continue;
      }
      const question = expected.get(questionId);
      if (!question) {
        unknownIds.add(questionId);
        continue;
      }
      if (resultsById.has(questionId) || invalidIds.has(questionId)) {
        duplicateIds.add(questionId);
      }
      if (resultsById.has(questionId)) {
        continue;
      }
      const canonical = canonicalResultForQuestion(rawResult, question);
      if (!canonical) {
        invalidIds.add(questionId);
        continue;
      }
      invalidIds.delete(questionId);
      resultsById.set(questionId, canonical);
    }
  }

  const results = request.questions.flatMap((question) => {
    const result = resultsById.get(question.questionId);
    return result ? [result] : [];
  });
  const acceptedQuestionIds = results.flatMap((result) =>
    result.status === 'GENERATED' || result.status === 'ABSTAINED'
      ? [result.questionId]
      : []
  );
  const failedQuestionIds = results.flatMap((result) =>
    result.status === 'GENERATION_FAILED' ? [result.questionId] : []
  );
  const missingQuestionIds = request.questions.flatMap((question) =>
    resultsById.has(question.questionId) || invalidIds.has(question.questionId)
      ? []
      : [question.questionId]
  );

  return {
    results,
    acceptedQuestionIds,
    failedQuestionIds,
    missingQuestionIds,
    invalidQuestionIds: request.questions.flatMap((question) =>
      invalidIds.has(question.questionId) ? [question.questionId] : []
    ),
    duplicateQuestionIds: request.questions.flatMap((question) =>
      duplicateIds.has(question.questionId) ? [question.questionId] : []
    ),
    unknownQuestionIds: [...unknownIds],
    ignoredResultCount,
    candidateCount,
    hasUsableResult: results.length > 0,
  };
}
