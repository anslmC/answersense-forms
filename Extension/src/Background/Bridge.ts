import type { GenerationRequest, GenerationResponse } from '../Generation/Contract';

export const BACKEND_GENERATE_URL = 'http://127.0.0.1:3000/generate';

export type BridgeErrorCode =
  | 'UNSUPPORTED_PAGE'
  | 'DISCOVERY_FAILED'
  | 'GENERATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'FILL_FAILED'
  | 'NAVIGATION_FAILED'
  | 'STALE_OPERATION';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnswerValue(value: unknown): value is string | string[] {
  return typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function parseGenerationResponse(value: unknown): GenerationResponse {
  if (!isRecord(value) || typeof value.cycleId !== 'string' || !Array.isArray(value.results)) {
    throw new Error('Backend returned an invalid generation response.');
  }

  const questionIds = new Set<string>();
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.questionId !== 'string' || questionIds.has(result.questionId)) {
      throw new Error('Backend returned an invalid generation response.');
    }
    questionIds.add(result.questionId);

    if (result.status === 'GENERATED') {
      if (!isRecord(result.answer) || result.answer.questionId !== result.questionId || !isAnswerValue(result.answer.value)) {
        throw new Error('Backend returned an invalid generation response.');
      }
    } else if (result.status === 'ABSTAINED') {
      if (result.answer !== null || !['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE'].includes(String(result.reason))) {
        throw new Error('Backend returned an invalid generation response.');
      }
    } else if (result.status === 'GENERATION_FAILED') {
      if (
        result.answer !== null ||
        !isRecord(result.failure) ||
        typeof result.failure.code !== 'string' ||
        typeof result.failure.message !== 'string'
      ) {
        throw new Error('Backend returned an invalid generation response.');
      }
    } else {
      throw new Error('Backend returned an invalid generation response.');
    }
  }

  return value as unknown as GenerationResponse;
}

export async function requestBackendGeneration(
  request: GenerationRequest,
): Promise<GenerationResponse> {
  const response = await fetch(BACKEND_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`Backend generation failed (${response.status}).`);
  }
  return parseGenerationResponse(await response.json());
}
