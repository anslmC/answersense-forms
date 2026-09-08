export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export class GeminiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConfigurationError';
  }
}

export function createGeminiConfig(
  environment: NodeJS.ProcessEnv = process.env
): GeminiConfig {
  const apiKey = environment.GEMINI_API_KEY?.trim();
  const model = environment.GEMINI_MODEL?.trim();
  const timeoutValue = environment.GEMINI_TIMEOUT_MS?.trim();

  if (!apiKey) {
    throw new GeminiConfigurationError('GEMINI_API_KEY is required.');
  }
  if (!model) {
    throw new GeminiConfigurationError('GEMINI_MODEL is required.');
  }

  const timeoutMs = Number(timeoutValue ?? '30000');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GeminiConfigurationError(
      'GEMINI_TIMEOUT_MS must be a positive integer.'
    );
  }

  return { apiKey, model, timeoutMs };
}
