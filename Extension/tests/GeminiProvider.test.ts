import { describe, expect, it, vi } from 'vitest';
import {
  GEMINI_35_FLASH_LITE_MODEL,
  GEMINI_GENERATE_URL,
  GEMINI_MODEL,
  GEMINI_MODEL_INFO_URL,
  GeminiProvider,
  GeminiProviderError,
  readResponseBody,
  responseJsonSchema,
  validateGeminiCredential,
  type GeminiTransport,
} from '../src/Generation/GeminiProvider';
import type { GenerationRequest } from '../src/Generation/Contract';
import { systemInstruction } from '../src/Generation/SystemInstructions';
import { resolveCredentialValidator } from '../src/Generation/ProviderRegistry';

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
    const sentSystemInstruction = capturedBody?.systemInstruction as {
      parts: Array<{ text: string }>;
    };
    expect(sentSystemInstruction.parts[0].text).toBe(systemInstruction);
    expect(sentSystemInstruction.parts[0].text).toContain(
      'Adapt response length and detail to the supplied question type and what it asks.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'Keep short-text answers concise and direct.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'For normal paragraph questions that are not blank-based, provide a moderate, coherent paragraph that addresses the main parts of the question with enough explanation to be useful.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'Avoid unnecessary historical background, tangential details, repeated ideas, and overly elaborate academic prose.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'Add depth when the question genuinely requires analysis, comparison, or detailed reasoning.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'Prefer the shortest response that adequately answers the question, rather than maximizing detail or minimizing length; do not enforce a rigid sentence count or word limit.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
      'For paragraph questions whose text contains multiple blank markers, return only the corresponding answer values as one comma-separated value string in blank order, with exactly one value per blank slot and no full-sentence prose.'
    );
    expect(sentSystemInstruction.parts[0].text).toContain(
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

  it('explicitly uses LOW thinking for Gemini 3.5 Flash-Lite only', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiProvider(
      'test-key',
      {
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
      },
      GEMINI_35_FLASH_LITE_MODEL
    );

    await provider.generate(request);

    expect(capturedBody?.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema,
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    const generationConfig = capturedBody?.generationConfig as {
      thinkingConfig: { thinkingLevel: string };
    };
    expect(generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
    expect(JSON.stringify(generationConfig)).not.toContain('MEDIUM');
    expect(JSON.stringify(generationConfig)).not.toContain('HIGH');
  });

  it('does not add thinkingConfig for Gemini 3.1 Flash-Lite', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiProvider(
      'test-key',
      {
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
      },
      GEMINI_MODEL
    );

    await provider.generate(request);

    expect(capturedBody?.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema,
    });
    expect(capturedBody?.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('uses the same production model for credential validation', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(GEMINI_MODEL_INFO_URL);
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const validator = resolveCredentialValidator('gemini', GEMINI_MODEL);
    expect(validator).not.toBeNull();
    await expect(
      validator?.('test-key', GEMINI_MODEL)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('validates the selected Gemini model instead of a fixed model', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const validator = resolveCredentialValidator(
        'gemini',
        'gemini-3.5-flash-lite'
      );
      expect(validator).not.toBeNull();
      await expect(
        validator?.('test-key', 'gemini-3.5-flash-lite')
      ).resolves.toBeUndefined();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite'
      );
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('classifies API_KEY_INVALID from a 400 credential validation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                details: [{ reason: 'API_KEY_INVALID' }],
              },
            }),
            { status: 400 }
          )
      )
    );

    try {
      await expect(validateGeminiCredential('test-key')).rejects.toMatchObject({
        code: 'AUTHENTICATION_FAILED',
        safeCode: 'AUTHENTICATION_FAILED',
        message: 'Credential invalid.',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('rejects missing or mismatched cycleId and non-exhaustive provider results after bounded recovery', async () => {
    for (const [output, expectedCalls] of [
      [{ results: [] }, 3],
      [{ cycleId: 'wrong-cycle', results: [] }, 1],
      [{ cycleId: request.cycleId, results: [] }, 3],
    ] as const) {
      const generate = vi.fn(async () => ({
        status: 200,
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(output) }],
              },
            },
          ],
        },
      }));
      const provider = new GeminiProvider(
        'test-key',
        { generate },
        GEMINI_MODEL,
        { baseBackoffMs: 0, maxBackoffMs: 0, random: () => 0 }
      );
      await expect(provider.generate(request)).rejects.toMatchObject({
        code: 'MALFORMED_PROVIDER_OUTPUT',
        safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      });
      expect(generate).toHaveBeenCalledTimes(expectedCalls);
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
      const provider = new GeminiProvider(
        'test-key',
        transport(status),
        GEMINI_MODEL,
        { baseBackoffMs: 0, maxBackoffMs: 0, random: () => 0 }
      );
      await expect(provider.generate(request)).rejects.toMatchObject({
        code,
        message:
          status === 503
            ? "The AI provider's server is temporarily unavailable or overloaded. This can happen during periods of high demand. Try switching providers or try again later. Error 503: Service Unavailable."
            : expect.not.stringContaining('test-key'),
      } satisfies Partial<GeminiProviderError>);
    }

    const otherServerFailure = new GeminiProvider('test-key', transport(500));
    await expect(otherServerFailure.generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Provider unavailable.',
    });
  });

  it('classifies an aborted generation request as a sanitized timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('sensitive abort details', 'AbortError');
      })
    );

    try {
      await expect(
        new GeminiProvider('test-key').generate(request)
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
        safeCode: 'TIMEOUT',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('describes 403 permission failures without surfacing provider error codes', async () => {
    const provider = new GeminiProvider(
      'test-key',
      transport(403, JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }))
    );

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'API key or project does not have permission to use this model.',
    });
  });

  it('rejects malformed and key-echoing output with safe diagnostics', async () => {
    const malformed = new GeminiProvider(
      'test-key',
      transport(200, '{bad'),
      GEMINI_MODEL,
      { baseBackoffMs: 0, maxBackoffMs: 0, random: () => 0 }
    );
    await expect(malformed.generate(request)).rejects.toMatchObject({
      code: 'MALFORMED_PROVIDER_OUTPUT',
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_JSON' },
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
    await expect(echoed.generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      safeCode: 'PROVIDER_FAILURE',
      message: 'Provider returned an unsafe response.',
      diagnostics: { diagnostic: 'API_KEY_ECHO' },
    });
  });

  it('treats 501 and 505 as terminal without retrying or splitting', async () => {
    const multiQuestionRequest: GenerationRequest = {
      ...request,
      questions: ['q-1', 'q-2', 'q-3'].map((questionId) => ({
        questionId,
        text: `Question ${questionId}`,
        type: 'short-text',
        required: false,
        options: [],
      })),
    };
    for (const status of [501, 505]) {
      const generate = vi.fn(async () => ({ status, body: {} }));
      const provider = new GeminiProvider(
        'test-key',
        { generate },
        GEMINI_MODEL,
        { baseBackoffMs: 0, maxBackoffMs: 0, random: () => 0 }
      );

      await expect(
        provider.generate(multiQuestionRequest)
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      expect(generate).toHaveBeenCalledOnce();
    }
  });

  it('retries 502 as a transient server failure', async () => {
    let calls = 0;
    const provider = new GeminiProvider(
      'test-key',
      {
        async generate({ body }) {
          calls += 1;
          if (calls === 1) {
            return { status: 502, body: {} };
          }
          const sent = (
            body as { contents: Array<{ parts: Array<{ text: string }> }> }
          ).contents[0].parts[0].text;
          const payload = JSON.parse(sent) as {
            cycleId: string;
            questions: Array<{ questionId: string }>;
          };
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          cycleId: payload.cycleId,
                          results: payload.questions.map((question) => ({
                            questionId: question.questionId,
                            status: 'GENERATED',
                            answer: {
                              questionId: question.questionId,
                              value: 'ok',
                            },
                          })),
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
      GEMINI_MODEL,
      { baseBackoffMs: 0, maxBackoffMs: 0, random: () => 0 }
    );

    await expect(provider.generate(request)).resolves.toMatchObject({
      cycleId: request.cycleId,
    });
    expect(calls).toBe(2);
  });

  it('removes abort listeners when response JSON parsing throws synchronously', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const response = {
      json() {
        throw new Error('synchronous parse failure');
      },
    } as unknown as Response;

    await expect(
      readResponseBody(response, controller.signal)
    ).resolves.toBeNull();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('removes abort listeners after rejected, successful, and aborted body reads', async () => {
    const rejectedController = new AbortController();
    const rejectedAdd = vi.spyOn(rejectedController.signal, 'addEventListener');
    const rejectedRemove = vi.spyOn(
      rejectedController.signal,
      'removeEventListener'
    );
    await expect(
      readResponseBody(
        {
          json: () => Promise.reject(new Error('parse failure')),
        } as unknown as Response,
        rejectedController.signal
      )
    ).resolves.toBeNull();
    expect(rejectedAdd).toHaveBeenCalledTimes(1);
    expect(rejectedRemove).toHaveBeenCalledTimes(1);

    const successfulController = new AbortController();
    const successfulRemove = vi.spyOn(
      successfulController.signal,
      'removeEventListener'
    );
    await expect(
      readResponseBody(
        {
          json: async () => ({ ok: true }),
        } as unknown as Response,
        successfulController.signal
      )
    ).resolves.toEqual({ ok: true });
    expect(successfulRemove).toHaveBeenCalledTimes(1);

    const abortedController = new AbortController();
    const abortedRemove = vi.spyOn(
      abortedController.signal,
      'removeEventListener'
    );
    const pendingRead = readResponseBody(
      {
        json: () => new Promise<unknown>(() => undefined),
      } as unknown as Response,
      abortedController.signal
    );
    abortedController.abort();
    await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedRemove).toHaveBeenCalledTimes(1);
  });
});
