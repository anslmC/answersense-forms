import type {
  GenerationAbstentionReason,
  GenerationQuestion,
  GenerationRequest,
  GenerationResult,
} from './Contract';
import { resolveAnswerParts, splitAnswerParts } from './AnswerParts';

const ABSTENTION_REASONS = new Set<GenerationAbstentionReason>([
  'LOW_CONFIDENCE',
  'UNABLE_TO_DETERMINE',
  'NOT_APPLICABLE',
]);
const MAX_FAILURE_MESSAGE_LENGTH = 512;
const MAX_FAILURE_CODE_LENGTH = 128;
const CYCLE_ID_PATTERN = /"cycleId"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export type GeminiSalvageExtractionOutcome =
  'NOT_ATTEMPTED' | 'DIRECT' | 'MARKDOWN_FENCE' | 'EMBEDDED' | 'FAILED';

export type GeminiSalvageRejectionCode =
  'WRONG_CYCLE' | 'API_KEY_ECHO' | 'UNPARSEABLE';

export interface GeminiSalvageRejection {
  readonly code: GeminiSalvageRejectionCode;
  readonly message: string;
}

export interface GeminiSalvageResult {
  readonly results: readonly GenerationResult[];
  readonly rejected: GeminiSalvageRejection | null;
  readonly extractionOutcome: GeminiSalvageExtractionOutcome;
  readonly candidateCount: number;
  readonly missingQuestionIds: readonly string[];
  readonly invalidQuestionIds: readonly string[];
  readonly duplicateQuestionIds: readonly string[];
  readonly unknownQuestionIds: readonly string[];
  readonly ignoredResultCount: number;
  readonly hasUsableResult: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function boundedText(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length > maximum
    ? `${trimmed.slice(0, maximum - 3).trimEnd()}...`
    : trimmed;
}

function decodeJsonString(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(`"${raw}"`);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function extractCycleIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CYCLE_ID_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const decoded = decodeJsonString(raw);
    if (decoded !== null) {
      ids.add(decoded);
    }
  }
  return [...ids];
}

function collectBalancedObjectTexts(text: string): string[] {
  const objects: string[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      starts.push(index);
      continue;
    }
    if (character === '}' && starts.length > 0) {
      const start = starts.pop();
      if (start !== undefined) {
        objects.push(text.slice(start, index + 1));
      }
    }
  }

  return objects;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectParsedObjects(text: string): Record<string, unknown>[] {
  return collectBalancedObjectTexts(text).flatMap((candidate) => {
    const parsed = parseRecord(candidate);
    return parsed ? [parsed] : [];
  });
}

function answerValueForQuestion(
  question: GenerationQuestion,
  value: unknown
): string | string[] | null {
  if (typeof value !== 'string' && !isStringArray(value)) {
    return null;
  }

  if (question.type === 'short-text' || question.type === 'paragraph') {
    const answerParts = resolveAnswerParts({
      text: question.text,
      answerParts: question.answerParts,
    });
    if (Array.isArray(value)) {
      if (answerParts < 2) {
        return null;
      }
      const parts = value.map((part) => part.trim()).filter(Boolean);
      return parts.length >= answerParts ? [...value] : null;
    }
    if (answerParts < 2) {
      return value;
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
  if (question.type === 'single-choice') {
    return typeof value === 'string' && options.has(value) ? value : null;
  }
  return null;
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
    return {
      questionId: question.questionId,
      status: 'GENERATED',
      answer: {
        questionId: question.questionId,
        value: Array.isArray(value) ? [...value] : value,
      },
    };
  }

  if (result.status === 'ABSTAINED') {
    const reason = result.reason;
    if (
      result.answer !== null ||
      typeof reason !== 'string' ||
      !ABSTENTION_REASONS.has(reason as GenerationAbstentionReason)
    ) {
      return null;
    }
    return {
      questionId: question.questionId,
      status: 'ABSTAINED',
      answer: null,
      reason: reason as GenerationAbstentionReason,
    };
  }

  if (result.status === 'GENERATION_FAILED') {
    if (result.answer !== null || !isRecord(result.failure)) {
      return null;
    }
    const code = result.failure.code;
    const message = result.failure.message;
    if (typeof code !== 'string' || typeof message !== 'string') {
      return null;
    }
    const safeCode = boundedText(code, MAX_FAILURE_CODE_LENGTH);
    if (safeCode.length === 0) {
      return null;
    }
    return {
      questionId: question.questionId,
      status: 'GENERATION_FAILED',
      answer: null,
      failure: {
        code: safeCode,
        message: boundedText(message, MAX_FAILURE_MESSAGE_LENGTH),
      },
    };
  }

  return null;
}

function emptySalvage(
  rejection: GeminiSalvageRejection,
  extractionOutcome: GeminiSalvageExtractionOutcome = 'FAILED'
): GeminiSalvageResult {
  return {
    results: [],
    rejected: rejection,
    extractionOutcome,
    candidateCount: 0,
    missingQuestionIds: [],
    invalidQuestionIds: [],
    duplicateQuestionIds: [],
    unknownQuestionIds: [],
    ignoredResultCount: 0,
    hasUsableResult: false,
  };
}

/**
 * Salvages every independently valid result from a Gemini text response.
 *
 * The response may be complete, fenced, embedded in prose, or truncated. The
 * cycle ID and API-key echo are checked before any result is accepted. Unknown
 * and duplicate IDs are ignored without invalidating unrelated results.
 */
export function salvageGeminiResponse(
  text: string,
  request: GenerationRequest,
  apiKey: string
): GeminiSalvageResult {
  if (apiKey.length > 0 && text.includes(apiKey)) {
    return emptySalvage({
      code: 'API_KEY_ECHO',
      message: 'Provider returned an unsafe response.',
    });
  }

  const direct = parseRecord(text.trim());
  const directCycleId =
    direct && typeof direct.cycleId === 'string' ? direct.cycleId : null;
  const cycleIds = [
    ...new Set([
      ...extractCycleIds(text),
      ...(directCycleId === null ? [] : [directCycleId]),
    ]),
  ];
  if (cycleIds.length === 0) {
    return emptySalvage({
      code: 'UNPARSEABLE',
      message: 'Provider response did not include a valid generation cycle.',
    });
  }
  if (cycleIds.some((cycleId) => cycleId !== request.cycleId)) {
    return emptySalvage({
      code: 'WRONG_CYCLE',
      message: 'Provider returned a response for a different generation cycle.',
    });
  }

  let rawResults: unknown[] = [];
  let extractionOutcome: GeminiSalvageExtractionOutcome = 'FAILED';
  let candidateCount = 0;

  if (direct && Array.isArray(direct.results)) {
    rawResults = direct.results;
    extractionOutcome = 'DIRECT';
    candidateCount = 1;
  } else {
    const objects = collectParsedObjects(text);
    const generationCandidates = objects.filter(
      (object) =>
        Array.isArray(object.results) && object.cycleId === request.cycleId
    );
    candidateCount = generationCandidates.length;
    if (generationCandidates.length > 1) {
      return emptySalvage({
        code: 'UNPARSEABLE',
        message: 'Provider response contained multiple generation objects.',
      });
    }
    if (generationCandidates.length === 1) {
      rawResults = generationCandidates[0].results as unknown[];
      extractionOutcome = 'EMBEDDED';
    } else {
      const resultObjects = objects.filter(
        (object) =>
          typeof object.questionId === 'string' &&
          typeof object.status === 'string'
      );
      rawResults = resultObjects;
      extractionOutcome = resultObjects.length > 0 ? 'EMBEDDED' : 'FAILED';
      candidateCount = resultObjects.length > 0 ? 1 : 0;
    }
  }

  const expected = new Map(
    request.questions.map((question) => [question.questionId, question])
  );
  const resultsById = new Map<string, GenerationResult>();
  const invalidIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const unknownIds = new Set<string>();
  let ignoredResultCount = 0;

  for (const rawResult of rawResults) {
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
      ignoredResultCount += 1;
      continue;
    }
    if (resultsById.has(questionId)) {
      duplicateIds.add(questionId);
      ignoredResultCount += 1;
      continue;
    }
    const canonical = canonicalResultForQuestion(rawResult, question);
    if (!canonical) {
      invalidIds.add(questionId);
      ignoredResultCount += 1;
      continue;
    }
    invalidIds.delete(questionId);
    resultsById.set(questionId, canonical);
  }

  const results = request.questions.flatMap((question) => {
    const result = resultsById.get(question.questionId);
    return result ? [result] : [];
  });

  return {
    results,
    rejected: null,
    extractionOutcome,
    candidateCount,
    missingQuestionIds: request.questions.flatMap((question) =>
      resultsById.has(question.questionId) ||
      invalidIds.has(question.questionId)
        ? []
        : [question.questionId]
    ),
    invalidQuestionIds: request.questions.flatMap((question) =>
      invalidIds.has(question.questionId) ? [question.questionId] : []
    ),
    duplicateQuestionIds: request.questions.flatMap((question) =>
      duplicateIds.has(question.questionId) ? [question.questionId] : []
    ),
    unknownQuestionIds: [...unknownIds],
    ignoredResultCount,
    hasUsableResult: results.length > 0,
  };
}
