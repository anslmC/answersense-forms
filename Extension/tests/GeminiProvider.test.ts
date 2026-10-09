import { describe, expect, it, vi } from 'vitest';
import {
  GEMINI_GENERATE_URL,
  GEMINI_MODEL,
  GEMINI_MODEL_INFO_URL,
  GeminiProvider,
  GeminiProviderError,
  responseJsonSchema,
  type GeminiTransport,
} from '../src/Generation/GeminiProvider';
import type { GenerationRequest } from '../src/Generation/Contract';

const request: GenerationRequest = {
  cycleId: 'cycle-provider',
  pageId: 'page-1',
  questions: [
    {
      questionId: 'name',
      text: 'What is your name?',
      type: 'short-text',
      required: false,
      options: [],
    },
  ],
  settledContext: [],
};

function transport(status: number, text?: string): GeminiTransport {
  return {
    generate: async ({ apiKey, body }) => {
      expect(apiKey).toBe('test-key');
      expect(JSON.stringify(body)).toContain('untrusted data');
      return {
        status,
        body: text ? { candidates: [{ content: { parts: [{ text }] } }] } : {},
      };
    },
  };
}

describe('direct Gemini provider', () => {
  it('coaches paragraph multi-blank prompts to produce one comma-separated value per blank in order', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiProvider('test-key', {
      generate: async ({ body }) => {
        capturedBody = body as Record<string, unknown>;
        return {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        cycleId: 'cycle-provider',
                        results: [
                          {
                            questionId: 'blank-paragraph',
                            status: 'GENERATED',
                            answer: {
                              questionId: 'blank-paragraph',
                              value: 'Paris, Rome',
                            },
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        };
      },
    });

    await provider.generate({
      cycleId: 'cycle-provider',
      pageId: 'page-1',
      questions: [
        {
          questionId: 'blank-paragraph',
          text: 'The capital of France is __________ and the capital of Italy is __________.',
          type: 'paragraph',
          required: false,
          options: [],
        },
      ],
      settledContext: [],
    });

    const contents = capturedBody?.contents as Array<{
      parts: Array<{ text: string }>;
    }>;
    expect(contents[0].parts[0].text).toContain(
      'Return only the blank values separated by commas in blank order'
    );
    expect(contents[0].parts[0].text).toContain(
      'exactly one answer value per blank'
    );
  });

  it('uses the production Gemini 3.1 Flash-Lite model and GenerationResponse schema', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiProvider('test-key', {
      generate: async ({ body }) => {
        capturedBody = body as Record<string, unknown>;
        return {
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        cycleId: request.cycleId,
                        results: [
                          {
                            questionId: 'name',
                            status: 'GENERATED',
                            answer: { questionId: 'name', value: 'Ada' },
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        };
      },
    });

    await provider.generate(request);

    expect(GEMINI_MODEL).toBe('gemini-3.1-flash-lite');
    expect(GEMINI_GENERATE_URL).toContain(
      `/models/${GEMINI_MODEL}:generateContent`
    );
    const contents = capturedBody?.contents as Array<{
      parts: Array<{ text: string }>;
    }>;
    const systemInstruction = capturedBody?.systemInstruction as {
      parts: Array<{ text: string }>;
    };
    expect(systemInstruction.parts[0].text).toContain(
      'Adapt response length and detail to the supplied question type and what it asks.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'Keep short-text answers concise and direct.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'For normal paragraph questions that are not blank-based, provide a moderate, coherent paragraph that addresses the main parts of the question with enough explanation to be useful.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'Avoid unnecessary historical background, tangential details, repeated ideas, and overly elaborate academic prose.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'Add depth when the question genuinely requires analysis, comparison, or detailed reasoning.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'Prefer the shortest response that adequately answers the question, rather than maximizing detail or minimizing length; do not enforce a rigid sentence count or word limit.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'For paragraph questions whose text contains multiple blank markers, return only the corresponding answer values as one comma-separated value string in blank order, with exactly one value per blank slot and no full-sentence prose.'
    );
    expect(systemInstruction.parts[0].text).toContain(
      'For paragraph questions with exactly one blank marker, return the single answer field value normally without extra prose.'
    );
    expect(contents[0].parts[0].text).toContain(
      `"cycleId":"${request.cycleId}"`
    );
    expect(capturedBody?.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema,
    });
  });

  it('uses the same production model for credential validation', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(GEMINI_MODEL_INFO_URL);
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { validateGeminiCredential } =
      await import('../src/Generation/GeminiProvider');
    await expect(validateGeminiCredential('test-key')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('uses the selected Gemini model in the generation endpoint', async () => {
    let capturedUrl = '';
    const provider = new GeminiProvider(
      'test-key',
      {
        generate: async ({ url }) => {
          capturedUrl = url;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          cycleId: request.cycleId,
                          results: [
                            {
                              questionId: 'name',
                              status: 'GENERATED',
                              answer: { questionId: 'name', value: 'Ada' },
                            },
                          ],
                        }),
                      },
                    ],
                  },
                },
              ],
            },
          };
        },
      },
      'gemini-3.5-flash'
    );

    await provider.generate(request);

    expect(capturedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
    );
  });

  it('rejects missing or mismatched cycleId and non-exhaustive provider results', async () => {
    for (const output of [
      { results: [] },
      { cycleId: 'wrong-cycle', results: [] },
      { cycleId: request.cycleId, results: [] },
    ]) {
      const provider = new GeminiProvider(
        'test-key',
        transport(200, JSON.stringify(output))
      );
      const response = await provider.generate(request);
      expect(
        response.results.every(
          (result) => result.status === 'GENERATION_FAILED'
        )
      ).toBe(true);
      expect(response.results[0]).toMatchObject({
        status: 'GENERATION_FAILED',
        failure: { code: 'INVALID_PROVIDER_OUTPUT' },
      });
    }
  });

  it('returns structured provider output without exposing the key', async () => {
    const provider = new GeminiProvider(
      'test-key',
      transport(
        200,
        JSON.stringify({
          cycleId: 'cycle-provider',
          results: [
            {
              questionId: 'name',
              status: 'GENERATED',
              answer: { questionId: 'name', value: 'Ada' },
            },
          ],
        })
      )
    );

    await expect(provider.generate(request)).resolves.toMatchObject({
      cycleId: 'cycle-provider',
    });
  });

  it('classifies authentication, quota, rate, and availability failures', async () => {
    for (const [status, code] of [
      [401, 'AUTHENTICATION_FAILED'],
      [403, 'PERMISSION_DENIED'],
      [402, 'QUOTA_EXHAUSTED'],
      [429, 'RATE_LIMITED'],
      [503, 'PROVIDER_UNAVAILABLE'],
    ] as const) {
      const provider = new GeminiProvider('test-key', transport(status));
      await expect(provider.generate(request)).rejects.toMatchObject({
        code,
        message:
          status === 503
            ? 'Server was busy. Try again.'
            : expect.not.stringContaining('test-key'),
      } satisfies Partial<GeminiProviderError>);
    }

    const otherServerFailure = new GeminiProvider('test-key', transport(500));
    await expect(otherServerFailure.generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Provider unavailable.',
    });
  });

  it('describes 403 permission failures without surfacing provider error codes', async () => {
    const provider = new GeminiProvider(
      'test-key',
      transport(403, JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }))
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message:
        'API key or project does not have permission to use this model.',
    });
  });

  it('materializes malformed and key-echoing output as safe generation failures', async () => {
    const malformed = new GeminiProvider('test-key', transport(200, '{bad'));
    await expect(malformed.generate(request)).resolves.toMatchObject({
      results: [{ failure: { code: 'MALFORMED_PROVIDER_OUTPUT' } }],
    });

    const echoed = new GeminiProvider(
      'test-key',
      transport(
        200,
        JSON.stringify({
          cycleId: 'cycle-provider',
          results: [
            {
              questionId: 'name',
              status: 'GENERATION_FAILED',
              answer: null,
              failure: { code: 'ECHO', message: 'test-key' },
            },
          ],
        })
      )
    );
    await expect(echoed.generate(request)).resolves.toMatchObject({
      results: [
        {
          failure: {
            code: 'PROVIDER_ERROR',
            message: 'Provider returned an unsafe response.',
          },
        },
      ],
    });
  });
});
