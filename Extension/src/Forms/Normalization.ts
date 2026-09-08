import type {
  DiscoveredPage,
  DiscoveredQuestion,
  UnsupportedQuestion,
} from './Discovery';
import type {
  ExistingInput,
  Form,
  LogicalOption,
  NormalizedActivePage,
  Question,
  QuestionResult,
} from '../Models/Logical';

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function computePageFingerprint(form: Form): string {
  const content = form.questions.map((question) => ({
    id: question.id,
    text: question.text,
    type: question.type,
    required: question.required,
    options: question.options.map((option) => option.label),
  }));

  return stableHash(JSON.stringify(content));
}

function normalizeExistingInput(question: DiscoveredQuestion): ExistingInput {
  const value = question.existingValue;
  return {
    value,
    hasValue: value !== null,
  };
}

function normalizeSupportedQuestion(question: DiscoveredQuestion): Question {
  const options: LogicalOption[] = question.options.map((option) => ({
    ...option,
  }));
  return {
    id: question.id,
    text: question.text,
    type: question.type,
    required: question.required,
    options,
    existingInput: normalizeExistingInput(question),
    supported: true,
    unsupportedReason: null,
  };
}

function normalizeUnsupportedQuestion(question: UnsupportedQuestion): Question {
  return {
    id: question.id,
    text: question.text,
    type: null,
    required: false,
    options: [],
    existingInput: null,
    supported: false,
    unsupportedReason: question.reason,
  };
}

function normalizeQuestion(
  question: DiscoveredQuestion | UnsupportedQuestion
): Question {
  return question.kind === 'supported'
    ? normalizeSupportedQuestion(question)
    : normalizeUnsupportedQuestion(question);
}

function createQuestionResult(question: Question): QuestionResult {
  return {
    questionId: question.id,
    status: question.supported ? 'ready' : 'unsupported',
    answer: null,
    reason: question.unsupportedReason,
  };
}

export function normalizeDiscoveredActivePage(
  page: DiscoveredPage,
  cycleId = 'discovery'
): NormalizedActivePage {
  const questions = page.questions.map(normalizeQuestion);
  const form: Form = {
    formId: page.formId ?? null,
    activePageId: page.pageId,
    questions,
    pageFingerprint: computePageFingerprint({
      formId: page.formId ?? null,
      activePageId: page.pageId,
      questions,
    }),
  };
  if (page.pageEntryRange) {
    form.pageEntryRange = page.pageEntryRange;
  }

  return {
    form,
    questionResults: questions.map(createQuestionResult),
    processingCycle: { cycleId },
  };
}
