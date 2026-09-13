export interface ModelOption {
  modelId: string;
  displayName: string;
}

export interface ProviderOption {
  providerId: string;
  displayName: string;
  models: ModelOption[];
  supportsValidation: boolean;
}

export interface Credential {
  credentialId: string;
  providerId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface Configuration {
  providerId: string;
  modelId: string;
  credentialId: string;
  providerConfig: Record<string, unknown>;
}

export interface Validation {
  configurationDigest: string;
  providerId: string;
  modelId: string;
  credentialId: string;
  status: 'VALID' | 'INVALID';
  validatedAt: string;
  failureCode?: string;
}

export interface ConfigurationState {
  providers: ProviderOption[];
  credentials: Credential[];
  activeConfiguration: Configuration | null;
  configurationDigest: string | null;
  configurationRevision: number;
  validation: Validation | null;
}

export type ValidationStatus =
  'NOT_VALIDATED' | 'VALIDATING' | 'VALID' | 'INVALID';

export function modelsForProvider(
  state: ConfigurationState,
  providerId: string
): ModelOption[] {
  return (
    state.providers.find((provider) => provider.providerId === providerId)
      ?.models ?? []
  );
}

export function isCurrentValidationValid(
  state: ConfigurationState
): boolean {
  const configuration = state.activeConfiguration;
  const validation = state.validation;
  return Boolean(
    configuration &&
    state.credentials.some(
      (credential) => credential.credentialId === configuration.credentialId
    ) &&
    state.configurationDigest &&
    validation?.status === 'VALID' &&
    validation.configurationDigest === state.configurationDigest &&
    validation.providerId === configuration.providerId &&
    validation.modelId === configuration.modelId &&
    validation.credentialId === configuration.credentialId
  );
}

export const VALID_GENERATION_MESSAGE =
  'Configuration is valid. Generate is available on a supported page.';

export function validGenerationMessage(
  state: ConfigurationState
): string | null {
  return isCurrentValidationValid(state) ? VALID_GENERATION_MESSAGE : null;
}

export function authorizationStatus(
  state: ConfigurationState,
  validating: boolean,
  configurationDirty = false
): string {
  if (configurationDirty && !validating) {
    return 'NOT VALIDATED — Save the configuration before validating';
  }
  const status = validationStatus(state, validating);
  if (
    status === 'NOT_VALIDATED' &&
    (!state.activeConfiguration || state.credentials.length === 0)
  ) {
    return 'NOT VALIDATED — Save the configuration before validating';
  }
  if (
    status === 'NOT_VALIDATED' &&
    state.activeConfiguration &&
    state.credentials.some(
      (credential) =>
        credential.credentialId === state.activeConfiguration?.credentialId
    )
  ) {
    return 'NOT VALIDATED — Configuration saved. Validate it before generating.';
  }
  return status.replace(/_/g, ' ');
}

export function validationStatus(
  state: ConfigurationState,
  validating: boolean
): ValidationStatus {
  if (validating) {
    return 'VALIDATING';
  }
  if (isCurrentValidationValid(state)) {
    return 'VALID';
  }
  return state.validation?.status === 'INVALID' ? 'INVALID' : 'NOT_VALIDATED';
}
