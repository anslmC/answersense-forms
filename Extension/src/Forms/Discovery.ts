export type { SupportedQuestionType } from '../Models/Logical';
import type { SupportedQuestionType } from '../Models/Logical';

export interface DiscoveredOption {
  label: string;
  selected: boolean;
}

export interface DiscoveredQuestion {
  kind: 'supported';
  id: string | null;
  text: string;
  type: SupportedQuestionType;
  required: boolean;
  options: DiscoveredOption[];
  existingValue: string | string[] | null;
}

export interface UnsupportedQuestion {
  kind: 'unsupported';
  id: string | null;
  text: string | null;
  reason: string;
}

export interface DiscoveredPage {
  pageId: string;
  questions: Array<DiscoveredQuestion | UnsupportedQuestion>;
}

const activePageSelector = [
  '[data-answersense-active-page="true"]',
  '[data-page-active="true"]',
  '[aria-current="page"]',
  '.freebirdFormviewerViewPage[style*="display: block"]',
].join(', ');

const pageSelector = [
  '[data-answersense-page-id]',
  '[data-page-id]',
  '.freebirdFormviewerViewPage',
].join(', ');

function isVisible(element: HTMLElement): boolean {
  return (
    !element.hidden &&
    element.getAttribute('aria-hidden') !== 'true' &&
    element.style.display !== 'none'
  );
}

function getText(element: Element | null): string | null {
  if (!element) {
    return null;
  }

  const text = (element.getAttribute('aria-label') ?? element.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function getQuestionText(question: HTMLElement): string | null {
  const explicitText = question.getAttribute('data-question-text');
  if (explicitText?.trim()) {
    return explicitText.trim();
  }

  const textElement = question.querySelector(
    '[data-question-text], [role="heading"], .M7eMe, .Y6Myld',
  );
  return getText(textElement) ?? getText(question);
}

function getQuestionId(question: HTMLElement): string | null {
  return (
    question.dataset.questionId ??
    question.getAttribute('data-params') ??
    question.id ??
    question.getAttribute('aria-labelledby')
  );
}

function getQuestionType(question: HTMLElement): SupportedQuestionType | null {
  const explicitType = question.dataset.questionType as
    | SupportedQuestionType
    | undefined;
  if (
    explicitType === 'short-text' ||
    explicitType === 'paragraph' ||
    explicitType === 'single-choice' ||
    explicitType === 'multiple-choice' ||
    explicitType === 'dropdown'
  ) {
    return explicitType;
  }

  if (question.querySelector('[role="radio"]')) {
    return 'single-choice';
  }
  if (question.querySelector('[role="checkbox"]')) {
    return 'multiple-choice';
  }
  if (question.querySelector('[role="listbox"]')) {
    return 'dropdown';
  }
  if (question.querySelector('textarea')) {
    return 'paragraph';
  }
  if (question.querySelector('input[type="text"]')) {
    return 'short-text';
  }
  return null;
}

function getOptions(question: HTMLElement): DiscoveredOption[] {
  return Array.from(
    question.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]'),
  )
    .map((option) => ({
      label: getText(option),
      selected:
        option.getAttribute('aria-checked') === 'true' ||
        option.getAttribute('aria-selected') === 'true',
    }))
    .filter((option): option is DiscoveredOption => option.label !== null)
    .map(({ label, selected }) => ({ label, selected }));
}

function getExistingValue(
  question: HTMLElement,
  type: SupportedQuestionType,
  options: DiscoveredOption[],
): string | string[] | null {
  if (type === 'short-text' || type === 'paragraph') {
    const input = question.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], textarea',
    );
    return input?.value || null;
  }

  if (type === 'single-choice' || type === 'dropdown') {
    return options.find((option) => option.selected)?.label ?? null;
  }

  const selected = options
    .filter((option) => option.selected)
    .map((option) => option.label);
  return selected.length > 0 ? selected : null;
}

function isRequired(question: HTMLElement): boolean {
  return (
    question.getAttribute('aria-required') === 'true' ||
    question.dataset.required === 'true' ||
    question.querySelector('[aria-required="true"], [data-required="true"]') !== null
  );
}

function discoverQuestion(question: HTMLElement): DiscoveredQuestion | UnsupportedQuestion {
  const id = getQuestionId(question);
  const text = getQuestionText(question);
  const type = getQuestionType(question);

  if (!text) {
    return { kind: 'unsupported', id, text: null, reason: 'Question text is unavailable.' };
  }
  if (!type) {
    return { kind: 'unsupported', id, text, reason: 'Question type is unsupported.' };
  }

  const options = getOptions(question);
  return {
    kind: 'supported',
    id,
    text,
    type,
    required: isRequired(question),
    options,
    existingValue: getExistingValue(question, type, options),
  };
}

function findActivePage(document: Document): HTMLElement | null {
  const markedPage = Array.from(
    document.querySelectorAll<HTMLElement>(activePageSelector),
  ).find(isVisible);
  if (markedPage) {
    return markedPage;
  }

  return (
    Array.from(document.querySelectorAll<HTMLElement>(pageSelector)).find(isVisible) ??
    null
  );
}

export function discoverActiveGoogleFormsPage(
  document: Document,
): DiscoveredPage | null {
  const page = findActivePage(document);
  if (!page) {
    return null;
  }

  const pageId =
    page.dataset.answersensePageId ??
    page.dataset.pageId ??
    page.id ??
    page.getAttribute('aria-label');
  if (!pageId) {
    return null;
  }

  const questions = Array.from(
    page.querySelectorAll<HTMLElement>('[role="listitem"], [data-question-id]'),
  ).filter(isVisible);

  return {
    pageId,
    questions: questions.map(discoverQuestion),
  };
}