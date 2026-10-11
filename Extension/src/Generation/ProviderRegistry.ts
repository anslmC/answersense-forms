import type { GenerationInterface } from './Contract';
import {
  GeminiProvider,
  GEMINI_MODEL,
  validateGeminiCredential,
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

const geminiModels: readonly ModelDefinition[] = Object.freeze([
  Object.freeze({
    modelId: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    providerId: GEMINI_PROVIDER_ID,
    endpointHost: GEMINI_ENDPOINT_HOST,
  }),
  Object.freeze({
    modelId: GEMINI_MODEL,
    displayName: 'Gemini 3.1 Flash-Lite',
    providerId: GEMINI_PROVIDER_ID,
    endpointHost: GEMINI_ENDPOINT_HOST,
  }),
]);

const geminiProvider: ProviderDefinition = Object.freeze({
  providerId: GEMINI_PROVIDER_ID,
  displayName: 'Gemini',
  adapterId: GEMINI_ADAPTER_ID,
  models: geminiModels,
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
  secret: string,
  modelId?: string
) => GenerationInterface;

export type ProviderCredentialValidator = (
  secret: string,
  modelId: string
) => Promise<void>;

const STATIC_ADAPTERS: Readonly<Record<string, ProviderAdapterFactory>> =
  Object.freeze({
    [GEMINI_ADAPTER_ID]: (secret, modelId = GEMINI_MODEL) =>
      new GeminiProvider(secret, undefined, modelId),
  });

const STATIC_CREDENTIAL_VALIDATORS: Readonly<
  Record<string, ProviderCredentialValidator>
> = Object.freeze({
  [GEMINI_PROVIDER_ID]: (secret) => validateGeminiCredential(secret),
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

export function resolveCredentialValidator(
  providerId: unknown,
  modelId: unknown
): ProviderCredentialValidator | null {
  const resolved = resolveProviderModel(providerId, modelId);
  if (!resolved || !resolved.provider.supportsValidation) {
    return null;
  }
  return STATIC_CREDENTIAL_VALIDATORS[resolved.provider.providerId] ?? null;
}
