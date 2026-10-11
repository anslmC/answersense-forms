import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
  ProviderErrorCode,
  ProviderErrorContract,
} from './Contract';
import { systemInstruction } from './SystemInstructions';

export const NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const NVIDIA_GPT_OSS_MODEL = 'openai/gpt-oss-20b';
export const NVIDIA_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
export const NVIDIA_REQUEST_TIMEOUT_MS = 30_000;
const NVIDIA_MODEL_MAX_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  [NVIDIA_MODEL]: 16384,
  [NVIDIA_GPT_OSS_MODEL]: 4096,
});
const NVIDIA_MODELS = new Set(Object.keys(NVIDIA_MODEL_MAX_TOKENS));

const SAFE_MESSAGES: Record<ProviderErrorCode, string> = {
  AUTHENTICATION_FAILED: 'Credential invalid.',
  PERMISSION_DENIED: 'Provider access denied.',
  INVALID_REQUEST: 'Provider request was invalid.',
  RATE_LIMITED: 'Provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'Provider unavailable.',
  TIMEOUT: 'Provider request timed out.',
  INCOMPLETE_PROVIDER_RESPONSE: 'NVIDIA response was truncated before completion.',
  MALFORMED_PROVIDER_RESPONSE: 'Provider returned an invalid response.',
  NETWORK_FAILURE: 'Provider network request failed.',
  PROVIDER_FAILURE: 'Provider request failed.',
};

export class NvidiaProviderError extends Error implements ProviderErrorContract {
  public readonly providerId = 'nvidia';
  public readonly safeMessageCode: undefined = undefined;

  constructor(public readonly safeCode: ProviderErrorCode) {
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'NvidiaProviderError';
  }
}

type FetchImplementation = typeof fetch;

interface HttpResponseText {
  status: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createUserContent(request: GenerationRequest): string {
  return JSON.stringify({
    task: 'Generate answers for the supplied questions.',
    cycleId: request.cycleId,
    questions: request.questions,
    settledContext: request.settledContext,
    responseContract: {
      requiredTopLevelFields: ['cycleId', 'results'],
      cycleId: 'Copy the nonblank cycleId from this request exactly.',
      results:
        'Return an array with exactly one result for every supplied question. Each questionId must be unique and match one supplied questionId.',
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

function createPayload(
  request: GenerationRequest,
  modelId: string
): Record<string, unknown> {
  const maxTokens = NVIDIA_MODEL_MAX_TOKENS[modelId];
  if (maxTokens === undefined) {
    throw new NvidiaProviderError('INVALID_REQUEST');
  }
  return {
    model: modelId,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: createUserContent(request) },
    ],
    temperature: 1.0,
    top_p: 0.95,
    max_tokens: maxTokens,
    reasoning_effort: 'low',
    stream: false,
  };
}

function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) {
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status >= 200 && status < 300) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_FAILURE';
}

function transportFailureCode(error: unknown, timedOut: boolean): ProviderErrorCode {
  if (
    timedOut ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return 'TIMEOUT';
  }
  return error instanceof TypeError ? 'NETWORK_FAILURE' : 'PROVIDER_UNAVAILABLE';
}

async function postJson(
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImplementation,
  timeoutMs: number
): Promise<HttpResponseText> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    throw new NvidiaProviderError(transportFailureCode(error, timedOut));
  } finally {
    clearTimeout(timeout);
  }
}

function readAssistantContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }

  const choice = value.choices[0];
  if (!isRecord(choice)) {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  if (choice.finish_reason === 'length') {
    throw new NvidiaProviderError('INCOMPLETE_PROVIDER_RESPONSE');
  }
  if (!isRecord(choice.message)) {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  if (
    choice.message.role !== 'assistant' ||
    typeof choice.message.content !== 'string' ||
    choice.message.content.trim().length === 0
  ) {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  if (choice.finish_reason !== 'stop') {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  return choice.message.content;
}

async function requestCompletion(
  apiKey: string,
  request: GenerationRequest,
  modelId: string,
  fetchImpl: FetchImplementation,
  timeoutMs: number
): Promise<string> {
  const response = await postJson(
    apiKey,
    createPayload(request, modelId),
    fetchImpl,
    timeoutMs
  );
  if (response.status !== 200) {
    throw new NvidiaProviderError(classifyHttpStatus(response.status));
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(response.text);
  } catch {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  const content = readAssistantContent(envelope);
  if (apiKey && content.includes(apiKey)) {
    throw new NvidiaProviderError('PROVIDER_FAILURE');
  }
  return content;
}

function parseGenerationResponse(content: string): GenerationResponse {
  let response: unknown;
  try {
    response = JSON.parse(content);
  } catch {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  if (
    !isRecord(response) ||
    typeof response.cycleId !== 'string' ||
    !Array.isArray(response.results)
  ) {
    throw new NvidiaProviderError('MALFORMED_PROVIDER_RESPONSE');
  }
  return response as unknown as GenerationResponse;
}

export class NvidiaProvider implements GenerationInterface {
  constructor(
    private readonly apiKey: string,
    private readonly modelId = NVIDIA_MODEL,
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly timeoutMs = NVIDIA_REQUEST_TIMEOUT_MS
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    if (!NVIDIA_MODELS.has(this.modelId)) {
      throw new NvidiaProviderError('INVALID_REQUEST');
    }
    const content = await requestCompletion(
      this.apiKey,
      request,
      this.modelId,
      this.fetchImpl,
      this.timeoutMs
    );
    return parseGenerationResponse(content);
  }
}

export async function validateNvidiaCredential(
  apiKey: string,
  modelId: string,
  fetchImpl: FetchImplementation = fetch,
  timeoutMs = NVIDIA_REQUEST_TIMEOUT_MS
): Promise<void> {
  if (!NVIDIA_MODELS.has(modelId)) {
    throw new NvidiaProviderError('INVALID_REQUEST');
  }

  const probeRequest: GenerationRequest = {
    cycleId: 'nvidia-credential-validation',
    pageId: 'nvidia-credential-validation',
    questions: [{
      questionId: 'nvidia-validation-question',
      text: 'In one short sentence, describe a benefit of labeling shared garden tools.',
      type: 'short-text',
      required: true,
      options: [],
    }],
    settledContext: [],
  };
  const content = await requestCompletion(
    apiKey,
    probeRequest,
    modelId,
    fetchImpl,
    timeoutMs
  );
  parseGenerationResponse(content);
}