import { describe, expect, it } from 'vitest';
import type { Form, Question, QuestionResult } from '../src/Models/Logical';
import { cloneAnswerValue } from '../src/Shared/Utils';
import { createGenerationReport } from '../src/Generation/Report';
import {
  commitPendingPageAfterSuccessfulTransition,
  createPendingPageStateFromReport,
  editPendingAnswer,
} from '../src/Generation/Pending';

function createQuestion(
  id: string,
  type: Question['type'],
  options: string[] = []
): Question {
  return {
    id,
    text: `Question ${id}`,
    type,
    required: false,
    options: options.map((label) => ({ label, selected: false })),
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
  };
}

const form: Form = {
  formId: 'form-1',
  activePageId: 'page-1',
  questions: [
    createQuestion('name', 'short-text'),
    createQuestion('topics', 'multiple-choice', ['Testing', 'Accessibility']),
  ],
};

const results: QuestionResult[] = [
  {
    questionId: 'name',
    status: 'GENERATED',
    answer: { questionId: 'name', value: 'Ada' },
    reason: null,
  },
  {
    questionId: 'topics',
    status: 'GENERATED',
    answer: { questionId: 'topics', value: ['Testing'] },
    reason: null,
  },
];

describe('cloneAnswerValue', () => {
  it('returns non-array values unchanged', () => {
    expect(cloneAnswerValue('Ada')).toBe('Ada');
    expect(cloneAnswerValue('')).toBe('');
  });

  it('copies array values into a new array', () => {
    const value = ['Testing', 'Accessibility'];
    const cloned = cloneAnswerValue(value);

    expect(cloned).toEqual(value);
    expect(cloned).not.toBe(value);

    value.push('Other');
    expect(cloned).toEqual(['Testing', 'Accessibility']);
  });

  it('copies empty arrays', () => {
    const value: string[] = [];
    const cloned = cloneAnswerValue(value);

    expect(cloned).toEqual([]);
    expect(cloned).not.toBe(value);
  });

  it('keeps null unchanged', () => {
    expect(cloneAnswerValue(null)).toBeNull();
  });

  it('copies arrays that may be null at the call site', () => {
    const nullable: string[] | null = ['Testing'];
    const cloned = cloneAnswerValue(nullable);

    expect(cloned).toEqual(['Testing']);
    expect(cloned).not.toBe(nullable);
  });
});

describe('answer value cloning in generation reports and pending state', () => {
  it('detaches report answer arrays from the source results', () => {
    const source: QuestionResult[] = [
      {
        questionId: 'topics',
        status: 'GENERATED',
        answer: { questionId: 'topics', value: ['Testing'] },
        reason: null,
      },
    ];

    const report = createGenerationReport('cycle-1', source);
    const reportValue = report.results[0].answer?.value;

    expect(reportValue).not.toBe(source[0].answer?.value);
    expect(reportValue).toEqual(['Testing']);
    expect(Object.isFrozen(reportValue)).toBe(true);
  });

  it('copies cloned report values into editable pending answers', () => {
    const report = createGenerationReport('cycle-1', results);
    const pending = createPendingPageStateFromReport(form, report);
    const topics = pending.answers.find(
      (answer) => answer.questionId === 'topics'
    );

    expect(topics?.value).toEqual(['Testing']);
    expect(topics?.value).not.toBe(report.results[1].answer?.value);
    expect(Object.isFrozen(topics?.value)).toBe(false);
  });

  it('copies edited values so later caller mutation does not leak into pending state', () => {
    const pending = createPendingPageStateFromReport(
      form,
      createGenerationReport('cycle-1', results)
    );
    const editedValue = ['Accessibility'];
    const edited = editPendingAnswer(pending, 'topics', editedValue);

    editedValue.push('Testing');

    expect(
      edited.answers.find((answer) => answer.questionId === 'topics')?.value
    ).toEqual(['Accessibility']);
    expect(
      pending.answers.find((answer) => answer.questionId === 'topics')
    ).toMatchObject({ value: ['Testing'] });
  });

  it('copies answer values when committing a settled page', () => {
    const pending = createPendingPageStateFromReport(
      form,
      createGenerationReport('cycle-1', results)
    );
    const settled = commitPendingPageAfterSuccessfulTransition(pending, {
      nextAcceptedAndTransitioned: true,
    });
    const committed = settled.answers.find(
      (answer) => answer.answer?.questionId === 'topics'
    );

    expect(committed?.answer?.value).toEqual(['Testing']);
    expect(committed?.answer?.value).not.toBe(
      pending.answers.find((answer) => answer.questionId === 'topics')?.value
    );
  });
});
