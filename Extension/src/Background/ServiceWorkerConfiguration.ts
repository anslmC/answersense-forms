import {
  getActiveConfiguration,
  configurationIdentity,
  getConfigurationStateRevision,
  getValidation,
  listCredentials,
  readCredentialSecret,
  type Configuration,
  type CredentialStorage,
  chromeCredentialStorage,
} from '../Generation/Credentials';
import {
  GEMINI_PROVIDER_ID,
  resolveAdapter,
  resolveProviderModel,
  type ModelDefinition,
  type ProviderAdapterFactory,
  type ProviderDefinition,
} from '../Generation/ProviderRegistry';
import { GEMINI_MODEL } from '../Generation/GeminiProvider';

export interface ResolvedProviderConfiguration {
  configuration: Configuration;
  configurationDigest: string;
  authorizationRevision: number;
  provider: ProviderDefinition;
  model: ModelDefinition;
  adapter: ProviderAdapterFactory;
  secret: string;
}

function isProviderConfiguration(
  configuration: Configuration
): boolean {
  return (
    typeof configuration.providerId === 'string' &&
    typeof configuration.modelId === 'string' &&
    typeof configuration.credentialId === 'string' &&
    typeof configuration.providerConfig === 'object' &&
    configuration.providerConfig !== null &&
    !Array.isArray(configuration.providerConfig)
  );
}

function defaultGeminiConfiguration(
  credentialId: string
): Configuration {
  return {
    providerId: GEMINI_PROVIDER_ID,
    modelId: GEMINI_MODEL,
    credentialId,
    providerConfig: {},
  };
}

export async function resolveActiveProviderConfiguration(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<ResolvedProviderConfiguration> {
  const startingRevision = await getConfigurationStateRevision(storage);
  const configured = await getActiveConfiguration(storage);
  const credentials = await listCredentials(storage);
  const configuration =
    configured ??
    (() => {
      const geminiCredentials = credentials.filter(
        (credential) => credential.providerId === GEMINI_PROVIDER_ID
      );
      const credential = geminiCredentials[geminiCredentials.length - 1];
      return credential ? defaultGeminiConfiguration(credential.credentialId) : null;
    })();

  if (!configuration || !isProviderConfiguration(configuration)) {
    throw new Error('Configuration required.');
  }

  const resolved = resolveProviderModel(
    configuration.providerId,
    configuration.modelId
  );
  if (!resolved) {
    throw new Error('Unsupported provider configuration.');
  }

  const adapter = resolveAdapter(resolved.provider.adapterId);
  if (!adapter) {
    throw new Error('Provider adapter unavailable.');
  }

  const credential = credentials.find(
    (candidate) => candidate.credentialId === configuration.credentialId
  );
  if (!credential || credential.providerId !== resolved.provider.providerId) {
    throw new Error('Credential configuration is invalid.');
  }

  const secret = await readCredentialSecret(configuration.credentialId, storage);
  if (!secret) {
    throw new Error('Credential configuration is invalid.');
  }

  const configurationDigest = (await configurationIdentity(configuration)).digest;
  const authorizationRevision = await getConfigurationStateRevision(storage);
  if (authorizationRevision !== startingRevision) {
    throw new Error('Configuration changed during authorization.');
  }

  return {
    configuration,
    configurationDigest,
    authorizationRevision,
    provider: resolved.provider,
    model: resolved.model,
    adapter,
    secret,
  };
}

export async function resolveAuthorizedProviderConfiguration(
  expectedDigest?: string,
  storage: CredentialStorage = chromeCredentialStorage,
  expectedRevision?: number
): Promise<ResolvedProviderConfiguration> {
  const resolved = await resolveActiveProviderConfiguration(storage);
  if (
    (expectedDigest && expectedDigest !== resolved.configurationDigest) ||
    (expectedRevision !== undefined &&
      expectedRevision !== resolved.authorizationRevision)
  ) {
    throw new Error('Configuration changed during generation.');
  }
  const validation = await getValidation(
    resolved.configurationDigest,
    storage
  );
  const finalRevision = await getConfigurationStateRevision(storage);
  if (finalRevision !== resolved.authorizationRevision) {
    throw new Error('Configuration changed during authorization.');
  }
  if (
    !validation ||
    validation.status !== 'VALID' ||
    validation.configurationDigest !== resolved.configurationDigest ||
    validation.providerId !== resolved.provider.providerId ||
    validation.modelId !== resolved.model.modelId ||
    validation.credentialId !== resolved.configuration.credentialId
  ) {
    throw new Error('Configuration is not validated.');
  }
  return resolved;
}
