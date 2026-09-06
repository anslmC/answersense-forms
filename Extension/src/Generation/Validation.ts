import type {
  Form,
  Question,
  QuestionResult,
  AnswerValue,
} from '../Models/Logical';
import type {
  GenerationResponse,
  GenerationResult,
} from './Contract';

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

function isValidAnswer(question: Question, value: unknown): value is AnswerValue {
  if (!isAnswerValue(value) || question.type === null) {
    return false;
  }

  if (question.type === 'short-text' || question.type === 'paragraph') {
    return typeof value === 'string';
  }

  const optionLabels = new Set(question.options.map((option) => option.label));
  if (question.type === 'multiple-choice') {
    return (
      Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((option) => optionLabels.has(option))
    );
  }

  return typeof value === 'string' && optionLabels.has(value);
}

function validateResponseShape(
  response: unknown,
  expectedCycleId: string,
  expectedQuestions: Question[],
): GenerationResponse {
  if (!isRecord(response)) {
    throw new GenerationResponseValidationError('Generation response must be an object.');
  }
  if (typeof response.cycleId !== 'string' || !response.cycleId.trim()) {
    throw new GenerationResponseValidationError('Generation response cycleId is invalid.');
  }
  if (response.cycleId !== expectedCycleId) {
    throw new GenerationResponseValidationError('Generation response cycleId is stale or invalid.');
  }
  if (!Array.isArray(response.results)) {
    throw new GenerationResponseValidationError('Generation response results must be an array.');
  }

  const expectedIds = expectedQuestions
    .filter((question) => question.supported)
    .map((question) => question.id);
  if (expectedIds.some((questionId) => questionId === null)) {
    throw new GenerationResponseValidationError('Supported questions require question IDs.');
  }
  const expectedIdSet = new Set(expectedIds as string[]);
  const seenIds = new Set<string>();

  for (const result of response.results) {
    if (!isRecord(result) || typeof result.questionId !== 'string' || !result.questionId.trim()) {
      throw new GenerationResponseValidationError('Each generation result requires a questionId.');
    }
    if (seenIds.has(result.questionId)) {
      throw new GenerationResponseValidationError(`Duplicate questionId: ${result.questionId}`);
    }
    if (!expectedIdSet.has(result.questionId)) {
      throw new GenerationResponseValidationError(`Unknown questionId: ${result.questionId}`);
    }
    seenIds.add(result.questionId);

    if (result.status === 'GENERATED') {
      if (!isRecord(result.answer) || result.answer.questionId !== result.questionId || !('value' in result.answer)) {
        throw new GenerationResponseValidationError(`Invalid generated answer for ${result.questionId}`);
      }
    } else if (result.status === 'ABSTAINED') {
      if (result.answer !== null) {
        throw new GenerationResponseValidationError(`Abstained result for ${result.questionId} must have null answer.`);
      }
      if (typeof result.reason !== 'string' || !['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE'].includes(result.reason)) {
        throw new GenerationResponseValidationError(`Invalid abstention reason for ${result.questionId}`);
      }
    } else if (result.status === 'GENERATION_FAILED') {
      if (result.answer !== null) {
        throw new GenerationResponseValidationError(`Failed result for ${result.questionId} must have null answer.`);
      }
      if (
        !isRecord(result.failure) ||
        typeof result.failure.code !== 'string' ||
        typeof result.failure.message !== 'string'
      ) {
        throw new GenerationResponseValidationError(`Invalid generation failure for ${result.questionId}`);
      }
    } else {
      throw new GenerationResponseValidationError(`Invalid result status for ${result.questionId}`);
    }
  }

  if (seenIds.size !== expectedIdSet.size) {
    throw new GenerationResponseValidationError('Generation results must be exhaustive.');
  }

  return response as unknown as GenerationResponse;
}

export function validateGenerationResponse(
  response: unknown,
  form: Form,
  expectedCycleId: string,
): QuestionResult[] {
  const validResponse = validateResponseShape(response, expectedCycleId, form.questions);
  const resultsById = new Map<string, GenerationResult>(
    validResponse.results.map((result) => [result.questionId, result]),
  );

  return form.questions.map((question): QuestionResult => {
    if (!question.supported) {
      return {
        questionId: question.id,
        status: 'unsupported',
        answer: null,
        reason: question.unsupportedReason,
      };
    }

    const questionId = question.id as string;
    const result = resultsById.get(questionId) as GenerationResult;
    if (result.status === 'GENERATION_FAILED') {
      return {
        questionId,
        status: 'GENERATION_FAILED',
        answer: null,
        reason: result.failure.message,
      };
    }

    if (result.status === 'ABSTAINED') {
      return {
        questionId,
        status: 'ABSTAINED',
        answer: null,
        reason: result.reason,
      };
    }

    if (!isValidAnswer(question, result.answer.value)) {
      return {
        questionId,
        status: 'VALIDATION_FAILED',
        answer: null,
        reason: 'Generated answer does not match the question contract.',
      };
    }

    return {
      questionId,
      status: 'GENERATED',
      answer: { questionId, value: result.answer.value },
      reason: null,
    };
  });
}
