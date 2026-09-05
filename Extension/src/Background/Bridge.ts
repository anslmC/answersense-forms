import type { GenerationRequest, GenerationResponse } from '../Generation/Contract';

export const BACKEND_GENERATE_URL = 'http://127.0.0.1:3000/generate';

export type BridgeErrorCode =
  | 'UNSUPPORTED_PAGE'
  | 'DISCOVERY_FAILED'
  | 'GENERATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'FILL_FAILED'
  | 'NAVIGATION_FAILED'
  | 'STALE_OPERATION';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

export async function requestBackendGeneration(
  request: GenerationRequest,
): Promise<GenerationResponse> {
  const response = await fetch(BACKEND_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`Backend generation failed (${response.status}).`);
  }
  return (await response.json()) as GenerationResponse;
}
