import type { GenerationQuestion, GenerationRequest } from './Contract';
import {
  DEFAULT_NVIDIA_MEASUREMENT_PROFILE,
  measureNvidiaRequest,
  type NvidiaGenerationRequest,
  type NvidiaPayloadProfile,
  type NvidiaSamePageContextItem,
} from './NvidiaRequest';

export interface NvidiaBatchLimits {
  readonly maxQuestionsPerBatch: number;
  readonly maxEstimatedInputTokens: number;

  /** Planning estimate only; provider max_tokens remains model-specific. */
  readonly maxEstimatedOutputTokens: number;

  readonly maxSerializedBytes: number;
}

export const DEFAULT_NVIDIA_BATCH_LIMITS: NvidiaBatchLimits = Object.freeze({
  maxQuestionsPerBatch: 10,
  maxEstimatedInputTokens: 12_000,
  maxEstimatedOutputTokens: 4_000,
  maxSerializedBytes: 48_000,
});

export interface NvidiaBatchPlanningOptions {
  readonly payloadProfile?: NvidiaPayloadProfile;
  readonly reasoningTokenReserve?: number;
}

export interface NvidiaQuestionBatch {
  readonly index: number;
  readonly questions: readonly GenerationQuestion[];
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly serializedBytes: number;
}

export class NvidiaBatchLimitError extends Error {
  constructor(
    public readonly reason: 'QUESTION' | 'CONTEXT',
    public readonly questionIds: readonly string[]
  ) {
    super('NVIDIA request exceeds configured batch limits.');
    this.name = 'NvidiaBatchLimitError';
  }
}

const RESULT_OVERHEAD_TOKENS = 32;
const NUMBERED_REFERENCE_PATTERN = /\bquestions?\s*[-_#]?\s*(\d{1,4})\b/gi;
const SHORT_REFERENCE_PATTERN = /\bq\s*[-_#]?\s*(\d{1,4})\b/gi;
const HASH_REFERENCE_PATTERN = /(?:^|\s)#\s*(\d{1,4})\b/g;
const PREVIOUS_REFERENCE_PATTERN =
  /\b(?:previous|preceding|above|prior)\s+question\b/i;
const NEXT_REFERENCE_PATTERN = /\b(?:next|following|below)\s+question\b/i;
const QUESTION_ABOVE_PATTERN = /\bquestion\s+(?:above|before|prior)\b/i;
const QUESTION_BELOW_PATTERN = /\bquestion\s+(?:below|after|next|following)\b/i;

function normalizeLimit(value: number): number {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeReasoningTokenReserve(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

export function normalizeNvidiaBatchLimits(
  limits: NvidiaBatchLimits
): NvidiaBatchLimits {
  return {
    maxQuestionsPerBatch: normalizeLimit(limits.maxQuestionsPerBatch),
    maxEstimatedInputTokens: normalizeLimit(limits.maxEstimatedInputTokens),
    maxEstimatedOutputTokens: normalizeLimit(limits.maxEstimatedOutputTokens),
    maxSerializedBytes: normalizeLimit(limits.maxSerializedBytes),
  };
}

export function isNvidiaBatchWithinLimits(
  batch: NvidiaQuestionBatch,
  limits: NvidiaBatchLimits
): boolean {
  const normalized = normalizeNvidiaBatchLimits(limits);
  return (
    batch.questions.length <= normalized.maxQuestionsPerBatch &&
    batch.estimatedInputTokens <= normalized.maxEstimatedInputTokens &&
    batch.estimatedOutputTokens <= normalized.maxEstimatedOutputTokens &&
    batch.serializedBytes <= normalized.maxSerializedBytes
  );
}

function estimateQuestionOutputTokens(question: GenerationQuestion): number {
  const answerParts = Math.max(1, question.answerParts ?? 1);
  if (question.type === 'single-choice') {
    return 32;
  }
  if (question.type === 'multiple-choice') {
    return 64;
  }
  if (question.type === 'short-text') {
    return 64;
  }
  return 192 + (answerParts - 1) * 64;
}

function questionByReferenceNumber(
  questions: readonly GenerationQuestion[],
  number: number,
  current: GenerationQuestion
): GenerationQuestion | undefined {
  const idVariants = new Set([
    String(number),
    `q${number}`,
    `q-${number}`,
    `q_${number}`,
    `question-${number}`,
    `question_${number}`,
  ]);
  const byId = questions.find(
    (question) =>
      question !== current && idVariants.has(question.questionId.toLowerCase())
  );
  if (byId) {
    return byId;
  }
  const byIndex = questions[number - 1];
  return byIndex !== current ? byIndex : undefined;
}

function referencedQuestions(
  question: GenerationQuestion,
  questions: readonly GenerationQuestion[]
): GenerationQuestion[] {
  const currentIndex = questions.indexOf(question);
  if (currentIndex < 0) {
    return [];
  }

  const referenced = new Set<GenerationQuestion>();
  for (const pattern of [
    NUMBERED_REFERENCE_PATTERN,
    SHORT_REFERENCE_PATTERN,
    HASH_REFERENCE_PATTERN,
  ]) {
    for (const match of question.text.matchAll(pattern)) {
      const number = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isSafeInteger(number)) {
        continue;
      }
      const target = questionByReferenceNumber(questions, number, question);
      if (target) {
        referenced.add(target);
      }
    }
  }

  if (
    currentIndex > 0 &&
    (PREVIOUS_REFERENCE_PATTERN.test(question.text) ||
      QUESTION_ABOVE_PATTERN.test(question.text))
  ) {
    referenced.add(questions[currentIndex - 1]);
  }
  if (
    currentIndex < questions.length - 1 &&
    (NEXT_REFERENCE_PATTERN.test(question.text) ||
      QUESTION_BELOW_PATTERN.test(question.text))
  ) {
    referenced.add(questions[currentIndex + 1]);
  }

  return questions.filter((candidate) => referenced.has(candidate));
}

export function buildNvidiaSamePageContext(
  request: GenerationRequest,
  batchQuestions: readonly GenerationQuestion[]
): NvidiaSamePageContextItem[] {
  if (batchQuestions.length === 0) {
    return [];
  }

  const batchIds = new Set(
    batchQuestions.map((question) => question.questionId)
  );
  const referencedIds = new Set<string>();
  for (const question of batchQuestions) {
    for (const referenced of referencedQuestions(question, request.questions)) {
      if (!batchIds.has(referenced.questionId)) {
        referencedIds.add(referenced.questionId);
      }
    }
  }

  return request.questions.flatMap((question) => {
    if (!referencedIds.has(question.questionId)) {
      return [];
    }
    return [
      {
        questionId: question.questionId,
        questionText: question.text,
        type: question.type,
        options: [...question.options],
        ...(question.answerParts === undefined
          ? {}
          : { answerParts: question.answerParts }),
      },
    ];
  });
}

function estimateBatch(
  request: GenerationRequest,
  questions: readonly GenerationQuestion[],
  profile: NvidiaPayloadProfile,
  reasoningTokenReserve: number
): Pick<
  NvidiaQuestionBatch,
  'estimatedInputTokens' | 'estimatedOutputTokens' | 'serializedBytes'
> {
  const measurementRequest: NvidiaGenerationRequest = {
    ...request,
    questions: [...questions],
    samePageContext: buildNvidiaSamePageContext(request, questions),
  };
  const answerOutputTokens = questions.reduce(
    (total, question) =>
      total + estimateQuestionOutputTokens(question) + RESULT_OVERHEAD_TOKENS,
    0
  );
  return {
    ...measureNvidiaRequest(measurementRequest, profile),
    estimatedOutputTokens:
      questions.length === 0
        ? 0
        : answerOutputTokens +
          normalizeReasoningTokenReserve(reasoningTokenReserve),
  };
}

export function createNvidiaQuestionBatch(
  request: GenerationRequest,
  questions: readonly GenerationQuestion[],
  index: number,
  options: NvidiaBatchPlanningOptions = {}
): NvidiaQuestionBatch {
  if (questions.length === 0) {
    throw new Error('NVIDIA batches must contain at least one question.');
  }
  const profile = options.payloadProfile ?? DEFAULT_NVIDIA_MEASUREMENT_PROFILE;
  return {
    index,
    questions: [...questions],
    ...estimateBatch(
      request,
      questions,
      profile,
      options.reasoningTokenReserve ?? 0
    ),
  };
}

function assertBatchFits(
  estimate: {
    readonly estimatedInputTokens: number;
    readonly estimatedOutputTokens: number;
    readonly serializedBytes: number;
  },
  limits: NvidiaBatchLimits,
  questionIds: readonly string[],
  reason: 'QUESTION' | 'CONTEXT'
): void {
  if (
    estimate.estimatedInputTokens > limits.maxEstimatedInputTokens ||
    estimate.estimatedOutputTokens > limits.maxEstimatedOutputTokens ||
    estimate.serializedBytes > limits.maxSerializedBytes
  ) {
    throw new NvidiaBatchLimitError(reason, questionIds);
  }
}

function assertOversizedInputsAbsent(
  request: GenerationRequest,
  limits: NvidiaBatchLimits,
  profile: NvidiaPayloadProfile,
  reasoningTokenReserve: number
): void {
  const contextOnly = estimateBatch(request, [], profile, 0);
  if (
    contextOnly.estimatedInputTokens > limits.maxEstimatedInputTokens ||
    contextOnly.serializedBytes > limits.maxSerializedBytes
  ) {
    throw new NvidiaBatchLimitError('CONTEXT', []);
  }

  for (const question of request.questions) {
    const singleQuestion = estimateBatch(
      request,
      [question],
      profile,
      reasoningTokenReserve
    );
    assertBatchFits(singleQuestion, limits, [question.questionId], 'QUESTION');
  }
}

export function planNvidiaBatches(
  request: GenerationRequest,
  limits: NvidiaBatchLimits = DEFAULT_NVIDIA_BATCH_LIMITS,
  options: NvidiaBatchPlanningOptions = {}
): NvidiaQuestionBatch[] {
  if (request.questions.length === 0) {
    return [];
  }

  const normalizedLimits = normalizeNvidiaBatchLimits(limits);
  const profile = options.payloadProfile ?? DEFAULT_NVIDIA_MEASUREMENT_PROFILE;
  const reasoningTokenReserve = normalizeReasoningTokenReserve(
    options.reasoningTokenReserve
  );
  assertOversizedInputsAbsent(
    request,
    normalizedLimits,
    profile,
    reasoningTokenReserve
  );

  const batches: NvidiaQuestionBatch[] = [];
  let currentQuestions: GenerationQuestion[] = [];

  const pushCurrentBatch = () => {
    if (currentQuestions.length === 0) {
      return;
    }
    batches.push(
      createNvidiaQuestionBatch(request, currentQuestions, batches.length, {
        payloadProfile: profile,
        reasoningTokenReserve,
      })
    );
    currentQuestions = [];
  };

  for (const question of request.questions) {
    const candidate = [...currentQuestions, question];
    const estimate = estimateBatch(
      request,
      candidate,
      profile,
      reasoningTokenReserve
    );
    const exceedsLimits =
      currentQuestions.length > 0 &&
      (candidate.length > normalizedLimits.maxQuestionsPerBatch ||
        estimate.estimatedInputTokens >
          normalizedLimits.maxEstimatedInputTokens ||
        estimate.estimatedOutputTokens >
          normalizedLimits.maxEstimatedOutputTokens ||
        estimate.serializedBytes > normalizedLimits.maxSerializedBytes);

    if (exceedsLimits) {
      pushCurrentBatch();
      currentQuestions = [question];
    } else {
      currentQuestions = candidate;
    }
  }

  pushCurrentBatch();
  return batches;
}

export function createNvidiaBatchRequest(
  request: GenerationRequest,
  batch: NvidiaQuestionBatch
): NvidiaGenerationRequest {
  const samePageContext = buildNvidiaSamePageContext(request, batch.questions);
  return {
    cycleId: request.cycleId,
    pageId: request.pageId,
    questions: batch.questions.map((question) => ({
      ...question,
      options: [...question.options],
    })),
    settledContext: request.settledContext,
    ...(samePageContext.length > 0 ? { samePageContext } : {}),
  };
}
