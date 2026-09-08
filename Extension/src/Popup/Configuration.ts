export interface PopupModelOption {
  modelId: string;
  displayName: string;
}

export interface PopupProviderOption {
  providerId: string;
  displayName: string;
  models: PopupModelOption[];
  supportsValidation: boolean;
}

export interface PopupCredential {
  credentialId: string;
  providerId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface PopupConfiguration {
  providerId: string;
  modelId: string;
  credentialId: string;
  providerConfig: Record<string, unknown>;
}

export interface PopupValidation {
  configurationDigest: string;
  providerId: string;
  modelId: string;
  credentialId: string;
  status: 'VALID' | 'INVALID';
  validatedAt: string;
  failureCode?: string;
}

export interface PopupConfigurationState {
  providers: PopupProviderOption[];
  credentials: PopupCredential[];
  activeConfiguration: PopupConfiguration | null;
  configurationDigest: string | null;
  configurationRevision: number;
  validation: PopupValidation | null;
}

export type PopupValidationStatus =
  'NOT_VALIDATED' | 'VALIDATING' | 'VALID' | 'INVALID';

export function modelsForProvider(
  state: PopupConfigurationState,
  providerId: string
): PopupModelOption[] {
  return (
    state.providers.find((provider) => provider.providerId === providerId)
      ?.models ?? []
  );
}

export function isCurrentValidationValid(
  state: PopupConfigurationState
): boolean {
  const configuration = state.activeConfiguration;
  const validation = state.validation;
  return Boolean(
    configuration &&
    state.configurationDigest &&
    validation?.status === 'VALID' &&
    validation.configurationDigest === state.configurationDigest &&
    validation.providerId === configuration.providerId &&
    validation.modelId === configuration.modelId &&
    validation.credentialId === configuration.credentialId
  );
}

export function validationStatus(
  state: PopupConfigurationState,
  validating: boolean
): PopupValidationStatus {
  if (validating) {
    return 'VALIDATING';
  }
  if (isCurrentValidationValid(state)) {
    return 'VALID';
  }
  return state.validation?.status === 'INVALID' ? 'INVALID' : 'NOT_VALIDATED';
}
