import { GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { createGeminiConfig } from '../src/Ai/Config';
import {
  GeminiProvider,
  type GeminiGenerateRequest,
  type GeminiTransport,
} from '../src/Ai/GeminiProvider';
import type { GenerationRequest } from '../src/Models/Generation';

const request: GenerationRequest = {
  cycleId: 'cycle-gemini',
  pageId: 'page-1',
  questions: [
    {
      questionId: 'language',
      text: 'Which language?',
      type: 'single-choice',
      required: true,
      options: ['TypeScript', 'JavaScript'],
    },
    {
      questionId: 'topics',
      text: 'Which topics?',
      type: 'multiple-choice',
      required: false,
      options: ['Testing', 'Accessibility'],
    },
  ],
  settledContext: [],
};

function transport(response: string | undefined): GeminiTransport & { request?: GeminiGenerateRequest } {
  const value: GeminiTransport & { request?: GeminiGenerateRequest } = {
    generateContent: async (generationRequest) => {
      value.request = generationRequest;
      return { text: response };
    },
  };
  return value;
}

function provider(response: unknown): GeminiProvider {
  return new GeminiProvider(
    { apiKey: 'test-secret', model: 'test-model', timeoutMs: 25 },
    transport(typeof response === 'string' ? response : JSON.stringify(response)),
  );
}

function validProviderOutput() {
  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) => ({
      questionId: question.questionId,
      status: 'GENERATED' as const,
      answer: {
        questionId: question.questionId,
        value: question.type === 'multiple-choice' ? ['Testing'] : 'TypeScript',
      },
    })),
  };
}

async function actualSdkConnectionError(): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw Object.assign(new TypeError('fetch failed'), { name: 'ConnectionError' });
  }));
  try {
    const client = new GoogleGenAI({
      apiKey: 'synthetic-key',
      httpOptions: { retryOptions: { attempts: 1 } },
    });
    await client.models.generateContent({
      model: 'synthetic-model',
      contents: 'synthetic request',
      config: { httpOptions: { retryOptions: { attempts: 1 } } },
    });
    throw new Error('The synthetic SDK request unexpectedly succeeded.');
  } catch (error) {
    return error;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('GeminiProvider', () => {
  it('returns valid generated output and builds a backend-owned request', async () => {
    const response = await provider(validProviderOutput()).generate(request);

    expect(response.results.every((result) => result.status === 'GENERATED')).toBe(true);
  });

  it('rejects duplicate, missing, and wrong-cycle results through provider validation', async () => {
    const duplicate = validProviderOutput();
    duplicate.results[1] = { ...duplicate.results[0] };
    const missing = validProviderOutput();
    missing.results = missing.results.slice(0, 1);
    const wrongCycle = validProviderOutput();
    wrongCycle.cycleId = 'different-cycle';

    for (const output of [duplicate, missing, wrongCycle]) {
      const response = await provider(output).generate(request);
      expect(response.results.every((result) => result.status === 'GENERATION_FAILED')).toBe(true);
      expect(response.results[0].failure.code).toBe('INVALID_PROVIDER_OUTPUT');
    }
  });

  it('rejects invalid answer types and invalid abstention combinations', async () => {
    const invalidAnswer = validProviderOutput();
    invalidAnswer.results[0] = {
      questionId: 'language',
      status: 'GENERATED',
      answer: { questionId: 'language', value: ['TypeScript'] },
    };
    const invalidReason = validProviderOutput();
    invalidReason.results[0] = {
      questionId: 'language',
      status: 'ABSTAINED',
      answer: null,
      reason: 'INVALID_REASON' as never,
    };
    const nonNullAbstention = validProviderOutput();
    nonNullAbstention.results[0] = {
      questionId: 'language',
      status: 'ABSTAINED',
      answer: { questionId: 'language', value: 'TypeScript' } as never,
      reason: 'LOW_CONFIDENCE',
    };

    for (const output of [invalidAnswer, invalidReason, nonNullAbstention]) {
      const response = await provider(output).generate(request);
      expect(response.results.every((result) => result.status === 'GENERATION_FAILED')).toBe(true);
      expect(response.results[0].failure.code).toBe('INVALID_PROVIDER_OUTPUT');
    }
  });

  it('passes model, structured output, timeout, and no-retry settings to Gemini', async () => {
    let capturedRequest: GeminiGenerateRequest | undefined;
    const capturingTransport: GeminiTransport = {
      generateContent: async (generationRequest) => {
        capturedRequest = generationRequest;
        return { text: JSON.stringify(validProviderOutput()) };
      },
    };

    await new GeminiProvider(
      { apiKey: 'test-secret', model: 'configured-model', timeoutMs: 1234 },
      capturingTransport,
    ).generate(request);

    expect(capturedRequest).toMatchObject({
      model: 'configured-model',
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: expect.objectContaining({ type: 'object', required: ['cycleId', 'results'] }),
        httpOptions: { timeout: 1234, retryOptions: { attempts: 1 } },
      },
    });
  });

  it.each(['LOW_CONFIDENCE', 'UNABLE_TO_DETERMINE', 'NOT_APPLICABLE'] as const)(
    'accepts %s abstention',
    async (reason) => {
      const response = await provider({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'ABSTAINED',
          answer: null,
          reason,
        })),
      }).generate(request);
      expect(response.results.every((result) => result.status === 'ABSTAINED')).toBe(true);
    },
  );

  it('converts malformed, invalid, and wrong-choice output to sanitized failures', async () => {
    const malformed = await provider('{').generate(request);
    expect(malformed.results[0]).toMatchObject({ status: 'GENERATION_FAILED', failure: { code: 'MALFORMED_PROVIDER_OUTPUT' } });

    const invalid = await provider({
      cycleId: request.cycleId,
      results: [{
        questionId: 'unknown',
        status: 'GENERATED',
        answer: { questionId: 'unknown', value: 'Nope' },
      }],
    }).generate(request);
    expect(invalid.results[0]).toMatchObject({ status: 'GENERATION_FAILED', failure: { code: 'INVALID_PROVIDER_OUTPUT' } });

    const wrongChoice = await provider({
      cycleId: request.cycleId,
      results: request.questions.map((question) => ({
        questionId: question.questionId,
        status: 'GENERATED',
        answer: { questionId: question.questionId, value: 'Invented option' },
      })),
    }).generate(request);
    expect(wrongChoice.results[0]).toMatchObject({ status: 'GENERATION_FAILED', failure: { code: 'INVALID_PROVIDER_OUTPUT' } });
  });

  it('maps an actual SDK connection-classified failure to NETWORK_ERROR', async () => {
    const sdkError = await actualSdkConnectionError();
    expect(sdkError).toBeInstanceOf(Error);
    expect((sdkError as Error).name).toBe('ConnectionError');
    expect((sdkError as Error).constructor.name).not.toBe('ConnectionError');

    const response = await new GeminiProvider(
      { apiKey: 'test-secret', model: 'test-model', timeoutMs: 25 },
      { generateContent: async () => { throw sdkError; } },
    ).generate(request);

    expect(response.results[0]).toMatchObject({
      status: 'GENERATION_FAILED',
      failure: { code: 'NETWORK_ERROR' },
    });
    expect(JSON.stringify(response)).not.toContain('synthetic-key');
  });

  it.each([
    [{ status: 401 }, 'AUTHENTICATION_FAILED'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [new TypeError('network'), 'NETWORK_ERROR'],
    [new Error('provider'), 'PROVIDER_ERROR'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'TIMEOUT'],
  ] as const)('sanitizes provider failure %s', async (error, code) => {
    const failingTransport: GeminiTransport = {
      generateContent: async () => { throw error; },
    };
    const response = await new GeminiProvider(
      { apiKey: 'test-secret', model: 'test-model', timeoutMs: 25 },
      failingTransport,
    ).generate(request);
    expect(response.results[0]).toMatchObject({ status: 'GENERATION_FAILED', failure: { code } });
    expect(JSON.stringify(response)).not.toContain('test-secret');
  });

  it('validates required environment configuration without reading a key value', () => {
    expect(() => createGeminiConfig({ GEMINI_MODEL: 'test-model' })).toThrow('GEMINI_API_KEY is required');
    expect(() => createGeminiConfig({ GEMINI_API_KEY: 'test-secret' })).toThrow('GEMINI_MODEL is required');
    expect(createGeminiConfig({ GEMINI_API_KEY: 'test-secret', GEMINI_MODEL: 'test-model', GEMINI_TIMEOUT_MS: '10' })).toEqual({
      apiKey: 'test-secret',
      model: 'test-model',
      timeoutMs: 10,
    });
  });
});