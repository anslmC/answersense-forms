import { buildAnswerPartsInstructions } from './AnswerParts';
import type { GenerationQuestion, GenerationRequest } from './Contract';
import { systemInstruction } from './SystemInstructions';

export interface NvidiaSamePageContextItem {
  readonly questionId: string;
  readonly questionText: string;
  readonly type: GenerationQuestion['type'];
  readonly options: readonly string[];
  readonly answerParts?: number;
}

export interface NvidiaGenerationRequest extends GenerationRequest {
  readonly samePageContext?: readonly NvidiaSamePageContextItem[];
}

export interface NvidiaPayloadProfile {
  readonly modelId: string;
  readonly maxTokens: number;
  readonly includeResponseFormat: boolean;
  readonly lightning: boolean;
}

export const DEFAULT_NVIDIA_MEASUREMENT_PROFILE: NvidiaPayloadProfile =
  Object.freeze({
    modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    maxTokens: 131072,
    includeResponseFormat: false,
    lightning: false,
  });

export function createNvidiaUserContent(
  request: NvidiaGenerationRequest
): string {
  const answerPartsInstructions = buildAnswerPartsInstructions(
    request.questions
  );
  const samePageContext = request.samePageContext ?? [];
  const taskParts = ['Generate answers for the supplied questions.'];
  if (samePageContext.length > 0) {
    taskParts.push(
      'Use samePageContext only to interpret questions that reference those supplied question IDs.'
    );
  }
  if (answerPartsInstructions.length > 0) {
    taskParts.push(...answerPartsInstructions);
  }

  return JSON.stringify({
    task: taskParts.join(' '),
    cycleId: request.cycleId,
    questions: request.questions,
    ...(samePageContext.length > 0 ? { samePageContext } : {}),
    ...(request.settledContext.length > 0
      ? { settledContext: request.settledContext }
      : {}),
    responseContract: {
      format:
        'Return one JSON object only. Do not include Markdown fences, commentary, reasoning, or <think> tags.',
      requiredTopLevelFields: ['cycleId', 'results'],
      cycleId: 'Copy the nonblank cycleId from this request exactly.',
      results:
        'Return an array with exactly one result for every supplied question. Each questionId must be unique and match one supplied questionId.',
      numberOfResults: request.questions.length,
      responseExample: {
        cycleId: request.cycleId,
        results: [
          {
            questionId: '<supplied questionId>',
            status: 'GENERATED',
            answer: {
              questionId: '<same supplied questionId>',
              value: '<answer value>',
            },
          },
        ],
      },
      resultVariants: {
        GENERATED:
          '{ questionId, status: "GENERATED", answer: { questionId: same questionId, value } }',
        ABSTAINED:
          '{ questionId, status: "ABSTAINED", answer: null, reason: "LOW_CONFIDENCE" | "UNABLE_TO_DETERMINE" | "NOT_APPLICABLE" }',
        GENERATION_FAILED:
          '{ questionId, status: "GENERATION_FAILED", answer: null, failure: { code: string, message: string } }',
      },
      answerRules:
        'short-text and paragraph values must be strings; single-choice values must be one supplied option string; multiple-choice values must be arrays of distinct strings, each matching a supplied option.',
    },
  });
}

export function createNvidiaPayload(
  request: NvidiaGenerationRequest,
  profile: NvidiaPayloadProfile = DEFAULT_NVIDIA_MEASUREMENT_PROFILE
): Record<string, unknown> {
  const reasoningParameters = profile.lightning
    ? { chat_template_kwargs: { enable_thinking: true } }
    : { reasoning_effort: 'low' };
  return {
    model: profile.modelId,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: createNvidiaUserContent(request) },
    ],
    temperature: 1.0,
    top_p: 0.95,
    max_tokens: profile.maxTokens,
    ...reasoningParameters,
    ...(profile.includeResponseFormat
      ? { response_format: { type: 'json_object' } }
      : {}),
    stream: false,
  };
}

export function serializeNvidiaPayload(
  request: NvidiaGenerationRequest,
  profile: NvidiaPayloadProfile = DEFAULT_NVIDIA_MEASUREMENT_PROFILE
): string {
  return JSON.stringify(createNvidiaPayload(request, profile));
}

export function estimateNvidiaRequestTokens(
  serialized: string,
  utf8Bytes = new TextEncoder().encode(serialized).byteLength
): number {
  const tokenEstimate = Math.max(utf8Bytes / 3, serialized.length / 2);
  return Math.ceil(tokenEstimate) + 16;
}

export function measureNvidiaRequest(
  request: NvidiaGenerationRequest,
  profile: NvidiaPayloadProfile = DEFAULT_NVIDIA_MEASUREMENT_PROFILE
): { readonly estimatedInputTokens: number; readonly serializedBytes: number } {
  const serialized = serializeNvidiaPayload(request, profile);
  const serializedBytes = new TextEncoder().encode(serialized).byteLength;
  return {
    estimatedInputTokens: estimateNvidiaRequestTokens(
      serialized,
      serializedBytes
    ),
    serializedBytes,
  };
}
