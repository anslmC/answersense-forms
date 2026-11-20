import type { AnswerValue, SupportedQuestionType } from '../Models/Logical';
import type { GenerationPerformanceRecorder } from '../Shared/Performance';

export type ProviderErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INCOMPLETE_PROVIDER_RESPONSE'
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_FAILURE';

export type ProviderSafeMessageCode = 'SERVER_BUSY' | 'CONTEXT_OVERFLOW';

export function isProviderSafeMessageCode(
  value: unknown
): value is ProviderSafeMessageCode {
  return value === 'SERVER_BUSY' || value === 'CONTEXT_OVERFLOW';
}

export const PROVIDER_CONTEXT_OVERFLOW_MESSAGE =
  'The provider rejected the request because the shared context or individual question content exceeds the model input limit.';

export interface ProviderErrorContract {
  readonly safeCode: ProviderErrorCode;
  readonly safeMessageCode?: ProviderSafeMessageCode;
  readonly providerId?: string;
}

export interface GenerationQuestion {
  questionId: string;
  text: string;
  type: SupportedQuestionType;
  required: boolean;
  options: string[];
  answerParts?: number;
  hasVisualMaterial?: boolean;
  requiresUnavailableVisual?: boolean;
}

export interface SettledContextItem {
  questionId: string;
  questionText: string;
  answer: AnswerValue;
}

export interface GenerationRequest {
  cycleId: string;
  pageId: string;
  questions: GenerationQuestion[];
  settledContext: SettledContextItem[];
}

export interface GeneratedAnswer {
  questionId: string;
  value: AnswerValue;
}

export interface GenerationFailure {
  code: string;
  message: string;
}

export type GenerationAbstentionReason =
  'LOW_CONFIDENCE' | 'UNABLE_TO_DETERMINE' | 'NOT_APPLICABLE';

export interface GeneratedQuestionResult {
  questionId: string;
  status: 'GENERATED';
  answer: GeneratedAnswer;
}

export interface AbstainedQuestionResult {
  questionId: string;
  status: 'ABSTAINED';
  answer: null;
  reason: GenerationAbstentionReason;
}

export interface FailedQuestionResult {
  questionId: string;
  status: 'GENERATION_FAILED';
  answer: null;
  failure: GenerationFailure;
}

export type GenerationResult =
  GeneratedQuestionResult | AbstainedQuestionResult | FailedQuestionResult;

export interface GenerationResponse {
  cycleId: string;
  results: GenerationResult[];
}

export type ProviderProgressObserver = (finalizedQuestionCount: number) => void;

export interface GenerationInterface {
  generate(
    request: GenerationRequest,
    signal?: AbortSignal,
    performance?: GenerationPerformanceRecorder,
    onProgress?: ProviderProgressObserver
  ): Promise<GenerationResponse>;
}
