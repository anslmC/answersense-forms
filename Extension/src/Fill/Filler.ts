import type {
  Answer,
  Form,
  Question,
  QuestionResultStatus,
} from '../Models/Logical';
import type { GenerationReport } from '../Generation/Report';
import type { ReviewDecision } from '../Review/Decisions';
import { elapsedSince, monotonicNow } from '../Shared/Performance';
import {
  createQuestionTargetIndex,
  getOptionLabel,
  isOptionSelected,
  resolveCurrentQuestionTarget,
  type QuestionTargetIndex,
  type ResolutionFailure,
  type ResolvedChoiceTarget,
  type ResolvedQuestionTarget,
  type ResolvedTextTarget,
} from './Resolver';

export type FillStatus =
  'FILLED' | 'FILL_FAILED' | 'PARTIAL_FILL' | 'PRESERVED_EXISTING' | 'SKIPPED';

export type FillFailureCode =
  | 'ELEMENT_NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_OPTION'
  | 'INVALID_ANSWER'
  | 'OVERRIDE_VALIDATION_FAILED';

export interface FillOutcome {
  questionId: string | null;
  questionText?: string | null;
  status: FillStatus;
  answer: Answer | null;
  reason: string | null;
  code: FillFailureCode | null;
}

export interface FillReport {
  readonly cycleId: string;
  readonly outcomes: readonly FillOutcome[];
}

export type ChoiceVerificationMode =
  'IMMEDIATE' | 'EVENT' | 'FALLBACK' | 'CANCELLED';

export interface ChoiceVerificationDetails {
  readonly mode: ChoiceVerificationMode;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly fallbackMs: number;
  readonly verified: boolean;
  readonly documentHidden: boolean;
  readonly documentVisibility: 'visible' | 'hidden';
}

export interface FillInstrumentation {
  recordVerification?(details: ChoiceVerificationDetails): void;
  recordFillOutcome?(outcome: FillOutcome): void;
}

export interface SkipDiagnostic {
  readonly questionId: string;
  readonly generationStatus: QuestionResultStatus | 'unknown';
  readonly generationReason: string | null;
  readonly fillStatus: FillStatus;
  readonly fillReason: string | null;
}

export function createSkipDiagnostics(
  report: GenerationReport,
  fillReport: FillReport
): readonly SkipDiagnostic[] {
  const resultsByQuestionId = new Map(
    report.results.map((result) => [result.questionId, result])
  );

  return fillReport.outcomes
    .filter(
      (outcome): outcome is FillOutcome & { questionId: string } =>
        outcome.status === 'SKIPPED' && typeof outcome.questionId === 'string'
    )
    .map((outcome) => {
      const generation = resultsByQuestionId.get(outcome.questionId);
      return {
        questionId: outcome.questionId,
        generationStatus: generation?.status ?? 'unknown',
        generationReason: generation?.reason ?? null,
        fillStatus: outcome.status,
        fillReason: outcome.reason,
      } satisfies SkipDiagnostic;
    });
}

export const CHOICE_VERIFICATION_VISIBLE_GRACE_MS = 750;
export const CHOICE_VERIFICATION_MAX_WAIT_MS = 5000;
const CHOICE_SELECTION_ATTRIBUTES = ['aria-checked', 'aria-selected'];

function failureOutcome(
  questionId: string | null,
  failure: ResolutionFailure | { code: FillFailureCode; reason: string },
  answer: Answer | null
): FillOutcome {
  return {
    questionId,
    status: 'FILL_FAILED',
    answer,
    reason: failure.reason,
    code: failure.code,
  };
}

function currentTextValue(target: ResolvedTextTarget): string {
  if ('value' in target.control) {
    return target.control.value;
  }
  return target.control.textContent ?? '';
}

function currentChoiceAnswer(target: ResolvedChoiceTarget): Answer | null {
  const selected = target.options.filter(isOptionSelected).map(getOptionLabel);
  return selected.length > 0
    ? {
        questionId: target.questionId,
        value: target.kind === 'multiple-choice' ? selected : selected[0],
      }
    : null;
}

function currentResolvedAnswer(target: ResolvedQuestionTarget): Answer | null {
  if (target.kind === 'short-text' || target.kind === 'paragraph') {
    const value = currentTextValue(target);
    return value ? { questionId: target.questionId, value } : null;
  }
  if (target.kind === 'single-choice' || target.kind === 'multiple-choice') {
    return currentChoiceAnswer(target);
  }
  return null;
}

function answerSatisfies(
  requested: Answer | null,
  current: Answer | null
): boolean {
  if (!requested || !current) {
    return false;
  }
  const requestedValue = requested.value;
  const currentValue = current.value;
  if (Array.isArray(requestedValue)) {
    return (
      Array.isArray(currentValue) &&
      requestedValue.every((value) => currentValue.includes(value))
    );
  }
  return Array.isArray(currentValue)
    ? currentValue.includes(requestedValue)
    : currentValue === requestedValue;
}

function preserveExisting(
  target: ResolvedTextTarget | ResolvedChoiceTarget
): FillOutcome | null {
  if (target.kind === 'short-text' || target.kind === 'paragraph') {
    const value = currentTextValue(target);
    if (value) {
      return {
        questionId: target.questionId,
        status: 'PRESERVED_EXISTING',
        answer: { questionId: target.questionId, value },
        reason: 'The current DOM already contains an answer.',
        code: null,
      };
    }
    return null;
  }

  if (target.kind === 'single-choice') {
    return currentChoiceAnswer(target)
      ? {
          questionId: target.questionId,
          status: 'PRESERVED_EXISTING',
          answer: currentChoiceAnswer(target),
          reason: 'The current DOM already contains an answer.',
          code: null,
        }
      : null;
  }

  return null;
}

function dispatchInputEvents(control: HTMLElement): void {
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillText(target: ResolvedTextTarget, answer: Answer): FillOutcome {
  if (typeof answer.value !== 'string') {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Text questions require a string answer.',
      },
      answer
    );
  }

  if ('value' in target.control) {
    target.control.value = answer.value;
  } else {
    target.control.textContent = answer.value;
  }
  dispatchInputEvents(target.control);
  if (currentTextValue(target) !== answer.value) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'The text control did not retain the requested value.',
      },
      answer
    );
  }
  return {
    questionId: target.questionId,
    status: 'FILLED',
    answer,
    reason: null,
    code: null,
  };
}

function activateOption(option: HTMLElement): void {
  option.click();
}

function deactivateOption(option: HTMLElement): void {
  option.click();
}

interface ChoiceVerifier {
  observe(): void;
  verify(): Promise<ChoiceVerificationDetails>;
  dispose(): void;
}

interface DocumentVisibility {
  readonly hidden: boolean;
  readonly visibility: 'visible' | 'hidden';
}

function readDocumentVisibility(document: Document | null): DocumentVisibility {
  try {
    const state = document?.visibilityState;
    const hidden = state === 'hidden' || document?.hidden === true;
    return { hidden, visibility: hidden ? 'hidden' : 'visible' };
  } catch {
    return { hidden: false, visibility: 'visible' };
  }
}

function getMutationObserverConstructor(
  document: Document | null
): typeof MutationObserver | null {
  try {
    const view = document?.defaultView;
    if (view && typeof view.MutationObserver === 'function') {
      return view.MutationObserver;
    }
  } catch {
    // Fall through to the global implementation.
  }
  return typeof MutationObserver === 'function' ? MutationObserver : null;
}

/**
 * Watches only the option elements involved in one verification. The observer
 * is installed before the click and the grace timer only advances while the
 * document is visible, because Google Forms defers committing `aria-checked`
 * until the tab becomes visible again. The maximum wait is also visibility-
 * aware: a hidden document stays pending until it becomes visible, then the
 * visible grace window bounds verification.
 */
function createChoiceVerifier(
  isSelected: () => boolean,
  observedElements: readonly HTMLElement[],
  ownerDocument: Document | null,
  instrumentation?: FillInstrumentation
): ChoiceVerifier {
  let observer: MutationObserver | null = null;
  let visibleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityListener: EventListener | null = null;
  let visibilityListenerDocument: Document | null = null;
  const changeListeners: Array<{
    element: HTMLElement;
    listener: EventListener;
  }> = [];
  let attempts = 0;
  let started = false;
  let settled = false;
  let result: ChoiceVerificationDetails | null = null;
  let resolveWait: ((details: ChoiceVerificationDetails) => void) | null = null;
  let startedAt = 0;
  let visibility: DocumentVisibility = {
    hidden: false,
    visibility: 'visible',
  };

  const refreshVisibility = (): DocumentVisibility => {
    visibility = readDocumentVisibility(ownerDocument);
    return visibility;
  };

  const clearVisibleTimer = (): void => {
    if (visibleTimer !== null) {
      clearTimeout(visibleTimer);
      visibleTimer = null;
    }
  };

  const cleanup = (): void => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearVisibleTimer();
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    if (visibilityListenerDocument && visibilityListener) {
      visibilityListenerDocument.removeEventListener(
        'visibilitychange',
        visibilityListener
      );
    }
    visibilityListener = null;
    visibilityListenerDocument = null;
    for (const { element, listener } of changeListeners.splice(0)) {
      element.removeEventListener('change', listener);
    }
  };

  const settle = (
    verified: boolean,
    mode: ChoiceVerificationMode
  ): ChoiceVerificationDetails => {
    if (result) {
      return result;
    }
    settled = true;
    cleanup();
    const details: ChoiceVerificationDetails = {
      mode,
      attempts,
      elapsedMs: started ? elapsedSince(startedAt) : 0,
      fallbackMs: CHOICE_VERIFICATION_VISIBLE_GRACE_MS,
      verified,
      documentHidden: visibility.hidden,
      documentVisibility: visibility.visibility,
    };
    result = details;
    try {
      instrumentation?.recordVerification?.(details);
    } catch {
      // Instrumentation must never affect filling.
    }
    const resolve = resolveWait;
    resolveWait = null;
    resolve?.(details);
    return details;
  };

  const checkForSelection = (mode: ChoiceVerificationMode): boolean => {
    attempts += 1;
    let selected = false;
    try {
      selected = isSelected();
    } catch {
      selected = false;
    }
    if (selected) {
      settle(true, mode);
    }
    return selected;
  };

  const installObserver = (): void => {
    if (observer) {
      return;
    }
    const MutationObserverConstructor =
      getMutationObserverConstructor(ownerDocument);
    if (!MutationObserverConstructor) {
      return;
    }
    try {
      observer = new MutationObserverConstructor(() => {
        if (!settled && started) {
          checkForSelection('EVENT');
        }
      });
      for (const element of observedElements) {
        observer.observe(element, {
          attributes: true,
          attributeFilter: CHOICE_SELECTION_ATTRIBUTES,
        });
      }
    } catch {
      observer?.disconnect();
      observer = null;
    }
  };

  const installChangeListeners = (): void => {
    if (changeListeners.length > 0) {
      return;
    }
    for (const element of observedElements) {
      const listener: EventListener = () => {
        if (!settled) {
          checkForSelection('EVENT');
        }
      };
      element.addEventListener('change', listener);
      changeListeners.push({ element, listener });
    }
  };

  const startVisibleWindow = (): void => {
    clearVisibleTimer();
    if (settled || refreshVisibility().hidden) {
      return;
    }
    visibleTimer = setTimeout(
      expireVisibleWindow,
      CHOICE_VERIFICATION_VISIBLE_GRACE_MS
    );
  };

  const finishExpired = (): void => {
    checkForSelection('FALLBACK');
    if (!settled) {
      settle(false, 'FALLBACK');
    }
  };

  function expireVisibleWindow(): void {
    visibleTimer = null;
    if (settled) {
      return;
    }
    // The document may have hidden between the timer firing and this callback.
    if (refreshVisibility().hidden) {
      return;
    }
    finishExpired();
  }

  const expireMaxWait = (): void => {
    maxWaitTimer = null;
    if (settled) {
      return;
    }
    if (refreshVisibility().hidden) {
      // Google Forms commits deferred choices when the document becomes
      // visible. Settling here would report a failure for a selection that is
      // still pending; the visibility listener rechecks and restarts the
      // visible grace window instead.
      return;
    }
    finishExpired();
  };

  const installVisibilityListener = (): void => {
    if (visibilityListener || !ownerDocument) {
      return;
    }
    const listener: EventListener = () => {
      if (!started || settled) {
        return;
      }
      if (refreshVisibility().hidden) {
        // Do not consume the grace window while the document is hidden.
        clearVisibleTimer();
        return;
      }
      // The selection is committed around the moment the document becomes
      // visible, so recheck before restarting the bounded visible window.
      if (checkForSelection('EVENT')) {
        return;
      }
      startVisibleWindow();
    };
    try {
      ownerDocument.addEventListener('visibilitychange', listener);
      visibilityListener = listener;
      visibilityListenerDocument = ownerDocument;
    } catch {
      visibilityListener = null;
      visibilityListenerDocument = null;
    }
  };

  return {
    observe(): void {
      if (started || settled) {
        return;
      }
      installObserver();
    },
    async verify(): Promise<ChoiceVerificationDetails> {
      if (!started) {
        started = true;
        startedAt = monotonicNow();
        refreshVisibility();
      }
      attempts += 1;
      // A synchronous failure still has to release the observer.
      let selected: boolean;
      try {
        selected = isSelected();
      } catch (error) {
        settled = true;
        cleanup();
        throw error;
      }
      if (selected) {
        return settle(true, 'IMMEDIATE');
      }
      installObserver();
      installChangeListeners();
      installVisibilityListener();
      maxWaitTimer = setTimeout(expireMaxWait, CHOICE_VERIFICATION_MAX_WAIT_MS);
      if (!visibility.hidden) {
        startVisibleWindow();
      }
      return new Promise<ChoiceVerificationDetails>((resolve) => {
        resolveWait = resolve;
      });
    },
    dispose(): void {
      if (settled) {
        cleanup();
        return;
      }
      if (!started) {
        settled = true;
        cleanup();
        return;
      }
      settle(false, 'CANCELLED');
    },
  };
}

async function fillSingleChoice(
  target: ResolvedChoiceTarget,
  answer: Answer,
  instrumentation?: FillInstrumentation
): Promise<FillOutcome> {
  if (typeof answer.value !== 'string') {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Multiple-choice questions require a single string answer.',
      },
      answer
    );
  }

  const option = target.options.find(
    (candidate) => getOptionLabel(candidate) === answer.value
  );
  if (!option) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason: 'The requested choice is not present in the current DOM.',
      },
      answer
    );
  }
  if (isOptionSelected(option)) {
    return {
      questionId: target.questionId,
      status: 'FILLED',
      answer,
      reason: null,
      code: null,
    };
  }
  const verifier = createChoiceVerifier(
    () => isOptionSelected(option),
    [option],
    option.ownerDocument,
    instrumentation
  );
  verifier.observe();
  try {
    activateOption(option);
    const verification = await verifier.verify();
    if (!verification.verified) {
      return failureOutcome(
        target.questionId,
        {
          code: 'INVALID_OPTION',
          reason: 'The requested choice was not selected in the current DOM.',
        },
        answer
      );
    }
    return {
      questionId: target.questionId,
      status: 'FILLED',
      answer,
      reason: null,
      code: null,
    };
  } finally {
    verifier.dispose();
  }
}

async function fillCheckboxes(
  target: ResolvedChoiceTarget,
  answer: Answer,
  overwriteExisting = false,
  instrumentation?: FillInstrumentation
): Promise<FillOutcome> {
  if (!Array.isArray(answer.value)) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_ANSWER',
        reason: 'Checkbox questions require an array answer.',
      },
      answer
    );
  }

  const optionsByLabel = new Map(
    target.options.map((option) => [getOptionLabel(option), option])
  );
  const requested = [...new Set(answer.value)];
  const available = requested.filter((label) => optionsByLabel.has(label));
  const missing = requested.filter((label) => !optionsByLabel.has(label));
  const selectedBefore = new Set(
    target.options.filter(isOptionSelected).map(getOptionLabel)
  );

  if (available.length === 0) {
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason:
          'None of the requested checkbox options are present in the current DOM.',
      },
      answer
    );
  }

  const labelsToVerify = missing.length > 0 ? available : requested;
  const verificationOptions = labelsToVerify
    .map((label) => optionsByLabel.get(label))
    .filter((option): option is HTMLElement => option !== undefined);
  const verifier = createChoiceVerifier(
    () =>
      labelsToVerify.every((label) => {
        const option = optionsByLabel.get(label);
        return option !== undefined && isOptionSelected(option);
      }),
    verificationOptions,
    target.questionElement.ownerDocument,
    instrumentation
  );
  verifier.observe();

  const newlySelected: HTMLElement[] = [];
  const newlyDeselected: HTMLElement[] = [];
  try {
    if (overwriteExisting) {
      for (const option of target.options) {
        if (
          isOptionSelected(option) &&
          !available.includes(getOptionLabel(option))
        ) {
          newlyDeselected.push(option);
          deactivateOption(option);
        }
      }
    }
    for (const label of available) {
      const option = optionsByLabel.get(label);
      if (option && !isOptionSelected(option)) {
        newlySelected.push(option);
        activateOption(option);
      }
    }
  } catch {
    verifier.dispose();
    try {
      for (const option of newlySelected) {
        if (isOptionSelected(option)) {
          deactivateOption(option);
        }
      }
      for (const option of newlyDeselected) {
        if (!isOptionSelected(option)) {
          activateOption(option);
        }
      }
      if (newlySelected.some((option) => isOptionSelected(option))) {
        throw new Error(
          'Checkbox rollback could not restore the original state.'
        );
      }
    } catch {
      return {
        questionId: target.questionId,
        status: 'PARTIAL_FILL',
        answer,
        reason:
          'Checkbox filling failed and rollback could not restore the original state.',
        code: 'INVALID_OPTION',
      };
    }
    return failureOutcome(
      target.questionId,
      {
        code: 'INVALID_OPTION',
        reason: 'The requested checkbox selections could not be applied.',
      },
      answer
    );
  }

  const alreadyComplete = overwriteExisting
    ? selectedBefore.size === available.length &&
      available.every((label) => selectedBefore.has(label)) &&
      missing.length === 0
    : requested.every((label) => selectedBefore.has(label));
  if (alreadyComplete) {
    verifier.dispose();
    return {
      questionId: target.questionId,
      status: 'PRESERVED_EXISTING',
      answer: currentChoiceAnswer(target),
      reason: 'The requested checkbox selections already existed.',
      code: null,
    };
  }

  try {
    const verification = await verifier.verify();
    if (!verification.verified) {
      try {
        for (const option of newlySelected) {
          if (isOptionSelected(option)) {
            deactivateOption(option);
          }
        }
        if (newlySelected.some((option) => isOptionSelected(option))) {
          throw new Error(
            'Checkbox rollback could not restore the original state.'
          );
        }
      } catch {
        return {
          questionId: target.questionId,
          status: 'PARTIAL_FILL',
          answer,
          reason:
            'Checkbox verification failed and rollback could not restore the original state.',
          code: 'INVALID_OPTION',
        };
      }
      return failureOutcome(
        target.questionId,
        {
          code: 'INVALID_OPTION',
          reason:
            'The requested checkbox selections were not retained by the current DOM.',
        },
        answer
      );
    }

    return {
      questionId: target.questionId,
      status: missing.length > 0 ? 'PARTIAL_FILL' : 'FILLED',
      answer: missing.length > 0 ? answer : currentChoiceAnswer(target),
      reason:
        missing.length > 0
          ? 'Some requested checkbox options were unavailable.'
          : null,
      code: missing.length > 0 ? 'INVALID_OPTION' : null,
    };
  } finally {
    verifier.dispose();
  }
}

async function fillQuestion(
  document: Document,
  question: Question,
  answer: Answer,
  overwriteExisting: boolean,
  index?: QuestionTargetIndex,
  instrumentation?: FillInstrumentation
): Promise<FillOutcome> {
  const resolved = resolveCurrentQuestionTarget(document, question, index);
  if (!resolved.ok) {
    return failureOutcome(question.id, resolved, answer);
  }

  if (!overwriteExisting) {
    const preserved = preserveExisting(resolved.target);
    if (preserved) {
      return preserved;
    }
  }

  if (
    resolved.target.kind === 'short-text' ||
    resolved.target.kind === 'paragraph'
  ) {
    return fillText(resolved.target, answer);
  }
  if (resolved.target.kind === 'single-choice') {
    return fillSingleChoice(resolved.target, answer, instrumentation);
  }
  if (resolved.target.kind === 'multiple-choice') {
    return fillCheckboxes(
      resolved.target,
      answer,
      overwriteExisting,
      instrumentation
    );
  }
  return failureOutcome(
    question.id,
    {
      code: 'TARGET_NOT_FOUND',
      reason: 'The current question type is not supported by P4 filling.',
    },
    answer
  );
}

export function reconcileFillReport(
  document: Document,
  form: Form,
  fillReport: FillReport,
  index?: QuestionTargetIndex
): FillReport {
  const questionsById = new Map(
    form.questions.map((question) => [question.id, question])
  );
  const targetIndex = index ?? createQuestionTargetIndex(document);
  let changed = false;
  const outcomes = fillReport.outcomes.map((outcome) => {
    if (outcome.status !== 'FILL_FAILED' && outcome.status !== 'PARTIAL_FILL') {
      return outcome;
    }
    if (typeof outcome.questionId !== 'string' || !outcome.answer) {
      return outcome;
    }
    const question = questionsById.get(outcome.questionId);
    if (!question) {
      return outcome;
    }
    const resolved = resolveCurrentQuestionTarget(
      document,
      question,
      targetIndex
    );
    if (!resolved.ok) {
      return outcome;
    }
    const current = currentResolvedAnswer(resolved.target);
    if (!current || !answerSatisfies(outcome.answer, current)) {
      return outcome;
    }
    changed = true;
    return {
      ...outcome,
      status: 'FILLED' as const,
      answer: current,
      reason: null,
      code: null,
    };
  });
  if (!changed) {
    return fillReport;
  }
  return Object.freeze({
    cycleId: fillReport.cycleId,
    outcomes: Object.freeze(outcomes),
  });
}

export async function fillReviewedAnswers(
  document: Document,
  form: Form,
  report: GenerationReport,
  decisions: readonly ReviewDecision[],
  overwriteExisting = false,
  instrumentation?: FillInstrumentation
): Promise<FillReport> {
  const decisionsById = new Map(
    decisions.map((decision) => [decision.questionId, decision])
  );
  const questionsById = new Map(
    form.questions.map((question) => [question.id, question])
  );
  const remainingQuestionsById = new Map<string | null, Question[]>();
  for (const question of form.questions) {
    const questions = remainingQuestionsById.get(question.id);
    if (questions) {
      questions.push(question);
    } else {
      remainingQuestionsById.set(question.id, [question]);
    }
  }
  const index = createQuestionTargetIndex(document);
  const outcomes: FillOutcome[] = [];
  const recordOutcome = (outcome: FillOutcome): void => {
    outcomes.push(outcome);
    instrumentation?.recordFillOutcome?.(outcome);
  };
  for (const result of report.results) {
    const questionId = result.questionId;
    const associatedQuestion = remainingQuestionsById.get(questionId)?.shift();
    const questionText = associatedQuestion?.text ?? null;
    const decision =
      questionId === null ? undefined : decisionsById.get(questionId);
    if (!decision || decision.decision === 'skip' || decision.answer === null) {
      recordOutcome({
        questionId,
        questionText,
        status: 'SKIPPED',
        answer: null,
        reason: 'The reviewed answer was skipped.',
        code: null,
      });
      continue;
    }

    if (decision.answer.questionId !== questionId) {
      recordOutcome({
        ...failureOutcome(
          questionId,
          {
            code: 'INVALID_ANSWER',
            reason:
              'The reviewed answer questionId does not match the decision.',
          },
          decision.answer
        ),
        questionText,
      });
      continue;
    }

    const question =
      questionId === null ? undefined : questionsById.get(questionId);
    if (!question) {
      recordOutcome({
        ...failureOutcome(
          questionId,
          {
            code: 'ELEMENT_NOT_FOUND',
            reason:
              'The reviewed question is not present in the normalized form.',
          },
          decision.answer
        ),
        questionText,
      });
      continue;
    }

    const outcome = await fillQuestion(
      document,
      question,
      decision.answer,
      overwriteExisting,
      index,
      instrumentation
    );
    recordOutcome(
      outcome.status === 'FILL_FAILED' || outcome.status === 'PARTIAL_FILL'
        ? { ...outcome, questionText: outcome.questionText ?? questionText }
        : outcome
    );
  }

  return reconcileFillReport(
    document,
    form,
    Object.freeze({
      cycleId: report.cycleId,
      outcomes: Object.freeze(outcomes),
    }),
    index
  );
}
