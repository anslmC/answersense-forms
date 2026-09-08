import type { GenerationInterface } from './Contract';
import {
  GeminiProvider,
  GEMINI_MODEL,
} from './GeminiProvider';

export const GEMINI_PROVIDER_ID = 'gemini';
export const GEMINI_ADAPTER_ID = 'gemini';
export const GEMINI_ENDPOINT_HOST = 'generativelanguage.googleapis.com';

export interface ModelDefinition {
  readonly modelId: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly endpointHost: string;
}

export interface ProviderDefinition {
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterId: string;
  readonly models: readonly ModelDefinition[];
  readonly credentialRequirements: {
    readonly secret: true;
  };
  readonly supportsValidation: boolean;
  readonly endpointHost: string;
}

const geminiModel: ModelDefinition = Object.freeze({
  modelId: GEMINI_MODEL,
  displayName: 'Gemini 3.1 Flash-Lite',
  providerId: GEMINI_PROVIDER_ID,
  endpointHost: GEMINI_ENDPOINT_HOST,
});

const geminiProvider: ProviderDefinition = Object.freeze({
  providerId: GEMINI_PROVIDER_ID,
  displayName: 'Gemini',
  adapterId: GEMINI_ADAPTER_ID,
  models: Object.freeze([geminiModel]),
  credentialRequirements: Object.freeze({ secret: true }),
  supportsValidation: true,
  endpointHost: GEMINI_ENDPOINT_HOST,
});

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = Object.freeze([
  geminiProvider,
]);

const providersById: Readonly<Record<string, ProviderDefinition>> =
  Object.freeze(
    Object.fromEntries(
      PROVIDER_REGISTRY.map((provider) => [provider.providerId, provider])
    )
  );

export type ProviderAdapterFactory = (
  secret: string
) => GenerationInterface;

const STATIC_ADAPTERS: Readonly<Record<string, ProviderAdapterFactory>> =
  Object.freeze({
    [GEMINI_ADAPTER_ID]: (secret) => new GeminiProvider(secret),
  });

export function resolveProvider(
  providerId: unknown
): ProviderDefinition | null {
  if (typeof providerId !== 'string') {
    return null;
  }
  return providersById[providerId] ?? null;
}

export function resolveModel(
  providerId: unknown,
  modelId: unknown
): ModelDefinition | null {
  const provider = resolveProvider(providerId);
  if (!provider || typeof modelId !== 'string') {
    return null;
  }
  return (
    provider.models.find((model) => model.modelId === modelId) ?? null
  );
}

export function resolveProviderModel(
  providerId: unknown,
  modelId: unknown
): { provider: ProviderDefinition; model: ModelDefinition } | null {
  const provider = resolveProvider(providerId);
  const model = resolveModel(providerId, modelId);
  return provider && model ? { provider, model } : null;
}

export function resolveAdapter(
  adapterId: unknown
): ProviderAdapterFactory | null {
  if (typeof adapterId !== 'string') {
    return null;
  }
  return STATIC_ADAPTERS[adapterId] ?? null;
}

export function resolveProviderAdapter(
  providerId: unknown,
  modelId: unknown
): ProviderAdapterFactory | null {
  const resolved = resolveProviderModel(providerId, modelId);
  return resolved ? resolveAdapter(resolved.provider.adapterId) : null;
}
