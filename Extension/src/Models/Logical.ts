import type { SupportedQuestionType } from '../../../Shared/QuestionTypes';

export type { SupportedQuestionType } from '../../../Shared/QuestionTypes';

export type AnswerValue = string | string[];

export interface Answer {
  questionId: string | null;
  value: AnswerValue;
}

export interface ExistingInput {
  value: AnswerValue | null;
  hasValue: boolean;
}

export interface LogicalOption {
  label: string;
  selected: boolean;
}

export interface Question {
  id: string | null;
  text: string | null;
  type: SupportedQuestionType | null;
  required: boolean;
  options: LogicalOption[];
  existingInput: ExistingInput | null;
  supported: boolean;
  unsupportedReason: string | null;
}

export type QuestionResultStatus =
  | 'ready'
  | 'unsupported'
  | 'GENERATED'
  | 'ABSTAINED'
  | 'GENERATION_FAILED'
  | 'VALIDATION_FAILED';

export interface QuestionResult {
  questionId: string | null;
  status: QuestionResultStatus;
  answer: Answer | null;
  reason: string | null;
}

export interface ProcessingCycle {
  cycleId: string;
}

export interface PageEntryRange {
  first: number;
  last: number;
}

export interface Form {
  formId: string | null;
  activePageId: string;
  questions: Question[];
  pageFingerprint?: string;
  pageEntryRange?: PageEntryRange;
}

export interface NormalizedActivePage {
  form: Form;
  questionResults: QuestionResult[];
  processingCycle: ProcessingCycle;
}
