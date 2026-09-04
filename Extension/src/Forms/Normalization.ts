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

function normalizeExistingInput(question: DiscoveredQuestion): ExistingInput {
  const value = question.existingValue;
  return {
    value,
    hasValue: value !== null,
  };
}

function normalizeSupportedQuestion(question: DiscoveredQuestion): Question {
  const options: LogicalOption[] = question.options.map((option) => ({ ...option }));
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
  question: DiscoveredQuestion | UnsupportedQuestion,
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
  cycleId = 'discovery',
): NormalizedActivePage {
  const questions = page.questions.map(normalizeQuestion);
  const form: Form = {
    formId: null,
    activePageId: page.pageId,
    questions,
  };

  return {
    form,
    questionResults: questions.map(createQuestionResult),
    processingCycle: { cycleId },
  };
}