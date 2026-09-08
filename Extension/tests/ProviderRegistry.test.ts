import { describe, expect, it } from 'vitest';
import {
  GEMINI_ADAPTER_ID,
  GEMINI_ENDPOINT_HOST,
  GEMINI_PROVIDER_ID,
  PROVIDER_REGISTRY,
  resolveAdapter,
  resolveModel,
  resolveProvider,
  resolveProviderAdapter,
  resolveProviderModel,
} from '../src/Generation/ProviderRegistry';
import { GeminiProvider, GEMINI_MODEL } from '../src/Generation/GeminiProvider';

describe('compiled provider registry', () => {
  it('registers Gemini and its supported model', () => {
    expect(PROVIDER_REGISTRY).toHaveLength(1);
    expect(resolveProvider(GEMINI_PROVIDER_ID)).toMatchObject({
      providerId: GEMINI_PROVIDER_ID,
      adapterId: GEMINI_ADAPTER_ID,
      endpointHost: GEMINI_ENDPOINT_HOST,
      supportsValidation: true,
      credentialRequirements: { secret: true },
    });
    expect(resolveModel(GEMINI_PROVIDER_ID, GEMINI_MODEL)).toMatchObject({
      modelId: GEMINI_MODEL,
      providerId: GEMINI_PROVIDER_ID,
      endpointHost: GEMINI_ENDPOINT_HOST,
    });
  });

  it('resolves a valid provider/model pair and its static adapter', () => {
    const resolved = resolveProviderModel(GEMINI_PROVIDER_ID, GEMINI_MODEL);
    expect(resolved?.provider.providerId).toBe(GEMINI_PROVIDER_ID);
    expect(resolved?.model.modelId).toBe(GEMINI_MODEL);

    const factory = resolveProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODEL);
    expect(factory).not.toBeNull();
    expect(factory?.('test-secret')).toBeInstanceOf(GeminiProvider);
    expect(resolveAdapter(GEMINI_ADAPTER_ID)).toBe(factory);
  });

  it('rejects unsupported providers, models, and adapters', () => {
    expect(resolveProvider('unsupported-provider')).toBeNull();
    expect(resolveProviderModel('unsupported-provider', GEMINI_MODEL)).toBeNull();
    expect(resolveModel(GEMINI_PROVIDER_ID, 'unsupported-model')).toBeNull();
    expect(resolveProviderAdapter(GEMINI_PROVIDER_ID, 'unsupported-model')).toBeNull();
    expect(resolveAdapter('unsupported-adapter')).toBeNull();
    expect(resolveProvider(null)).toBeNull();
    expect(resolveModel(GEMINI_PROVIDER_ID, 42)).toBeNull();
  });

  it('keeps registry metadata and static mappings internally consistent', () => {
    for (const provider of PROVIDER_REGISTRY) {
      expect(Object.isFrozen(provider)).toBe(true);
      expect(Object.isFrozen(provider.models)).toBe(true);
      expect(resolveAdapter(provider.adapterId)).not.toBeNull();
      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(Object.isFrozen(model)).toBe(true);
        expect(model.providerId).toBe(provider.providerId);
        expect(model.endpointHost).toBe(provider.endpointHost);
        expect(resolveModel(provider.providerId, model.modelId)).toBe(model);
      }
    }
  });

  it('does not allow runtime input to define endpoints, models, or adapters', () => {
    const runtimeProvider = {
      providerId: GEMINI_PROVIDER_ID,
      modelId: 'https://attacker.example/model',
      adapterId: 'attacker-adapter',
      endpointHost: 'attacker.example',
    };

    expect(resolveProvider(runtimeProvider.providerId)?.endpointHost).toBe(
      GEMINI_ENDPOINT_HOST
    );
    expect(
      resolveProviderModel(runtimeProvider.providerId, runtimeProvider.modelId)
    ).toBeNull();
    expect(resolveAdapter(runtimeProvider.adapterId)).toBeNull();
    expect(PROVIDER_REGISTRY).not.toContain(runtimeProvider);
  });
});
