import {
  encryptCredentialState,
  getEncryptedCredentialState,
  isEncryptedCredentialState,
} from './EncryptedCredentialStorage';

export const GEMINI_API_KEY_STORAGE_KEY = 'geminiApiKey';
export const CONFIGURATION_STATE_STORAGE_KEY = 'answerSenseConfigurationState';

const GEMINI_PROVIDER_ID = 'gemini';

export interface CredentialRecord {
  credentialId: string;
  providerId: string;
  label: string;
  secret: string;
  createdAt: string;
  updatedAt: string;
}

export type RedactedCredentialRecord = Omit<CredentialRecord, 'secret'>;

export interface Configuration {
  providerId: string;
  modelId: string;
  credentialId: string;
  providerConfig: Record<string, unknown>;
}

export interface ConfigurationIdentity {
  canonical: string;
  digest: string;
}

export interface ValidationRecord {
  configurationDigest: string;
  providerId: string;
  modelId: string;
  credentialId: string;
  status: 'VALID' | 'INVALID';
  validatedAt: string;
  failureCode?: string;
}

interface ConfigurationState {
  revision: number;
  credentials: CredentialRecord[];
  activeConfiguration: Configuration | null;
  validations: ValidationRecord[];
}

export interface CredentialStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const chromeCredentialStorage: CredentialStorage = {
  get: async (key) => {
    const values = await chrome.storage.local.get(key);
    if (key !== CONFIGURATION_STATE_STORAGE_KEY) {
      return values;
    }
    const storedState = values[key];
    if (storedState !== undefined && !isEncryptedCredentialState(storedState)) {
      const encryptedState = await encryptCredentialState(storedState);
      await chrome.storage.local.set({ [key]: encryptedState });
    }
    return {
      [key]: await getEncryptedCredentialState(storedState),
    };
  },
  set: async (values) => {
    if (!(CONFIGURATION_STATE_STORAGE_KEY in values)) {
      await chrome.storage.local.set(values);
      return;
    }
    await chrome.storage.local.set({
      ...values,
      [CONFIGURATION_STATE_STORAGE_KEY]: await encryptCredentialState(
        values[CONFIGURATION_STATE_STORAGE_KEY]
      ),
    });
  },
  remove: (key) => chrome.storage.local.remove(key),
};

export interface CredentialInput {
  providerId: string;
  label: string;
  secret: string;
}

/**
 * Configuration state is stored as a single record, so every mutation is a
 * read-modify-write. Mutations are serialized through this queue; reads do not
 * wait for it and therefore observe the last committed state (never a partial
 * write). A failed operation is reported to its caller and then removed from
 * the queue so it cannot block later operations.
 */
let mutationTail: Promise<unknown> = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function normalizeLabel(label: string): string {
  return label.trim();
}

function normalizeProviderConfig(
  providerConfig: Record<string, unknown> | undefined
): Record<string, unknown> {
  return providerConfig ? { ...providerConfig } : {};
}

function emptyState(): ConfigurationState {
  return {
    revision: 0,
    credentials: [],
    activeConfiguration: null,
    validations: [],
  };
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  return (
    isRecord(value) &&
    typeof value.credentialId === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.label === 'string' &&
    typeof value.secret === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isConfiguration(value: unknown): value is Configuration {
  return (
    isRecord(value) &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.credentialId === 'string' &&
    isRecord(value.providerConfig) &&
    !Array.isArray(value.providerConfig)
  );
}

function isValidationRecord(value: unknown): value is ValidationRecord {
  return (
    isRecord(value) &&
    typeof value.configurationDigest === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.credentialId === 'string' &&
    (value.status === 'VALID' || value.status === 'INVALID') &&
    typeof value.validatedAt === 'string' &&
    (value.failureCode === undefined || typeof value.failureCode === 'string')
  );
}

function parseState(value: unknown): ConfigurationState {
  if (!isRecord(value)) {
    return emptyState();
  }
  return {
    revision:
      typeof value.revision === 'number' &&
      Number.isInteger(value.revision) &&
      value.revision >= 0
        ? value.revision
        : 0,
    credentials: Array.isArray(value.credentials)
      ? value.credentials.filter(isCredentialRecord)
      : [],
    activeConfiguration:
      value.activeConfiguration === null ||
      value.activeConfiguration === undefined
        ? null
        : isConfiguration(value.activeConfiguration)
          ? {
              ...value.activeConfiguration,
              providerConfig: normalizeProviderConfig(
                value.activeConfiguration.providerConfig
              ),
            }
          : null,
    validations: Array.isArray(value.validations)
      ? value.validations.filter(isValidationRecord)
      : [],
  };
}

function redactCredential(record: CredentialRecord): RedactedCredentialRecord {
  const { secret: _secret, ...redacted } = record;
  return redacted;
}

function createId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function bumpRevision(state: ConfigurationState): void {
  state.revision += 1;
}

async function saveState(
  state: ConfigurationState,
  storage: CredentialStorage
): Promise<void> {
  await storage.set({ [CONFIGURATION_STATE_STORAGE_KEY]: state });
}

async function readStoredState(
  storage: CredentialStorage
): Promise<ConfigurationState> {
  const values = await storage.get(CONFIGURATION_STATE_STORAGE_KEY);
  return parseState(values[CONFIGURATION_STATE_STORAGE_KEY]);
}

async function readLegacySecret(
  storage: CredentialStorage
): Promise<string | null> {
  const values = await storage.get(GEMINI_API_KEY_STORAGE_KEY);
  const legacySecret = values[GEMINI_API_KEY_STORAGE_KEY];
  return typeof legacySecret === 'string' && legacySecret.trim()
    ? legacySecret.trim()
    : null;
}

/**
 * Imports the legacy single-key Gemini storage entry exactly once. Callers must
 * hold the mutation queue so concurrent reads cannot import the same secret
 * twice, and the imported state is re-read inside the critical section.
 */
async function importLegacyGeminiSecret(
  storage: CredentialStorage,
  secret: string
): Promise<ConfigurationState> {
  const state = await readStoredState(storage);
  const alreadyMigrated = state.credentials.some(
    (credential) =>
      credential.providerId === GEMINI_PROVIDER_ID &&
      credential.secret === secret
  );
  if (!alreadyMigrated) {
    const timestamp = now();
    state.credentials.push({
      credentialId: createId(),
      providerId: GEMINI_PROVIDER_ID,
      label: 'Gemini credential',
      secret,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    bumpRevision(state);
    await saveState(state, storage);
  }
  await storage.remove(GEMINI_API_KEY_STORAGE_KEY);
  return state;
}

/**
 * Loads the committed configuration state.
 *
 * `serialized` marks a caller that already holds the mutation queue, so the
 * legacy import runs inline rather than deadlocking on a nested queue entry.
 */
async function loadState(
  storage: CredentialStorage,
  options: { serialized?: boolean } = {}
): Promise<ConfigurationState> {
  const state = await readStoredState(storage);
  const legacySecret = await readLegacySecret(storage);
  if (!legacySecret) {
    return state;
  }
  if (options.serialized) {
    return importLegacyGeminiSecret(storage, legacySecret);
  }
  return serializeMutation(() =>
    importLegacyGeminiSecret(storage, legacySecret)
  );
}

function credentialById(
  state: ConfigurationState,
  credentialId: string
): CredentialRecord | null {
  return (
    state.credentials.find(
      (credential) => credential.credentialId === credentialId
    ) ?? null
  );
}

function validateCredentialInput(input: CredentialInput): CredentialInput {
  const providerId = normalizeIdentifier(input.providerId, 'Provider ID');
  const secret = input.secret.trim();
  if (!secret) {
    throw new Error('A credential secret is required.');
  }
  return { providerId, label: normalizeLabel(input.label), secret };
}

export async function listCredentials(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<RedactedCredentialRecord[]> {
  const state = await loadState(storage);
  return state.credentials.map(redactCredential);
}

async function createCredentialUnlocked(
  input: CredentialInput,
  storage: CredentialStorage
): Promise<RedactedCredentialRecord> {
  const normalized = validateCredentialInput(input);
  const state = await loadState(storage, { serialized: true });
  const timestamp = now();
  const record: CredentialRecord = {
    credentialId: createId(),
    providerId: normalized.providerId,
    label: normalized.label,
    secret: normalized.secret,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.credentials.push(record);
  bumpRevision(state);
  await saveState(state, storage);
  return redactCredential(record);
}

export function createCredential(
  input: CredentialInput,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<RedactedCredentialRecord> {
  return serializeMutation(() => createCredentialUnlocked(input, storage));
}

export async function readCredentialSecret(
  credentialId: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<string | null> {
  const state = await loadState(storage);
  return credentialById(state, credentialId)?.secret ?? null;
}

export async function getActiveConfiguration(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<Configuration | null> {
  const state = await loadState(storage);
  return state.activeConfiguration
    ? {
        ...state.activeConfiguration,
        providerConfig: { ...state.activeConfiguration.providerConfig },
      }
    : null;
}

async function setActiveConfigurationUnlocked(
  configuration: Configuration,
  storage: CredentialStorage
): Promise<Configuration> {
  const normalized: Configuration = {
    providerId: normalizeIdentifier(configuration.providerId, 'Provider ID'),
    modelId: normalizeIdentifier(configuration.modelId, 'Model ID'),
    credentialId: normalizeIdentifier(
      configuration.credentialId,
      'Credential ID'
    ),
    providerConfig: normalizeProviderConfig(configuration.providerConfig),
  };
  const state = await loadState(storage, { serialized: true });
  const credential = credentialById(state, normalized.credentialId);
  if (!credential) {
    throw new Error('Credential not found.');
  }
  if (credential.providerId !== normalized.providerId) {
    throw new Error('Credential does not belong to the selected provider.');
  }
  state.activeConfiguration = normalized;
  bumpRevision(state);
  await saveState(state, storage);
  return normalized;
}

export function setActiveConfiguration(
  configuration: Configuration,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<Configuration> {
  return serializeMutation(() =>
    setActiveConfigurationUnlocked(configuration, storage)
  );
}

async function clearActiveConfigurationUnlocked(
  storage: CredentialStorage
): Promise<void> {
  const state = await loadState(storage, { serialized: true });
  state.activeConfiguration = null;
  bumpRevision(state);
  await saveState(state, storage);
}

export function clearActiveConfiguration(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  return serializeMutation(() => clearActiveConfigurationUnlocked(storage));
}

async function replaceCredentialUnlocked(
  credentialId: string,
  input: CredentialInput,
  storage: CredentialStorage
): Promise<RedactedCredentialRecord> {
  const normalized = validateCredentialInput(input);
  const state = await loadState(storage, { serialized: true });
  const existing = credentialById(state, credentialId);
  if (!existing) {
    throw new Error('Credential not found.');
  }
  if (existing.providerId !== normalized.providerId) {
    throw new Error('Credential does not belong to the selected provider.');
  }
  const timestamp = now();
  const replacement: CredentialRecord = {
    credentialId: createId(),
    providerId: normalized.providerId,
    label: normalized.label,
    secret: normalized.secret,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.credentials = state.credentials
    .filter((credential) => credential.credentialId !== credentialId)
    .concat(replacement);
  state.validations = state.validations.filter(
    (validation) => validation.credentialId !== credentialId
  );
  if (state.activeConfiguration?.credentialId === credentialId) {
    state.activeConfiguration = {
      ...state.activeConfiguration,
      providerId: replacement.providerId,
      credentialId: replacement.credentialId,
    };
  }
  bumpRevision(state);
  await saveState(state, storage);
  return redactCredential(replacement);
}

export function replaceCredential(
  credentialId: string,
  input: CredentialInput,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<RedactedCredentialRecord> {
  return serializeMutation(() =>
    replaceCredentialUnlocked(credentialId, input, storage)
  );
}

async function deleteCredentialUnlocked(
  credentialId: string,
  storage: CredentialStorage
): Promise<void> {
  const state = await loadState(storage, { serialized: true });
  state.credentials = state.credentials.filter(
    (credential) => credential.credentialId !== credentialId
  );
  state.validations = state.validations.filter(
    (validation) => validation.credentialId !== credentialId
  );
  if (state.activeConfiguration?.credentialId === credentialId) {
    state.activeConfiguration = null;
  }
  bumpRevision(state);
  await saveState(state, storage);
}

export function deleteCredential(
  credentialId: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  return serializeMutation(() =>
    deleteCredentialUnlocked(credentialId, storage)
  );
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalConfiguration(configuration: Configuration): string {
  const canonical = canonicalize({
    providerId: normalizeIdentifier(configuration.providerId, 'Provider ID'),
    modelId: normalizeIdentifier(configuration.modelId, 'Model ID'),
    credentialId: normalizeIdentifier(
      configuration.credentialId,
      'Credential ID'
    ),
    providerConfig: normalizeProviderConfig(configuration.providerConfig),
  });
  return JSON.stringify(canonical);
}

export async function configurationIdentity(
  configuration: Configuration
): Promise<ConfigurationIdentity> {
  const canonical = canonicalConfiguration(configuration);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return { canonical, digest: hex };
}

export async function getValidation(
  configurationDigest: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<ValidationRecord | null> {
  const state = await loadState(storage);
  return (
    state.validations.find(
      (validation) => validation.configurationDigest === configurationDigest
    ) ?? null
  );
}

export async function getConfigurationStateRevision(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<number> {
  return (await loadState(storage)).revision;
}

async function saveValidationUnlocked(
  validation: ValidationRecord,
  storage: CredentialStorage
): Promise<ValidationRecord> {
  const normalized: ValidationRecord = {
    ...validation,
    configurationDigest: normalizeIdentifier(
      validation.configurationDigest,
      'Configuration digest'
    ),
    providerId: normalizeIdentifier(validation.providerId, 'Provider ID'),
    modelId: normalizeIdentifier(validation.modelId, 'Model ID'),
    credentialId: normalizeIdentifier(validation.credentialId, 'Credential ID'),
  };
  if (normalized.status === 'INVALID' && normalized.failureCode) {
    normalized.failureCode = normalizeIdentifier(
      normalized.failureCode,
      'Failure code'
    );
    if (!/^[A-Z0-9_]+$/.test(normalized.failureCode)) {
      throw new Error('Failure code must be a safe structured code.');
    }
  }
  const state = await loadState(storage, { serialized: true });
  if (!credentialById(state, normalized.credentialId)) {
    throw new Error('Credential not found.');
  }
  state.validations = state.validations.filter(
    (current) => current.configurationDigest !== normalized.configurationDigest
  );
  state.validations.push(normalized);
  bumpRevision(state);
  await saveState(state, storage);
  return normalized;
}

export function saveValidation(
  validation: ValidationRecord,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<ValidationRecord> {
  return serializeMutation(() => saveValidationUnlocked(validation, storage));
}

async function invalidateValidationUnlocked(
  configurationDigest: string,
  storage: CredentialStorage
): Promise<void> {
  const state = await loadState(storage, { serialized: true });
  state.validations = state.validations.filter(
    (validation) => validation.configurationDigest !== configurationDigest
  );
  bumpRevision(state);
  await saveState(state, storage);
}

export function invalidateValidation(
  configurationDigest: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  return serializeMutation(() =>
    invalidateValidationUnlocked(configurationDigest, storage)
  );
}

export async function hasGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<boolean> {
  return (await readGeminiCredential(storage)) !== null;
}

async function storeGeminiCredentialUnlocked(
  apiKey: string,
  storage: CredentialStorage
): Promise<void> {
  if (!apiKey.trim()) {
    throw new Error('A Gemini API key is required.');
  }
  const state = await loadState(storage, { serialized: true });
  const geminiCredentials = state.credentials.filter(
    (credential) => credential.providerId === GEMINI_PROVIDER_ID
  );
  const existing = geminiCredentials[geminiCredentials.length - 1];
  if (existing) {
    await replaceCredentialUnlocked(
      existing.credentialId,
      { providerId: GEMINI_PROVIDER_ID, label: existing.label, secret: apiKey },
      storage
    );
    return;
  }
  await createCredentialUnlocked(
    {
      providerId: GEMINI_PROVIDER_ID,
      label: 'Gemini credential',
      secret: apiKey,
    },
    storage
  );
}

export function storeGeminiCredential(
  apiKey: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  return serializeMutation(() =>
    storeGeminiCredentialUnlocked(apiKey, storage)
  );
}

async function deleteGeminiCredentialUnlocked(
  storage: CredentialStorage
): Promise<void> {
  const state = await loadState(storage, { serialized: true });
  const geminiCredentials = state.credentials.filter(
    (credential) => credential.providerId === GEMINI_PROVIDER_ID
  );
  const existing = geminiCredentials[geminiCredentials.length - 1];
  if (existing) {
    await deleteCredentialUnlocked(existing.credentialId, storage);
  }
}

export function deleteGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  return serializeMutation(() => deleteGeminiCredentialUnlocked(storage));
}

export async function readGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<string | null> {
  const state = await loadState(storage);
  const geminiCredentials = state.credentials.filter(
    (candidate) => candidate.providerId === GEMINI_PROVIDER_ID
  );
  const credential = geminiCredentials[geminiCredentials.length - 1];
  return credential?.secret ?? null;
}
