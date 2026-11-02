import type {
  Form,
  Question,
  QuestionResult,
  AnswerValue,
} from '../Models/Logical';
import { questionTitleRejectionReason } from '../../../Shared/QuestionTypes';
import type { GenerationResponse, GenerationResult } from './Contract';
import {
  formatAnswerParts,
  resolveAnswerParts,
  splitAnswerParts,
} from './AnswerParts';

const CONTRACT_MISMATCH_REASON =
  'Generated answer does not match the question contract.';
const INCOMPLETE_PARTS_REASON =
  'The generated answer did not include a value for every blank in the question.';

export class GenerationResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationResponseValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnswerValue(value: unknown): value is AnswerValue {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

type NormalizedAnswer =
  { ok: true; value: AnswerValue } | { ok: false; reason: string };

function normalizeTextAnswer(
  question: Question,
  value: AnswerValue
): NormalizedAnswer {
  const answerParts = resolveAnswerParts(question);
  if (Array.isArray(value)) {
    if (answerParts < 2) {
      return { ok: false, reason: CONTRACT_MISMATCH_REASON };
    }
    const parts = value.map((part) => part.trim()).filter(Boolean);
    if (parts.length < answerParts) {
      return { ok: false, reason: INCOMPLETE_PARTS_REASON };
    }
    return { ok: true, value: formatAnswerParts(parts) };
  }

  if (answerParts < 2) {
    return { ok: true, value };
  }
  const parts = splitAnswerParts(value);
  if (parts.length < answerParts) {
    return { ok: false, reason: INCOMPLETE_PARTS_REASON };
  }
  return {
    ok: true,
    value:
      parts.length === answerParts ? formatAnswerParts(parts) : value.trim(),
  };
}

function normalizeAnswer(question: Question, value: unknown): NormalizedAnswer {
  if (!isAnswerValue(value) || question.type === null) {
    return { ok: false, reason: CONTRACT_MISMATCH_REASON };
  }

  if (question.type === 'short-text' || question.type === 'paragraph') {
    return normalizeTextAnswer(question, value);
  }

  const optionLabels = new Set(question.options.map((option) => option.label));
  if (question.type === 'multiple-choice') {
    return Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((option) => optionLabels.has(option))
      ? { ok: true, value }
      : { ok: false, reason: CONTRACT_MISMATCH_REASON };
  }

  return typeof value === 'string' && optionLabels.has(value)
    ? { ok: true, value }
    : { ok: false, reason: CONTRACT_MISMATCH_REASON };
}

function validateResponseShape(
  response: unknown,
  expectedCycleId: string,
  expectedQuestions: readonly Question[]
): GenerationResponse {
  if (!isRecord(response)) {
    throw new GenerationResponseValidationError(
      'Generation response must be an object.'
    );
  }
  if (typeof response.cycleId !== 'string' || !response.cycleId.trim()) {
    throw new GenerationResponseValidationError(
      'Generation response cycleId is invalid.'
    );
  }
  if (response.cycleId !== expectedCycleId) {
    throw new GenerationResponseValidationError(
      'Generation response cycleId is stale or invalid.'
    );
  }
  if (!Array.isArray(response.results)) {
    throw new GenerationResponseValidationError(
      'Generation response results must be an array.'
    );
  }

  const expectedIds = expectedQuestions
    .filter((question) => question.supported)
    .map((question) => question.id);
  if (expectedIds.some((questionId) => questionId === null)) {
    throw new GenerationResponseValidationError(
      'Supported questions require question IDs.'
    );
  }
  const expectedIdSet = new Set(expectedIds as string[]);
  const seenIds = new Set<string>();

  for (const result of response.results) {
    if (
      !isRecord(result) ||
      typeof result.questionId !== 'string' ||
      !result.questionId.trim()
    ) {
      throw new GenerationResponseValidationError(
        'Each generation result requires a questionId.'
      );
    }
    if (seenIds.has(result.questionId)) {
      throw new GenerationResponseValidationError(
        `Duplicate questionId: ${result.questionId}`
      );
    }
    if (!expectedIdSet.has(result.questionId)) {
      throw new GenerationResponseValidationError(
        `Unknown questionId: ${result.questionId}`
      );
    }
    seenIds.add(result.questionId);

    if (result.status === 'GENERATED') {
      if (
        !isRecord(result.answer) ||
        result.answer.questionId !== result.questionId ||
        !('value' in result.answer)
      ) {
        throw new GenerationResponseValidationError(
          `Invalid generated answer for ${result.questionId}`
        );
      }
    } else if (result.status === 'ABSTAINED') {
      if (result.answer !== null) {
        throw new GenerationResponseValidationError(
          `Abstained result for ${result.questionId} must have null answer.`
        );
      }
      if (
        typeof result.reason !== 'string' ||
        !['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE'].includes(
          result.reason
        )
      ) {
        throw new GenerationResponseValidationError(
          `Invalid abstention reason for ${result.questionId}`
        );
      }
    } else if (result.status === 'GENERATION_FAILED') {
      if (result.answer !== null) {
        throw new GenerationResponseValidationError(
          `Failed result for ${result.questionId} must have null answer.`
        );
      }
      if (
        !isRecord(result.failure) ||
        typeof result.failure.code !== 'string' ||
        typeof result.failure.message !== 'string'
      ) {
        throw new GenerationResponseValidationError(
          `Invalid generation failure for ${result.questionId}`
        );
      }
    } else {
      throw new GenerationResponseValidationError(
        `Invalid result status for ${result.questionId}`
      );
    }
  }

  if (seenIds.size !== expectedIdSet.size) {
    throw new GenerationResponseValidationError(
      'Generation results must be exhaustive.'
    );
  }

  return response as unknown as GenerationResponse;
}

export function validateGenerationResponse(
  response: unknown,
  form: Form,
  expectedCycleId: string,
  expectedQuestions: readonly Question[] = form.questions
): QuestionResult[] {
  const validResponse = validateResponseShape(
    response,
    expectedCycleId,
    expectedQuestions
  );
  const resultsById = new Map<string, GenerationResult>(
    validResponse.results.map((result) => [result.questionId, result])
  );
  const candidateIds = new Set(
    expectedQuestions.flatMap((question) =>
      question.id === null ? [] : [question.id]
    )
  );

  return form.questions.flatMap((question): QuestionResult[] => {
    const titleRejectionReason = questionTitleRejectionReason(question.text);
    if (!question.supported || titleRejectionReason !== null) {
      return [
        {
          questionId: question.id,
          status: 'unsupported',
          answer: null,
          reason: question.unsupportedReason ?? titleRejectionReason,
        },
      ];
    }
    if (question.id === null || !candidateIds.has(question.id)) {
      return [];
    }

    const questionId = question.id as string;
    const result = resultsById.get(questionId) as GenerationResult;
    if (result.status === 'GENERATION_FAILED') {
      return [
        {
          questionId,
          status: 'GENERATION_FAILED',
          answer: null,
          reason: result.failure.message,
        },
      ];
    }

    if (result.status === 'ABSTAINED') {
      return [
        {
          questionId,
          status: 'ABSTAINED',
          answer: null,
          reason: result.reason,
        },
      ];
    }

    const normalized = normalizeAnswer(question, result.answer.value);
    if (!normalized.ok) {
      return [
        {
          questionId,
          status: 'VALIDATION_FAILED',
          answer: null,
          reason: normalized.reason,
        },
      ];
    }

    return [
      {
        questionId,
        status: 'GENERATED',
        answer: { questionId, value: normalized.value },
        reason: null,
      },
    ];
  });
}
