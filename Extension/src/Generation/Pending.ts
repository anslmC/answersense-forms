import type { Answer, AnswerValue, Form } from '../Models/Logical';
import type { GenerationReport } from './Report';
import type { SettledPageState } from './Context';
import { snapshotAnswer, type FinalizedPageHandoff } from '../Fill/Handoff';

export type PendingAnswer = Answer & {
  questionId: string;
  questionText: string;
}

export interface SuccessfulPageTransition {
  readonly nextAcceptedAndTransitioned: true;
}

export interface PendingPageState {
  readonly cycleId: string;
  readonly pageId: string;
  readonly answers: readonly PendingAnswer[];
  readonly outcomes: readonly FinalizedPageHandoff['entries'][number][];
}

export function createPendingPageStateFromHandoff(
  handoff: FinalizedPageHandoff,
): PendingPageState {
  return Object.freeze({
    cycleId: handoff.cycleId,
    pageId: handoff.pageId,
    answers: Object.freeze(
      handoff.entries.flatMap((entry) =>
        entry.answer === null
          ? []
          : [{
              questionId: entry.answer.questionId as string,
              questionText: entry.questionText,
              value: Array.isArray(entry.answer.value)
                ? [...entry.answer.value]
                : entry.answer.value,
            }],
      ),
    ),
    outcomes: Object.freeze(handoff.entries.map((entry) => ({ ...entry }))),
  });
}

export function createPendingPageStateFromReport(
  form: Form,
  report: GenerationReport,
): PendingPageState {
  const answers = report.results.flatMap((result) => {
    if (result.status !== 'GENERATED' || result.answer === null) {
      return [];
    }
    const question = form.questions.find((candidate) => candidate.id === result.questionId);
    if (!question || question.text === null) {
      return [];
    }
    return [{
      questionId: result.questionId as string,
      questionText: question.text,
      value: Array.isArray(result.answer.value) ? [...result.answer.value] : result.answer.value,
    }];
  });

  return Object.freeze({
    cycleId: report.cycleId,
    pageId: form.activePageId,
    answers: Object.freeze(answers),
    outcomes: Object.freeze([]),
  });
}

export function editPendingAnswer(
  state: PendingPageState,
  questionId: string,
  value: AnswerValue,
): PendingPageState {
  const answers = state.answers.map((answer) =>
    answer.questionId === questionId
      ? { ...answer, value: Array.isArray(value) ? [...value] : value }
      : answer,
  );
  if (!answers.some((answer) => answer.questionId === questionId)) {
    throw new Error(`Question is not pending: ${questionId}`);
  }
  return Object.freeze({ ...state, answers: Object.freeze(answers) });
}

export function capturePendingPageAtSettlement(
  document: Document,
  form: Form,
  state: PendingPageState,
): PendingPageState {
  const answers = state.answers.map((answer) => {
    const current = snapshotAnswer(document, form, answer.questionId);
    return current
      ? { ...answer, value: Array.isArray(current.value) ? [...current.value] : current.value }
      : answer;
  });

  return Object.freeze({
    ...state,
    answers: Object.freeze(answers),
  });
}

export function commitPendingPageAfterSuccessfulTransition(
  state: PendingPageState,
  _transition: SuccessfulPageTransition,
): SettledPageState {
  return {
    pageId: state.pageId,
    answers: state.answers.map((answer) => ({
      answer: {
        questionId: answer.questionId,
        value: Array.isArray(answer.value) ? [...answer.value] : answer.value,
      },
      questionText: answer.questionText,
    })),
  };
}

export function abandonPendingPage(): null {
  return null;
}

export function restartPendingPage(): null {
  return null;
}
