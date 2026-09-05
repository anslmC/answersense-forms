export type SupportedQuestionType =
  | 'short-text'
  | 'paragraph'
  | 'single-choice'
  | 'multiple-choice'
  | 'dropdown';

export type AnswerValue = string | string[];

export interface GenerationQuestion {
  questionId: string;
  text: string;
  type: SupportedQuestionType;
  required: boolean;
  options: string[];
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

export interface GeneratedQuestionResult {
  questionId: string;
  status: 'GENERATED';
  answer: GeneratedAnswer;
}

export interface FailedQuestionResult {
  questionId: string;
  status: 'GENERATION_FAILED';
  failure: GenerationFailure;
}

export type GenerationResult =
  | GeneratedQuestionResult
  | FailedQuestionResult;

export interface GenerationResponse {
  cycleId: string;
  results: GenerationResult[];
}

export interface GenerationInterface {
  generate(request: GenerationRequest): Promise<GenerationResponse>;
}
