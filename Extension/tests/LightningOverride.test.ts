import { describe, expect, it, vi } from 'vitest';
import {
  NVIDIA_ENDPOINT,
  NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS,
  NVIDIA_NEMOTRON_LIGHTNING_MODEL,
  NVIDIA_STATUS_ENDPOINT,
  NvidiaProvider,
  NvidiaProviderError,
} from '../src/Generation/NvidiaProvider';
import { systemInstruction } from '../src/Generation/SystemInstructions';
import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { validateGenerationResponse } from '../src/Generation/Validation';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { createOverrideFilledIntent } from '../src/Generation/Intent';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';

const LIGHTNING = NVIDIA_NEMOTRON_LIGHTNING_MODEL;
const REQUEST_ID = '10000000-0000-4000-8000-000000000000';
const BLANKS_TEXT =
  'Name the country, the painting, and the artist: ________ was home to the ________ painted by ________.';

function overrideRequest(cycleId = 'override-cycle'): GenerationRequest {
  return {
    cycleId,
    pageId: 'page-1',
    questions: [
      {
        questionId: 'q-name',
        text: 'Preferred name',
        type: 'short-text',
        required: true,
        options: [],
      },
      {
        questionId: 'q-summary',
        text: 'Summarize how you review a shared checklist.',
        type: 'paragraph',
        required: false,
        options: [],
      },
      {
        questionId: 'q-blanks',
        text: BLANKS_TEXT,
        type: 'paragraph',
        required: false,
        options: [],
        answerParts: 3,
      },
    ],
    settledContext: [],
  };
}

function overrideResponse(cycleId: string): GenerationResponse {
  return {
    cycleId,
    results: [
      {
        questionId: 'q-name',
        status: 'GENERATED',
        answer: { questionId: 'q-name', value: 'Grace Hopper' },
      },
      {
        questionId: 'q-summary',
        status: 'GENERATED',
        answer: {
          questionId: 'q-summary',
          value:
            'I read each item in order, verify it against the current state, and note anything that changed.',
        },
      },
      {
        questionId: 'q-blanks',
        status: 'GENERATED',
        answer: {
          questionId: 'q-blanks',
          value: 'Italy, Mona Lisa, Michelangelo',
        },
      },
    ],
  };
}

function completionEnvelope(content: string) {
  return {
    id: 'completion-id',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
  };
}

function responseFor(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function completionFor(
  cycleId: string,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return responseFor(
    completionEnvelope(JSON.stringify(overrideResponse(cycleId))),
    status,
    headers
  );
}

function lightningProvider(fetchMock: ReturnType<typeof vi.fn>) {
  return new NvidiaProvider(
    'synthetic-test-key',
    LIGHTNING,
    fetchMock as unknown as typeof fetch
  );
}

function formQuestion(request: GenerationQuestion): Question {
  return {
    id: request.questionId,
    text: request.text,
    type: request.type,
    required: request.required,
    options: [],
    existingInput: { value: 'Existing answer', hasValue: true },
    supported: true,
    unsupportedReason: null,
    ...(request.answerParts ? { answerParts: request.answerParts } : {}),
  };
}

function overrideForm(request: GenerationRequest): Form {
  return {
    formId: 'override-form',
    activePageId: request.pageId,
    questions: request.questions.map(formQuestion),
  };
}

function overridePage(request: GenerationRequest): NormalizedActivePage {
  const form = overrideForm(request);
  return {
    form,
    questionResults: form.questions.map((question) => ({
      questionId: question.id,
      status: 'ready',
      answer: null,
      reason: null,
    })),
    processingCycle: { cycleId: 'lifecycle-cycle' },
  };
}

describe('Lightning Override request handling', () => {
  it('keeps the configured Lightning settings unchanged for an Override request', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      completionFor('override-cycle')
    );
    const request = overrideRequest();

    await lightningProvider(fetchMock).generate(request);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(NVIDIA_ENDPOINT);
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe(LIGHTNING);
    expect(payload.max_tokens).toBe(32768);
    expect(payload.temperature).toBe(1);
    expect(payload.top_p).toBe(0.95);
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.stream).toBe(false);
    expect(NVIDIA_LIGHTNING_REQUEST_TIMEOUT_MS).toBe(60_000);

    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: systemInstruction,
    });
    const userMessage = JSON.parse(payload.messages[1].content);
    expect(userMessage.cycleId).toBe(request.cycleId);
    expect(userMessage.questions).toEqual(request.questions);
    expect(userMessage.responseContract.numberOfResults).toBe(3);
    expect(userMessage.task).toContain('q-blanks');
    expect(userMessage.task).toMatch(/blank markers/u);
  });

  it('parses a valid Override response and preserves multi-part answers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      completionFor('override-cycle')
    );
    const request = overrideRequest();

    await expect(
      lightningProvider(fetchMock).generate(request)
    ).resolves.toEqual(overrideResponse('override-cycle'));

    const results = validateGenerationResponse(
      overrideResponse('override-cycle'),
      overrideForm(request),
      'override-cycle',
      overrideForm(request).questions
    );
    expect(results.map((result) => result.status)).toEqual([
      'GENERATED',
      'GENERATED',
      'GENERATED',
    ]);
    expect(results[0].answer?.value).toBe('Grace Hopper');
    expect(typeof results[1].answer?.value).toBe('string');
    expect(results[2].answer?.value).toBe('Italy, Mona Lisa, Michelangelo');
  });

  it('handles a multi-part Override answer returned as an array', () => {
    const request = overrideRequest();
    const response = overrideResponse('override-cycle');
    response.results[2] = {
      questionId: 'q-blanks',
      status: 'GENERATED',
      answer: {
        questionId: 'q-blanks',
        value: ['Italy', 'Mona Lisa', 'Michelangelo'],
      },
    };

    const results = validateGenerationResponse(
      response,
      overrideForm(request),
      'override-cycle',
      overrideForm(request).questions
    );

    expect(results[2]).toMatchObject({
      status: 'GENERATED',
      answer: { value: 'Italy, Mona Lisa, Michelangelo' },
    });
  });

  it('retries once without response_format during an Override request', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? responseFor(
              '{"error":"response_format is not supported for this model"}',
              400
            )
          : completionFor('override-cycle');
      }
    );

    await expect(
      lightningProvider(fetchMock).generate(overrideRequest())
    ).resolves.toEqual(overrideResponse('override-cycle'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackPayload = JSON.parse(bodies[1]);
    expect(fallbackPayload).not.toHaveProperty('response_format');
    expect(fallbackPayload.model).toBe(LIGHTNING);
    expect(fallbackPayload.max_tokens).toBe(32768);
  });

  it('keeps fallback and attempt diagnostics when the Override retry fails', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => {
        attempts += 1;
        return attempts === 1
          ? responseFor(
              '{"error":"response_format is not supported for this model"}',
              400
            )
          : responseFor('{"error":"busy"}', 503);
      }
    );

    const thrown = await lightningProvider(fetchMock)
      .generate(overrideRequest())
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(NvidiaProviderError);
    expect(thrown).toMatchObject({
      safeCode: 'PROVIDER_UNAVAILABLE',
      safeMessageCode: 'SERVER_BUSY',
      diagnostics: {
        modelId: LIGHTNING,
        httpStatus: 503,
        attempt: 2,
        fallbackUsed: true,
      },
    });
    expect((thrown as Error).message).not.toContain('response_format');
  });

  it('follows NVCF pending responses during an Override request', async () => {
    let posts = 0;
    const fetchMock = vi.fn(
      async (input: string | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === NVIDIA_ENDPOINT) {
          posts += 1;
          return responseFor('', 202, {
            'NVCF-REQID': REQUEST_ID,
            'NVCF-POLL-SECONDS': '0.001',
          });
        }
        if (url === `${NVIDIA_STATUS_ENDPOINT}${REQUEST_ID}`) {
          return completionFor('override-cycle');
        }
        throw new Error('unexpected request');
      }
    );

    await expect(
      lightningProvider(fetchMock).generate(overrideRequest())
    ).resolves.toEqual(overrideResponse('override-cycle'));

    expect(posts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a pending Override request that never completes as a timeout', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === NVIDIA_ENDPOINT) {
          return responseFor('', 202, {
            'NVCF-REQID': REQUEST_ID,
            'NVCF-POLL-SECONDS': '0.001',
          });
        }
        return responseFor('', 202, { 'NVCF-REQID': REQUEST_ID });
      }
    );
    const provider = new NvidiaProvider(
      'synthetic-test-key',
      LIGHTNING,
      fetchMock as unknown as typeof fetch,
      40
    );

    const thrown = await provider
      .generate(overrideRequest())
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      safeCode: 'TIMEOUT',
      diagnostics: {
        modelId: LIGHTNING,
        pollingUsed: true,
        timeoutStage: 'POLLING',
        requestId: REQUEST_ID,
      },
    });
    const diagnostics = (thrown as NvidiaProviderError).diagnostics as {
      pollCount?: number;
    };
    expect(diagnostics.pollCount ?? 0).toBeGreaterThan(0);
  });

  it('keeps concurrent Override cycles isolated', async () => {
    const resolvers: Array<(value: GenerationResponse) => void> = [];
    const generator = {
      generate: vi.fn(
        (_request: GenerationRequest) =>
          new Promise<GenerationResponse>((resolve) => {
            resolvers.push(resolve);
          })
      ),
    };
    let sequence = 0;
    const coordinator = new GenerationCoordinator(
      () => `override-cycle-${++sequence}`
    );
    const page = overridePage(overrideRequest());
    const intent = createOverrideFilledIntent([
      'q-name',
      'q-summary',
      'q-blanks',
    ]);

    const first = coordinator.generate(page, [], generator, undefined, intent);
    const second = coordinator.generate(page, [], generator, undefined, intent);
    expect(resolvers).toHaveLength(2);

    resolvers[0](overrideResponse('override-cycle-1'));
    resolvers[1](overrideResponse('override-cycle-2'));

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatchObject({
      cycleId: 'override-cycle-2',
      status: 'complete',
    });
  });
});
