export const GEMINI_API_KEY_STORAGE_KEY = 'geminiApiKey';

export interface CredentialStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const chromeCredentialStorage: CredentialStorage = {
  get: (key) => chrome.storage.local.get(key),
  set: (values) => chrome.storage.local.set(values),
  remove: (key) => chrome.storage.local.remove(key),
};

export async function hasGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<boolean> {
  const values = await storage.get(GEMINI_API_KEY_STORAGE_KEY);
  return (
    typeof values[GEMINI_API_KEY_STORAGE_KEY] === 'string' &&
    values[GEMINI_API_KEY_STORAGE_KEY].trim().length > 0
  );
}

export async function storeGeminiCredential(
  apiKey: string,
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new Error('A Gemini API key is required.');
  }
  await storage.set({ [GEMINI_API_KEY_STORAGE_KEY]: normalizedKey });
}

export async function deleteGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<void> {
  await storage.remove(GEMINI_API_KEY_STORAGE_KEY);
}

export async function readGeminiCredential(
  storage: CredentialStorage = chromeCredentialStorage
): Promise<string | null> {
  const values = await storage.get(GEMINI_API_KEY_STORAGE_KEY);
  const apiKey = values[GEMINI_API_KEY_STORAGE_KEY];
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
}
