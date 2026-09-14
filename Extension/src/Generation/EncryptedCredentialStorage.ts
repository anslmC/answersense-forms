const KEY_DATABASE = 'answersense-credential-security';
const KEY_STORE = 'keys';
const KEY_ID = 'credential-encryption-key';
const ENVELOPE_VERSION = 1;
let ephemeralKey: CryptoKey | null = null;

interface EncryptedValue {
  version: number;
  iv: string;
  ciphertext: string;
}

function isEncryptedValue(value: unknown): value is EncryptedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EncryptedValue).version === ENVELOPE_VERSION &&
    typeof (value as EncryptedValue).iv === 'string' &&
    typeof (value as EncryptedValue).ciphertext === 'string'
  );
}

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function decode(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Credential key storage failed.'));
  });
}

async function readEncryptionKey(): Promise<CryptoKey> {
  if (typeof indexedDB === 'undefined') {
    if (!ephemeralKey) {
      ephemeralKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }
    return ephemeralKey;
  }
  const database = await openKeyDatabase();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(KEY_STORE, 'readonly')
      .objectStore(KEY_STORE)
      .get(KEY_ID);
    request.onsuccess = async () => {
      if (request.result) {
        resolve(request.result as CryptoKey);
        return;
      }
      try {
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        const transaction = database.transaction(KEY_STORE, 'readwrite');
        transaction.objectStore(KEY_STORE).put(key, KEY_ID);
        transaction.oncomplete = () => resolve(key);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Credential key storage failed.'));
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Credential key storage failed.'));
  });
}

async function encrypt(value: unknown): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    await readEncryptionKey(),
    plaintext
  );
  return {
    version: ENVELOPE_VERSION,
    iv: encode(iv.buffer as ArrayBuffer),
    ciphertext: encode(ciphertext),
  };
}

async function decrypt(value: EncryptedValue): Promise<unknown> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(value.iv) },
    await readEncryptionKey(),
    decode(value.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function getEncryptedCredentialState(
  value: unknown
): Promise<unknown> {
  return isEncryptedValue(value) ? decrypt(value) : value;
}

export function isEncryptedCredentialState(value: unknown): boolean {
  return isEncryptedValue(value);
}

export async function encryptCredentialState(value: unknown): Promise<EncryptedValue> {
  return encrypt(value);
}
