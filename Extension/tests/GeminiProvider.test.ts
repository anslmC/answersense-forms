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
    expect(contents[0].parts[0].text).toContain(
      `"cycleId":"${request.cycleId}"`
    );
    expect(capturedBody?.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema,
    });
  });

  it('uses the same production model for credential validation', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe(`${GEMINI_MODEL_INFO_URL}?key=test-key`);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { validateGeminiCredential } =
      await import('../src/Generation/GeminiProvider');
    await expect(validateGeminiCredential('test-key')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
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
      [402, 'QUOTA_EXHAUSTED'],
      [429, 'RATE_LIMITED'],
      [503, 'PROVIDER_UNAVAILABLE'],
    ] as const) {
      const provider = new GeminiProvider('test-key', transport(status));
      await expect(provider.generate(request)).rejects.toMatchObject({
        code,
        message: expect.not.stringContaining('test-key'),
      } satisfies Partial<GeminiProviderError>);
    }
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
