import { describe, expect, it } from 'vitest';
import type { Form, Question } from '../src/Models/Logical';
import { createGenerationReport } from '../src/Generation/Report';
import {
  acceptGeneratedAnswer,
  editReviewedAnswer,
  skipReviewedAnswer,
} from '../src/Review/Decisions';
import { fillReviewedAnswers } from '../src/Fill/Filler';
import { resolveCurrentQuestionTarget } from '../src/Fill/Resolver';

function question(
  id: string,
  type: Question['type'],
  options: string[] = [],
): Question {
  return {
    id,
    text: id,
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
    question('choice', 'single-choice', ['Alpha', 'Beta']),
    question('checks', 'multiple-choice', ['One', 'Two', 'Three']),
    question('short', 'short-text'),
    question('paragraph', 'paragraph'),
  ],
};

function createDocument(options = ''): Document {
  return new DOMParser().parseFromString(`<!doctype html>
    <main data-page-id="page-1" data-answersense-active-page="true">
      <div role="listitem" data-question-id="choice" data-question-type="single-choice">
        <div role="radio" aria-label="Alpha" aria-checked="false"></div>
        <div role="radio" aria-label="Beta" aria-checked="false"></div>
      </div>
      <div role="listitem" data-question-id="checks" data-question-type="multiple-choice">
        <div role="checkbox" aria-label="One" aria-checked="false"></div>
        <div role="checkbox" aria-label="Two" aria-checked="false"></div>
        <div role="checkbox" aria-label="Three" aria-checked="false"></div>
      </div>
      <div role="listitem" data-question-id="short" data-question-type="short-text">
        <input type="text" value="">
      </div>
      <div role="listitem" data-question-id="paragraph" data-question-type="paragraph">
        <textarea></textarea>
      </div>
      <div role="listitem" data-question-id="later" data-question-type="short-text">
        <input type="text" value="">
      </div>
      ${options}
    </main>`, 'text/html');
}

function reportFor(
  results: Array<{ questionId: string; value: string | string[] }>,
) {
  return createGenerationReport(
    'cycle-p4',
    results.map((result) => ({
      questionId: result.questionId,
      status: 'GENERATED' as const,
      answer: { questionId: result.questionId, value: result.value },
      reason: null,
    })),
  );
}

describe('P4 current DOM resolver', () => {
  it('resolves by questionId and returns typed targets', () => {
    const result = resolveCurrentQuestionTarget(
      createDocument(),
      form.questions[0],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.kind).toBe('single-choice');
      if (result.target.kind === 'single-choice') {
        expect(result.target.options.map((option) => option.getAttribute('aria-label'))).toEqual([
          'Alpha',
          'Beta',
        ]);
      }
    }
  });

  it('reports missing questions, type mismatches, and missing controls', () => {
    expect(resolveCurrentQuestionTarget(createDocument(), question('missing', 'short-text'))).toMatchObject({
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
    });
    expect(resolveCurrentQuestionTarget(createDocument(), question('choice', 'multiple-choice'))).toMatchObject({
      ok: false,
      code: 'TYPE_MISMATCH',
    });
    expect(resolveCurrentQuestionTarget(
      createDocument('<div role="listitem" data-question-id="empty" data-question-type="short-text"></div>'),
      question('empty', 'short-text'),
    )).toMatchObject({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('does not use question text or resolve unrelated DOM questions', () => {
    const document = createDocument('<div role="listitem" data-question-id="unrelated" data-question-text="choice"></div>');
    const result = resolveCurrentQuestionTarget(document, question('choice', 'single-choice'));

    expect(result.ok).toBe(true);
    expect(document.querySelector('[data-question-id="unrelated"]')).not.toBeNull();
  });
});

describe('P4 sequential filling and preservation', () => {
  it('fills multiple choice, checkboxes, short answer, and paragraph in report order', () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'checks', value: ['One', 'Three'] },
      { questionId: 'short', value: 'Ada' },
      { questionId: 'paragraph', value: 'A paragraph' },
    ]);

    const result = fillReviewedAnswers(document, form, report, report.results.map((item) =>
      acceptGeneratedAnswer(item.questionId as string, item.answer!),
    ));

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'FILLED',
      'FILLED',
      'FILLED',
    ]);
    expect(document.querySelector('[data-question-id="choice"] [aria-label="Beta"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-question-id="checks"] [aria-label="Three"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-question-id="short"] input')?.getAttribute('value')).toBe('');
    expect((document.querySelector('[data-question-id="short"] input') as HTMLInputElement).value).toBe('Ada');
    expect((document.querySelector('[data-question-id="paragraph"] textarea') as HTMLTextAreaElement).value).toBe('A paragraph');
  });

  it('preserves existing answers without overwriting them', () => {
    const document = createDocument();
    const choice = document.querySelector('[data-question-id="choice"] [aria-label="Alpha"]')!;
    choice.setAttribute('aria-checked', 'true');
    const checks = document.querySelector('[data-question-id="checks"] [aria-label="One"]')!;
    checks.setAttribute('aria-checked', 'true');
    const short = document.querySelector('[data-question-id="short"] input') as HTMLInputElement;
    short.value = 'Existing short';
    const paragraph = document.querySelector('[data-question-id="paragraph"] textarea') as HTMLTextAreaElement;
    paragraph.value = 'Existing paragraph';

    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'checks', value: ['One'] },
      { questionId: 'short', value: 'Generated short' },
      { questionId: 'paragraph', value: 'Generated paragraph' },
    ]);
    const result = fillReviewedAnswers(document, form, report, report.results.map((item) =>
      acceptGeneratedAnswer(item.questionId as string, item.answer!),
    ));

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
    ]);
    expect(short.value).toBe('Existing short');
    expect(paragraph.value).toBe('Existing paragraph');
  });

  it('supports edited and skipped review decisions', () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'short', value: 'Generated' },
      { questionId: 'paragraph', value: 'Ignored' },
    ]);
    const result = fillReviewedAnswers(document, form, report, [
      editReviewedAnswer('short', { questionId: 'short', value: 'Edited' }),
      skipReviewedAnswer('paragraph'),
    ]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['FILLED', 'SKIPPED']);
    expect((document.querySelector('[data-question-id="short"] input') as HTMLInputElement).value).toBe('Edited');
    expect((document.querySelector('[data-question-id="paragraph"] textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('reports checkbox partial and total failures', () => {
    const document = createDocument();
    const report = reportFor([{ questionId: 'checks', value: ['One', 'Missing'] }]);
    const partial = fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);
    expect(partial.outcomes[0]).toMatchObject({ status: 'PARTIAL_FILL', code: 'INVALID_OPTION' });
    expect(document.querySelector('[data-question-id="checks"] [aria-label="One"]')?.getAttribute('aria-checked')).toBe('true');

    const failedReport = reportFor([{ questionId: 'checks', value: ['Missing'] }]);
    const failed = fillReviewedAnswers(document, form, failedReport, [
      acceptGeneratedAnswer('checks', failedReport.results[0].answer!),
    ]);
    expect(failed.outcomes[0]).toMatchObject({ status: 'FILL_FAILED', code: 'INVALID_OPTION' });
  });

  it('continues after a failed question and preserves deterministic order', () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'missing', value: 'No target' },
      { questionId: 'short', value: 'Still fills' },
    ]);
    const result = fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('missing', report.results[0].answer!),
      acceptGeneratedAnswer('short', report.results[1].answer!),
    ]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['FILL_FAILED', 'FILLED']);
    expect((document.querySelector('[data-question-id="short"] input') as HTMLInputElement).value).toBe('Still fills');
  });

  it('does not fill a DOM question without a generation result', () => {
    const document = createDocument();
    const report = reportFor([{ questionId: 'short', value: 'Only generated answer' }]);
    const result = fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('short', report.results[0].answer!),
    ]);

    expect(result.outcomes).toHaveLength(1);
    expect((document.querySelector('[data-question-id="later"] input') as HTMLInputElement).value).toBe('');
  });
});
