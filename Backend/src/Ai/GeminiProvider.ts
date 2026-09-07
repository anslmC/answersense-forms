import { GoogleGenAI } from '@google/genai';
import { GenerationRequestSchema, GenerationResponseSchema } from '../Models/Schemas.js';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../Models/Generation.js';
import type { GeminiConfig } from './Config.js';

export interface GeminiGenerateRequest {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: 'application/json';
    responseJsonSchema: Record<string, unknown>;
    httpOptions: { timeout: number; retryOptions: { attempts: 1 } };
  };
}

export interface GeminiTransport {
  generateContent(request: GeminiGenerateRequest): Promise<{ text?: string }>;
}

const responseJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    cycleId: { type: 'string' },
    results: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['GENERATED'] },
              answer: {
                type: 'object',
                properties: {
                  questionId: { type: 'string' },
                  value: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } },
                    ],
                  },
                },
                required: ['questionId', 'value'],
              },
            },
            required: ['questionId', 'status', 'answer'],
          },
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['ABSTAINED'] },
              answer: { type: 'null' },
              reason: {
                type: 'string',
                enum: ['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE'],
              },
            },
            required: ['questionId', 'status', 'answer', 'reason'],
          },
          {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              status: { type: 'string', enum: ['GENERATION_FAILED'] },
              answer: { type: 'null' },
              failure: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
              },
            },
            required: ['questionId', 'status', 'answer', 'failure'],
          },
        ],
      },
    },
  },
  required: ['cycleId', 'results'],
};

const systemInstruction = [
  'Return only the required JSON object; never return explanatory prose.',
  'Answer only the supplied questions and preserve every questionId exactly.',
  'Return exactly one result for every supplied question.',
  'Respect each supplied question type and required state.',
  'For choice questions, use only the supplied option values and never invent options.',
  'Use a string for single-value answers and a string array for multiple-choice answers.',
  'Abstain when a valid answer cannot responsibly be determined.',
  'Use only LOW_CONFIDENCE, UNABLE_TO_DETERMINE, or NOT_APPLICABLE for abstention.',
].join(' ');

function buildPrompt(request: GenerationRequest): string {
  return JSON.stringify({
    task: 'Generate answers for the supplied questions.',
    cycleId: request.cycleId,
    questions: request.questions,
    settledContext: request.settledContext,
  });
}

function failureResponse(
  request: GenerationRequest,
  code: string,
  message: string,
): GenerationResponse {
  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) => ({
      questionId: question.questionId,
      status: 'GENERATION_FAILED' as const,
      answer: null,
      failure: { code, message },
    })),
  };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isGeminiConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'ConnectionError') {
    return true;
  }
  return 'cause' in error && isGeminiConnectionError(error.cause);
}

function classifyProviderError(error: unknown): { code: string; message: string } {
  const status = errorStatus(error);
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code).toLowerCase()
    : '';

  if (status === 401 || status === 403) {
    return { code: 'AUTHENTICATION_FAILED', message: 'Gemini authentication failed.' };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: 'Gemini rate limit was reached.' };
  }
  if (name.includes('timeout') || code === 'etimedout' || code === 'timeout') {
    return { code: 'TIMEOUT', message: 'Gemini generation timed out.' };
  }
  if (isGeminiConnectionError(error) || error instanceof TypeError || code === 'econnreset' || code === 'enotfound') {
    return { code: 'NETWORK_ERROR', message: 'Gemini network request failed.' };
  }
  return { code: 'PROVIDER_ERROR', message: 'Gemini generation failed.' };
}

function validateProviderResponse(
  request: GenerationRequest,
  response: unknown,
): GenerationResponse {
  const parsed = GenerationResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.cycleId !== request.cycleId) {
    throw new Error('Invalid Gemini generation response.');
  }

  const questionsById = new Map(request.questions.map((question) => [question.questionId, question]));
  const resultIds = new Set<string>();
  if (parsed.data.results.length !== request.questions.length) {
    throw new Error('Invalid Gemini generation response.');
  }

  for (const result of parsed.data.results) {
    const question = questionsById.get(result.questionId);
    if (!question || resultIds.has(result.questionId)) {
      throw new Error('Invalid Gemini generation response.');
    }
    resultIds.add(result.questionId);

    if (result.status !== 'GENERATED') {
      continue;
    }
    const value = result.answer.value;
    if (question.type === 'multiple-choice') {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((item) => !question.options.includes(item))) {
        throw new Error('Invalid Gemini generation response.');
      }
    } else if (question.type === 'single-choice') {
      if (typeof value !== 'string' || !question.options.includes(value)) {
        throw new Error('Invalid Gemini generation response.');
      }
    } else if (typeof value !== 'string') {
      throw new Error('Invalid Gemini generation response.');
    }
  }

  return parsed.data;
}

function createSdkTransport(config: GeminiConfig): GeminiTransport {
  const client = new GoogleGenAI({ apiKey: config.apiKey });
  return {
    generateContent: (request) => client.models.generateContent(request),
  };
}

export class GeminiProvider implements GenerationInterface {
  constructor(
    private readonly config: GeminiConfig,
    private readonly transport: GeminiTransport = createSdkTransport(config),
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const validRequest = GenerationRequestSchema.parse(request);
    try {
      const response = await this.transport.generateContent({
        model: this.config.model,
        contents: buildPrompt(validRequest),
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema,
          httpOptions: {
            timeout: this.config.timeoutMs,
            retryOptions: { attempts: 1 },
          },
        },
      });
      if (!response.text) {
        return failureResponse(validRequest, 'MALFORMED_PROVIDER_OUTPUT', 'Gemini returned no structured output.');
      }

      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(response.text);
      } catch {
        return failureResponse(validRequest, 'MALFORMED_PROVIDER_OUTPUT', 'Gemini returned malformed JSON.');
      }

      try {
        return validateProviderResponse(validRequest, parsedOutput);
      } catch {
        return failureResponse(validRequest, 'INVALID_PROVIDER_OUTPUT', 'Gemini returned an invalid generation response.');
      }
    } catch (error) {
      const failure = classifyProviderError(error);
      return failureResponse(validRequest, failure.code, failure.message);
    }
  }
}

export function createGeminiProvider(config: GeminiConfig): GenerationInterface {
  return new GeminiProvider(config);
}

export { buildPrompt, responseJsonSchema, systemInstruction, validateProviderResponse };
