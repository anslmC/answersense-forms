import { describe, expect, it, vi } from 'vitest';
import {
  NVIDIA_ENDPOINT,
  NVIDIA_NEMOTRON_LIGHTNING_MODEL,
  NVIDIA_MODEL,
  NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS,
  NvidiaProvider,
  NvidiaProviderError,
  NVIDIA_REQUEST_TIMEOUT_MS,
  validateNvidiaCredential,
} from '../src/Generation/NvidiaProvider';
import type { GenerationRequest } from '../src/Generation/Contract';
import { systemInstruction } from '../src/Generation/SystemInstructions';
import type { Form } from '../src/Models/Logical';
import { validateGenerationResponse } from '../src/Generation/Validation';

const request: GenerationRequest = {
  cycleId: 'nvidia-cycle',
  pageId: 'nvidia-page',
  questions: [
    {
      questionId: 'garden-tools',
      text: 'Why label shared garden tools?',
      type: 'short-text',
      required: true,
      options: [],
    },
  ],
  settledContext: [],
};

function validGenerationResponse(cycleId = request.cycleId) {
  return {
    cycleId,
    results: [
      {
        questionId: request.questions[0].questionId,
        status: 'GENERATED',
        answer: {
          questionId: request.questions[0].questionId,
          value: 'Labels help return tools to their shared storage location.',
        },
      },
    ],
  };
}

function completion(content: string, finishReason: unknown = 'stop') {
  return {
    id: 'completion-id',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  };
}

function completionWithRole(content: string, role: string) {
  const value = completion(content);
  return {
    ...value,
    choices: [
      {
        ...value.choices[0],
        message: { ...value.choices[0].message, role },
      },
    ],
  };
}

function successfulFetch(content: string, finishReason: unknown = 'stop') {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(completion(content, finishReason)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

function completionWithMessage(
  fields: Record<string, unknown>,
  finishReason: unknown = 'stop'
) {
  return {
    id: 'completion-id',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', ...fields },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  };
}

function completionWithoutFinishReason(content: string) {
  return {
    id: 'completion-id',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  };
}

function providerReturning(body: string) {
  return new NvidiaProvider(
    'synthetic-test-key',
    NVIDIA_NEMOTRON_LIGHTNING_MODEL,
    vi.fn(async () => new Response(body, { status: 200 }))
  );
}

async function generateError(
  provider: NvidiaProvider,
  generationRequest: GenerationRequest = request
): Promise<unknown> {
  return provider.generate(generationRequest).catch((error: unknown) => error);
}

describe('NVIDIA Nemotron provider', () => {
  it('sends the fixed endpoint, Bearer authentication, and tested request settings', async () => {
    const fetchMock = successfulFetch(
      JSON.stringify(validGenerationResponse())
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await provider.generate(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(NVIDIA_ENDPOINT);
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer synthetic-test-key'
    );
    const payload = JSON.parse(String(init.body));
    expect(Object.keys(payload).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'reasoning_effort',
      'stream',
      'temperature',
      'top_p',
    ]);
    expect(payload.model).toBe(NVIDIA_MODEL);
    expect(payload.stream).toBe(false);
    expect(payload.reasoning_effort).toBe('low');
    expect(payload).not.toHaveProperty('chat_template_kwargs');
    expect(payload.max_tokens).toBe(16384);
  });

  it('uses Nemotron 3.5 Lightning model-specific request settings', async () => {
    const fetchMock = successfulFetch(
      JSON.stringify(validGenerationResponse())
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    await provider.generate(request);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(payload.model).toBe(NVIDIA_NEMOTRON_LIGHTNING_MODEL);
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload).not.toHaveProperty('reasoning_effort');
    expect(payload).not.toHaveProperty('reasoning_budget');
    expect(payload).not.toHaveProperty('enable_thinking');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.max_tokens).toBe(32768);
  });

  it('sends the unchanged system instruction and explicit response-contract directions', async () => {
    const fetchMock = successfulFetch(
      JSON.stringify(validGenerationResponse())
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    );

    await provider.generate(request);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const payload = JSON.parse(String(init.body));
    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: systemInstruction,
    });
    const userMessage = JSON.parse(payload.messages[1].content);
    expect(userMessage.cycleId).toBe(request.cycleId);
    expect(userMessage.questions).toEqual(request.questions);
    expect(userMessage.responseContract.requiredTopLevelFields).toEqual([
      'cycleId',
      'results',
    ]);
    expect(userMessage.responseContract.results).toMatch(/exactly one result/u);
    expect(userMessage.responseContract.numberOfResults).toBe(1);
    expect(userMessage.responseContract.responseExample.cycleId).toBe(
      request.cycleId
    );
    expect(
      userMessage.responseContract.responseExample.results[0].answer.questionId
    ).toBe('<same supplied questionId>');
    expect(userMessage.responseContract.resultVariants).toHaveProperty(
      'GENERATED'
    );
    expect(userMessage.responseContract.resultVariants).toHaveProperty(
      'ABSTAINED'
    );
    expect(userMessage.responseContract.resultVariants).toHaveProperty(
      'GENERATION_FAILED'
    );
    expect(userMessage.responseContract.answerRules).toMatch(
      /supplied option/u
    );
  });

  it('parses assistant completion content into the shared generation response shape', async () => {
    const expected = validGenerationResponse();
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      successfulFetch(JSON.stringify(expected))
    );

    await expect(provider.generate(request)).resolves.toEqual(expected);
  });

  it.each([
    ['invalid completion JSON', '{not-json'],
    ['missing choices', JSON.stringify({ id: 'id', choices: [] })],
    ['non-array choices', JSON.stringify({ id: 'id', choices: null })],
    [
      'missing message content',
      JSON.stringify({
        id: 'id',
        choices: [
          { index: 0, message: { role: 'assistant' }, finish_reason: 'stop' },
        ],
      }),
    ],
    ['empty message content', JSON.stringify(completion(''))],
    [
      'non-assistant message',
      JSON.stringify(
        completionWithRole(JSON.stringify(validGenerationResponse()), 'user')
      ),
    ],
    ['invalid generated JSON', JSON.stringify(completion('{not-json'))],
    [
      'invalid response structure',
      JSON.stringify(completion(JSON.stringify({ results: {} }))),
    ],
  ])(
    'rejects %s without exposing response content',
    async (_name, responseBody) => {
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        vi.fn(async () => new Response(String(responseBody), { status: 200 }))
      );

      await expect(provider.generate(request)).rejects.toMatchObject({
        safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      });
    }
  );

  it.each([
    ['valid content', JSON.stringify(validGenerationResponse())],
    ['empty content', ''],
  ])(
    'classifies finish_reason length as an incomplete response with %s',
    async (_label, content) => {
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        successfulFetch(content, 'length')
      );

      await expect(provider.generate(request)).rejects.toMatchObject({
        safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
      });
    }
  );

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [408, 'TIMEOUT'],
    [413, 'INVALID_REQUEST'],
    [422, 'INVALID_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [202, 'PROVIDER_UNAVAILABLE'],
  ] as const)(
    'classifies HTTP %i as %s without exposing the provider body',
    async (status, safeCode) => {
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        vi.fn(
          async () => new Response('private provider error body', { status })
        )
      );

      const thrown = await provider
        .generate(request)
        .catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(NvidiaProviderError);
      expect(thrown).toMatchObject({ safeCode });
      if (status === 503) {
        expect(thrown).toMatchObject({ safeMessageCode: 'SERVER_BUSY' });
      }
      expect((thrown as Error).message).not.toContain('private');
      expect((thrown as Error).message).not.toContain('synthetic-test-key');
    }
  );

  it('classifies network failures and does not expose exception details', async () => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      vi.fn(async () => {
        throw new TypeError('private network details');
      })
    );

    const thrown = await provider
      .generate(request)
      .catch((error: unknown) => error);
    expect(thrown).toMatchObject({ safeCode: 'NETWORK_FAILURE' });
    expect((thrown as Error).message).not.toContain('private');
  });

  it.each(['headers', 'body'] as const)(
    'times out while waiting for response %s',
    async (phase) => {
      const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
        if (phase === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('private timeout details', 'AbortError'));
            });
          });
        }
        return Promise.resolve({
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(
                  new DOMException('private body timeout details', 'AbortError')
                );
              });
            }),
        } as Response);
      });
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_MODEL,
        fetchMock as unknown as typeof fetch,
        5
      );

      const thrown = await provider
        .generate(request)
        .catch((error: unknown) => error);
      expect(thrown).toMatchObject({ safeCode: 'TIMEOUT' });
      expect((thrown as Error).message).not.toContain('private');
    }
  );

  it('rejects a response that echoes the API key with a safe error', async () => {
    const echoed = validGenerationResponse();
    echoed.results[0].answer.value = 'synthetic-test-key';
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      successfulFetch(JSON.stringify(echoed))
    );

    const thrown = await provider
      .generate(request)
      .catch((error: unknown) => error);
    expect(thrown).toMatchObject({ safeCode: 'PROVIDER_FAILURE' });
    expect((thrown as Error).message).not.toContain('synthetic-test-key');
  });

  it('validates credentials with a bounded synthetic chat probe and does not require a particular answer', async () => {
    const fetchMock = successfulFetch(
      JSON.stringify({
        cycleId: 'nvidia-credential-validation',
        results: [
          {
            questionId: 'nvidia-validation-question',
            status: 'GENERATED',
            answer: {
              questionId: 'nvidia-validation-question',
              value: 'Labels make it easier to return tools.',
            },
          },
        ],
      })
    );

    await expect(
      validateNvidiaCredential('synthetic-test-key', NVIDIA_MODEL, fetchMock)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(NVIDIA_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts Nemotron 3.5 Lightning for the bounded credential validation probe', async () => {
    const fetchMock = successfulFetch(
      JSON.stringify({
        cycleId: 'nvidia-credential-validation',
        results: [
          {
            questionId: 'nvidia-validation-question',
            status: 'GENERATED',
            answer: {
              questionId: 'nvidia-validation-question',
              value: 'Labels help return tools.',
            },
          },
        ],
      })
    );

    await expect(
      validateNvidiaCredential(
        'synthetic-test-key',
        NVIDIA_NEMOTRON_LIGHTNING_MODEL,
        fetchMock
      )
    ).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(payload.model).toBe(NVIDIA_NEMOTRON_LIGHTNING_MODEL);
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload).not.toHaveProperty('reasoning_effort');
    expect(payload).not.toHaveProperty('reasoning_budget');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.max_tokens).toBe(32768);
  });

  it('rejects validation for a non-registered model without making a request', async () => {
    const fetchMock = vi.fn();
    await expect(
      validateNvidiaCredential(
        'synthetic-test-key',
        'attacker/model',
        fetchMock
      )
    ).rejects.toMatchObject({ safeCode: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('NVIDIA response extraction and classification', () => {
  const expected = validGenerationResponse();
  const expectedContent = JSON.stringify(expected);

  it('accepts normal JSON content with finish_reason stop', async () => {
    const provider = providerReturning(
      JSON.stringify(completion(expectedContent, 'stop'))
    );

    await expect(provider.generate(request)).resolves.toEqual(expected);
  });

  it.each([
    ['json language fence', '```json'],
    ['unlabelled fence', '```'],
  ])('extracts JSON from %s content', async (_label, fence) => {
    const content = fence + '\n' + JSON.stringify(expected, null, 2) + '\n```';
    const provider = providerReturning(JSON.stringify(completion(content)));

    await expect(provider.generate(request)).resolves.toEqual(expected);
  });

  it('extracts JSON surrounded by explanatory text', async () => {
    const content =
      'Here is the requested JSON response:\n' +
      expectedContent +
      '\nLet me know if anything else is needed.';
    const provider = providerReturning(JSON.stringify(completion(content)));

    await expect(provider.generate(request)).resolves.toEqual(expected);
  });

  it.each(['reasoning', 'reasoning_content'] as const)(
    'classifies empty content with %s as a reasoning-only incomplete response',
    async (field) => {
      const reasoning = 'private reasoning trace';
      const body = JSON.stringify(
        completionWithMessage({ content: '', [field]: reasoning }, 'stop')
      );
      const thrown = await generateError(providerReturning(body));

      expect(thrown).toMatchObject({
        safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
        diagnostics: {
          diagnostic: 'REASONING_ONLY',
          httpStatus: 200,
          finishReason: 'stop',
          contentPresent: false,
          reasoningFieldPresent: true,
        },
      });
      expect((thrown as Error).message).not.toContain(reasoning);
      expect(JSON.stringify(thrown)).not.toContain(reasoning);
    }
  );

  it('joins text parts when message content is returned as an array', async () => {
    const body = JSON.stringify(
      completionWithMessage({
        content: [
          { type: 'text', text: expectedContent.slice(0, 20) },
          { type: 'text', text: expectedContent.slice(20) },
        ],
      })
    );

    await expect(providerReturning(body).generate(request)).resolves.toEqual(
      expected
    );
  });

  it('uses content and ignores reasoning when both are present', async () => {
    const body = JSON.stringify(
      completionWithMessage({
        content: expectedContent,
        reasoning: 'this reasoning must not be used as the answer',
      })
    );

    await expect(providerReturning(body).generate(request)).resolves.toEqual(
      expected
    );
  });

  it('does not substitute reasoning JSON for invalid final content', async () => {
    const body = JSON.stringify(
      completionWithMessage({
        content: 'not json',
        reasoning: expectedContent,
      })
    );
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_JSON' },
    });
  });

  it('accepts finish_reason null with valid complete content', async () => {
    const body = JSON.stringify(completion(expectedContent, null));

    await expect(providerReturning(body).generate(request)).resolves.toEqual(
      expected
    );
  });

  it('accepts a missing finish reason with valid complete content', async () => {
    const body = JSON.stringify(completionWithoutFinishReason(expectedContent));

    await expect(providerReturning(body).generate(request)).resolves.toEqual(
      expected
    );
  });

  it('classifies finish_reason length as truncated', async () => {
    const body = JSON.stringify(completion(expectedContent, 'length'));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
      diagnostics: {
        diagnostic: 'TRUNCATED_RESPONSE',
        finishReason: 'length',
      },
    });
  });

  it.each(['content_filter', 'tool_calls', ''])(
    'rejects unsupported finish_reason %j',
    async (finishReason) => {
      const body = JSON.stringify(completion(expectedContent, finishReason));
      const thrown = await generateError(providerReturning(body));

      expect(thrown).toMatchObject({
        safeCode: 'MALFORMED_PROVIDER_RESPONSE',
        diagnostics: {
          diagnostic: 'UNSUPPORTED_FINISH_REASON',
          finishReason,
        },
      });
    }
  );

  it('classifies malformed JSON content', async () => {
    const body = JSON.stringify(completion('{not-json'));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: {
        diagnostic: 'INVALID_JSON',
        extractionOutcome: 'FAILED',
      },
    });
  });

  it('rejects truncated JSON rather than accepting a partial object', async () => {
    const truncated =
      '{"cycleId":"nvidia-cycle","results":[{"questionId":"garden-tools","status":"GENERATED","answer":{"questionId":"garden-tools","value":"unterminated';
    const body = JSON.stringify(completion(truncated));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_JSON' },
    });
  });

  it('rejects ambiguous multiple generation JSON objects', async () => {
    const content =
      expectedContent + '\n' + JSON.stringify(validGenerationResponse('other'));
    const body = JSON.stringify(completion(content));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_JSON' },
    });
  });

  it.each([
    ['non-JSON body', '{not-json'],
    ['non-object JSON body', JSON.stringify([])],
  ])(
    'classifies an invalid completion envelope with %s',
    async (_label, body) => {
      const thrown = await generateError(providerReturning(body));

      expect(thrown).toMatchObject({
        safeCode: 'MALFORMED_PROVIDER_RESPONSE',
        diagnostics: { diagnostic: 'INVALID_HTTP_RESPONSE_ENVELOPE' },
      });
    }
  );

  it('distinguishes missing choices from other malformed responses', async () => {
    const body = JSON.stringify({ id: 'id', choices: [] });
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'MISSING_CHOICES' },
    });
  });

  it('classifies a non-assistant message as invalid', async () => {
    const body = JSON.stringify(completionWithRole(expectedContent, 'user'));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_MESSAGE' },
    });
  });

  it('classifies empty content without reasoning as empty final content', async () => {
    const body = JSON.stringify(completion('', 'stop'));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: {
        diagnostic: 'EMPTY_FINAL_CONTENT',
        contentPresent: false,
        reasoningFieldPresent: false,
      },
    });
  });

  it('rejects valid JSON with an invalid generation structure', async () => {
    const body = JSON.stringify(completion(JSON.stringify({ results: {} })));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: {
        diagnostic: 'INVALID_GENERATION_RESPONSE',
        extractionOutcome: 'DIRECT',
      },
    });
  });

  it('classifies API key echo without exposing the key', async () => {
    const echoed = validGenerationResponse();
    echoed.results[0].answer.value = 'synthetic-test-key';
    const body = JSON.stringify(completion(JSON.stringify(echoed)));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'PROVIDER_FAILURE',
      diagnostics: { diagnostic: 'API_KEY_ECHO' },
    });
    expect((thrown as Error).message).not.toContain('synthetic-test-key');
    expect(JSON.stringify(thrown)).not.toContain('synthetic-test-key');
  });

  it('keeps diagnostics free of raw completion text', async () => {
    const marker = 'sensitive-completion-marker';
    const body = JSON.stringify(completion(`{not-json:${marker}`));
    const thrown = await generateError(providerReturning(body));

    expect(JSON.stringify(thrown)).not.toContain(marker);
  });

  it('strips reasoning blocks before extracting the final JSON answer', async () => {
    const reasoning = 'private reasoning trace';
    const content = `<think>${reasoning}</think>\n${expectedContent}`;
    const body = JSON.stringify(completion(content));

    await expect(providerReturning(body).generate(request)).resolves.toEqual(
      expected
    );
  });

  it('classifies a reasoning-only think block as incomplete', async () => {
    const reasoning = 'private reasoning trace';
    const body = JSON.stringify(
      completion(`<think>${reasoning}</think>`, 'stop')
    );
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
      diagnostics: {
        diagnostic: 'REASONING_ONLY',
        reasoningBlockPresent: true,
      },
    });
    expect(JSON.stringify(thrown)).not.toContain(reasoning);
  });

  it('captures token usage in truncation diagnostics', async () => {
    const body = JSON.stringify(completion(expectedContent, 'length'));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      diagnostics: {
        diagnostic: 'TRUNCATED_RESPONSE',
        usage: {
          promptTokens: 20,
          completionTokens: 15,
          totalTokens: 35,
        },
      },
    });
  });

  it('classifies a response with missing question results as incomplete', async () => {
    const body = JSON.stringify(
      completion(JSON.stringify({ cycleId: request.cycleId, results: [] }))
    );
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'INCOMPLETE_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'MISSING_RESULTS' },
    });
  });

  it.each([
    ['missing cycleId', { results: validGenerationResponse().results }],
    ['stale cycleId', { ...validGenerationResponse(), cycleId: 'other-cycle' }],
    [
      'duplicate questionId',
      {
        ...validGenerationResponse(),
        results: [
          ...validGenerationResponse().results,
          validGenerationResponse().results[0],
        ],
      },
    ],
  ])('rejects %s before downstream validation', async (_label, value) => {
    const body = JSON.stringify(completion(JSON.stringify(value)));
    const thrown = await generateError(providerReturning(body));

    expect(thrown).toMatchObject({
      safeCode: 'MALFORMED_PROVIDER_RESPONSE',
      diagnostics: { diagnostic: 'INVALID_GENERATION_RESPONSE' },
    });
  });
});

describe('NVIDIA Lightning production regressions', () => {
  const scenarioQuestions: GenerationRequest['questions'] = [
    {
      questionId: 'capital-russia',
      text: 'What is the capital city of Russia?',
      type: 'short-text',
      required: true,
      options: [],
    },
    {
      questionId: 'plants-green',
      text: 'Describe how do plants reflects green color.',
      type: 'paragraph',
      required: true,
      options: [],
    },
    {
      questionId: 'bond-song',
      text: 'Which artist performed the James Bond theme song?',
      type: 'single-choice',
      required: true,
      options: ['Billie Eilish', 'Adele'],
    },
    {
      questionId: 'mona-lisa-painted',
      text: 'The Mona Lisa was painted by Michelangelo.',
      type: 'single-choice',
      required: true,
      options: ['True', 'False'],
    },
    {
      questionId: 'beethoven-deaf',
      text: 'Beethoven was almost completely deaf when he composed his Ninth Symphony.',
      type: 'single-choice',
      required: true,
      options: ['True', 'False'],
    },
    {
      questionId: 'renaissance-blanks',
      text: 'The Renaissance began in ___; the ___ was painted by Leonardo; ___ sculpted David.',
      type: 'paragraph',
      required: true,
      options: [],
      answerParts: 3,
    },
    {
      questionId: 'impressionism',
      text: 'Describe the main ideas of Impressionism.',
      type: 'paragraph',
      required: true,
      options: [],
    },
  ];
  const scenarioRequest: GenerationRequest = {
    cycleId: 'scenario-cycle',
    pageId: 'scenario-page',
    questions: scenarioQuestions,
    settledContext: [],
  };
  const scenarioResponse = {
    cycleId: 'scenario-cycle',
    results: [
      {
        questionId: 'capital-russia',
        status: 'GENERATED',
        answer: { questionId: 'capital-russia', value: 'Moscow' },
      },
      {
        questionId: 'plants-green',
        status: 'GENERATED',
        answer: {
          questionId: 'plants-green',
          value:
            'Chlorophyll reflects green light while absorbing red and blue light for photosynthesis.',
        },
      },
      {
        questionId: 'bond-song',
        status: 'GENERATED',
        answer: {
          questionId: 'bond-song',
          value: 'Billie Eilish',
        },
      },
      {
        questionId: 'mona-lisa-painted',
        status: 'GENERATED',
        answer: {
          questionId: 'mona-lisa-painted',
          value: 'False',
        },
      },
      {
        questionId: 'beethoven-deaf',
        status: 'GENERATED',
        answer: {
          questionId: 'beethoven-deaf',
          value: 'True',
        },
      },
      {
        questionId: 'renaissance-blanks',
        status: 'GENERATED',
        answer: {
          questionId: 'renaissance-blanks',
          value: 'Italy, Mona Lisa, Michelangelo',
        },
      },
      {
        questionId: 'impressionism',
        status: 'GENERATED',
        answer: {
          questionId: 'impressionism',
          value:
            'Impressionism focused on capturing light, color, and fleeting everyday moments through loose brushwork.',
        },
      },
    ],
  };

  it('parses combined Scenario A, B, and C answers for Lightning', async () => {
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      successfulFetch(JSON.stringify(scenarioResponse))
    );

    await expect(provider.generate(scenarioRequest)).resolves.toEqual(
      scenarioResponse
    );
  });

  it('passes the Scenario C blank answer through shared validation', () => {
    const form: Form = {
      formId: 'scenario-form',
      activePageId: 'scenario-page',
      questions: scenarioQuestions.map((question) => ({
        id: question.questionId,
        text: question.text,
        type: question.type,
        required: question.required,
        options: question.options.map((label) => ({
          label,
          selected: false,
        })),
        existingInput: { value: null, hasValue: false },
        supported: true,
        unsupportedReason: null,
        ...(question.answerParts ? { answerParts: question.answerParts } : {}),
      })),
    };

    const results = validateGenerationResponse(
      scenarioResponse,
      form,
      scenarioResponse.cycleId,
      form.questions
    );

    expect(results.map((result) => result.status)).toEqual(
      scenarioQuestions.map(() => 'GENERATED')
    );
    expect(
      results.find((result) => result.questionId === 'renaissance-blanks')
        ?.answer?.value
    ).toBe('Italy, Mona Lisa, Michelangelo');
  });

  it('retries without JSON mode only when the provider rejects response_format', async () => {
    const expected = validGenerationResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ detail: 'Unsupported parameter: response_format' }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completion(JSON.stringify(expected))), {
          status: 200,
        })
      );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    await expect(provider.generate(request)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    );
    const secondPayload = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body)
    );
    expect(firstPayload.response_format).toEqual({ type: 'json_object' });
    expect(secondPayload).not.toHaveProperty('response_format');
  });

  it('allows Lightning the longer output-generation timeout', async () => {
    expect(NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS).toBe(60_000);
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_NEMOTRON_LIGHTNING_MODEL,
        fetchMock as unknown as typeof fetch
      );
      const generation = provider
        .generate(request)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(
        NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS - 1
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2);
      await expect(generation).resolves.toMatchObject({ safeCode: 'TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls a pending NVIDIA response using NVCF-REQID', async () => {
    vi.useFakeTimers();
    try {
      const requestId = '00000000-0000-4000-8000-000000000000';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 202,
            headers: { 'NVCF-REQID': requestId },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              completion(JSON.stringify(validGenerationResponse()))
            ),
            { status: 200 }
          )
        );
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_NEMOTRON_LIGHTNING_MODEL,
        fetchMock
      );

      const generation = provider.generate(request);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(generation).resolves.toEqual(validGenerationResponse());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain(
        `/status/${requestId}`
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry without JSON mode for an unrelated 400 error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: 'Unsupported model: synthetic-model' }),
          { status: 400 }
        )
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    const thrown = await generateError(provider);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(thrown).toMatchObject({
      safeCode: 'INVALID_REQUEST',
      diagnostics: {
        attempt: 1,
        fallbackUsed: false,
        modelId: NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      },
    });
    expect((thrown as Error).message).not.toContain('synthetic-model');
  });

  it('retries without JSON mode when a 422 rejects response_format', async () => {
    const expected = validGenerationResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ detail: 'response_format is not supported' }),
          { status: 422 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completion(JSON.stringify(expected))), {
          status: 200,
        })
      );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    await expect(provider.generate(request)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondPayload = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body)
    );
    expect(secondPayload).not.toHaveProperty('response_format');
  });

  it('reports the failed JSON-mode fallback attempt in diagnostics', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ detail: 'Unsupported parameter: response_format' }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        new Response('private provider body', { status: 500 })
      );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    const thrown = await generateError(provider);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(thrown).toMatchObject({
      safeCode: 'PROVIDER_UNAVAILABLE',
      diagnostics: {
        attempt: 2,
        fallbackUsed: true,
        modelId: NVIDIA_NEMOTRON_LIGHTNING_MODEL,
        httpStatus: 500,
      },
    });
    expect(JSON.stringify(thrown)).not.toContain('private provider body');
  });

  it('honors NVCF-POLL-SECONDS while polling', async () => {
    vi.useFakeTimers();
    try {
      const requestId = '00000000-0000-4000-8000-000000000001';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', {
            status: 202,
            headers: {
              'NVCF-REQID': requestId,
              'NVCF-POLL-SECONDS': '2',
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              completion(JSON.stringify(validGenerationResponse()))
            ),
            { status: 200 }
          )
        );
      const provider = new NvidiaProvider(
        'synthetic-test-key',
        NVIDIA_NEMOTRON_LIGHTNING_MODEL,
        fetchMock
      );

      const generation = provider.generate(request);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(generation).resolves.toEqual(validGenerationResponse());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures Retry-After without retrying a non-idempotent generation request', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('private provider body', {
          status: 429,
          headers: { 'Retry-After': '3' },
        })
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_NEMOTRON_LIGHTNING_MODEL,
      fetchMock
    );

    const thrown = await generateError(provider);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(thrown).toMatchObject({
      safeCode: 'RATE_LIMITED',
      diagnostics: { retryAfterMs: 3_000 },
    });
  });
});
