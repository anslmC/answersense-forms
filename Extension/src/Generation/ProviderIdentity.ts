export const GEMINI_PROVIDER_ID = 'gemini';
export const NVIDIA_PROVIDER_ID = 'nvidia';

export type RecognizedProviderId =
  typeof GEMINI_PROVIDER_ID | typeof NVIDIA_PROVIDER_ID;

export const GEMINI_SERVER_BUSY_MESSAGE =
  'Gemini servers are busy. Please try again later.';
export const NVIDIA_SERVER_BUSY_MESSAGE =
  'NVIDIA servers are busy. Please try again later.';

const SERVER_BUSY_MESSAGES: Record<RecognizedProviderId, string> = {
  [GEMINI_PROVIDER_ID]: GEMINI_SERVER_BUSY_MESSAGE,
  [NVIDIA_PROVIDER_ID]: NVIDIA_SERVER_BUSY_MESSAGE,
};

export function isRecognizedProviderId(
  value: unknown
): value is RecognizedProviderId {
  return value === GEMINI_PROVIDER_ID || value === NVIDIA_PROVIDER_ID;
}

export function serverBusyMessageForProvider(
  providerId: unknown
): string | null {
  return isRecognizedProviderId(providerId)
    ? SERVER_BUSY_MESSAGES[providerId]
    : null;
}
