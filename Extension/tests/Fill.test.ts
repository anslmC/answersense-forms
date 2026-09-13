import { describe, expect, it } from 'vitest';
import type { Form, Question } from '../src/Models/Logical';
import { createGenerationReport } from '../src/Generation/Report';
import {
  acceptGeneratedAnswer,
  createAcceptedReviewDecisions,
  editReviewedAnswer,
  skipReviewedAnswer,
} from '../src/Review/Decisions';
import {
  createSkipDiagnostics,
  fillReviewedAnswers,
} from '../src/Fill/Filler';
import { resolveCurrentQuestionTarget } from '../src/Fill/Resolver';

function question(
  id: string,
  type: Question['type'],
  options: string[] = []
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

it('exposes a concise development diagnostic for questions that end as SKIPPED', () => {
  const report = createGenerationReport('cycle-1', [
    {
      questionId: 'name',
      status: 'GENERATED',
      answer: { questionId: 'name', value: 'Ada' },
      reason: null,
    },
    {
      questionId: 'language',
      status: 'ABSTAINED',
      answer: null,
      reason: 'LOW_CONFIDENCE',
    },
  ]);

  const fillReport = {
    cycleId: 'cycle-1',
    outcomes: [
      {
        questionId: 'name',
        status: 'SKIPPED',
        answer: null,
        reason: 'The reviewed answer was skipped.',
        code: null,
      },
    ],
  } satisfies {
    cycleId: string;
    outcomes: Array<{
      questionId: string;
      status: 'SKIPPED';
      answer: null;
      reason: string;
      code: null;
    }>;
  };

  expect(createSkipDiagnostics(report, fillReport)).toEqual([
    {
      questionId: 'name',
      generationStatus: 'GENERATED',
      generationReason: null,
      fillStatus: 'SKIPPED',
      fillReason: 'The reviewed answer was skipped.',
    },
  ]);
});

function createDocument(options = ''): Document {
  const document = new DOMParser().parseFromString(
    `<!doctype html>
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
    </main>`,
    'text/html'
  );

  document.querySelectorAll<HTMLElement>('[role="radio"]').forEach((option) => {
    option.addEventListener('click', () => {
      option
        .closest('[role="listitem"]')
        ?.querySelectorAll<HTMLElement>('[role="radio"]')
        .forEach((candidate) => {
          candidate.setAttribute(
            'aria-checked',
            candidate === option ? 'true' : 'false'
          );
        });
    });
  });
  document
    .querySelectorAll<HTMLElement>('[role="checkbox"]')
    .forEach((option) => {
      option.addEventListener('click', () => {
        option.setAttribute(
          'aria-checked',
          option.getAttribute('aria-checked') === 'true' ? 'false' : 'true'
        );
      });
    });
  return document;
}

function reportFor(
  results: Array<{ questionId: string; value: string | string[] }>
) {
  return createGenerationReport(
    'cycle-p4',
    results.map((result) => ({
      questionId: result.questionId,
      status: 'GENERATED' as const,
      answer: { questionId: result.questionId, value: result.value },
      reason: null,
    }))
  );
}

describe('P4 current DOM resolver', () => {
  it('resolves respondent questions through descendant data-params identity', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div role="list">
          <div role="listitem">
            <div data-params='%.@.[101,"Name",null,0,[[201,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"Name"]],"i1","i2",false,"i3"]'></div>
            <h3 role="heading">Name</h3>
            <input type="text" value="">
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    const result = resolveCurrentQuestionTarget(
      document,
      question('101', 'short-text')
    );

    expect(result.ok).toBe(true);
  });

  it('resolves by questionId and returns typed targets', () => {
    const result = resolveCurrentQuestionTarget(
      createDocument(),
      form.questions[0]
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.kind).toBe('single-choice');
      if (result.target.kind === 'single-choice') {
        expect(
          result.target.options.map((option) =>
            option.getAttribute('aria-label')
          )
        ).toEqual(['Alpha', 'Beta']);
      }
    }
  });

  it('reports missing questions, type mismatches, and missing controls', () => {
    expect(
      resolveCurrentQuestionTarget(
        createDocument(),
        question('missing', 'short-text')
      )
    ).toMatchObject({
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
    });
    expect(
      resolveCurrentQuestionTarget(
        createDocument(),
        question('choice', 'multiple-choice')
      )
    ).toMatchObject({
      ok: false,
      code: 'TYPE_MISMATCH',
    });
    expect(
      resolveCurrentQuestionTarget(
        createDocument(
          '<div role="listitem" data-question-id="empty" data-question-type="short-text"></div>'
        ),
        question('empty', 'short-text')
      )
    ).toMatchObject({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('does not use question text or resolve unrelated DOM questions', () => {
    const document = createDocument(
      '<div role="listitem" data-question-id="unrelated" data-question-text="choice"></div>'
    );
    const result = resolveCurrentQuestionTarget(
      document,
      question('choice', 'single-choice')
    );

    expect(result.ok).toBe(true);
    expect(
      document.querySelector('[data-question-id="unrelated"]')
    ).not.toBeNull();
  });
});

describe('P4 sequential filling and preservation', () => {
  it('fills a paragraph multi-blank answer as a comma-separated value string in blank order', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'paragraph', value: 'Paris, Rome' },
    ]);

    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes[0]).toMatchObject({
      questionId: 'paragraph',
      status: 'FILLED',
      answer: { questionId: 'paragraph', value: 'Paris, Rome' },
    });
    expect(
      (
        document.querySelector(
          '[data-question-id="paragraph"] textarea'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('Paris, Rome');
    expect(('Paris, Rome').split(',').map((part) => part.trim())).toEqual([
      'Paris',
      'Rome',
    ]);
  });

  it('fills a paragraph three-blank answer as one comma-separated value string in blank order', async () => {
    const document = createDocument();
    const report = reportFor([
      {
        questionId: 'paragraph',
        value: 'Italy, Mona Lisa, Michelangelo',
      },
    ]);

    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes[0]).toMatchObject({
      questionId: 'paragraph',
      status: 'FILLED',
      answer: {
        questionId: 'paragraph',
        value: 'Italy, Mona Lisa, Michelangelo',
      },
    });
    expect(
      (
        document.querySelector(
          '[data-question-id="paragraph"] textarea'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('Italy, Mona Lisa, Michelangelo');
    expect(
      'Italy, Mona Lisa, Michelangelo'.split(',').map((part) => part.trim())
    ).toEqual(['Italy', 'Mona Lisa', 'Michelangelo']);
  });

  it('leaves a single-blank paragraph answer as a single plain value string without comma splitting', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'paragraph', value: 'Mona Lisa' },
    ]);

    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes[0]).toMatchObject({
      questionId: 'paragraph',
      status: 'FILLED',
      answer: { questionId: 'paragraph', value: 'Mona Lisa' },
    });
    expect(
      (
        document.querySelector(
          '[data-question-id="paragraph"] textarea'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('Mona Lisa');
    expect('Mona Lisa'.split(',')).toEqual(['Mona Lisa']);
  });

  it('fills multiple choice, checkboxes, short answer, and paragraph in report order', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'checks', value: ['One', 'Three'] },
      { questionId: 'short', value: 'Ada' },
      { questionId: 'paragraph', value: 'A paragraph' },
    ]);

    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'FILLED',
      'FILLED',
      'FILLED',
    ]);
    expect(result.outcomes).toHaveLength(4);
    expect(result.outcomes[1]).toMatchObject({
      questionId: 'checks',
      status: 'FILLED',
    });
    expect(
      document
        .querySelector('[data-question-id="choice"] [aria-label="Beta"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    expect(
      document
        .querySelector('[data-question-id="checks"] [aria-label="Three"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    expect(
      document
        .querySelector('[data-question-id="short"] input')
        ?.getAttribute('value')
    ).toBe('');
    expect(
      (
        document.querySelector(
          '[data-question-id="short"] input'
        ) as HTMLInputElement
      ).value
    ).toBe('Ada');
    expect(
      (
        document.querySelector(
          '[data-question-id="paragraph"] textarea'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('A paragraph');
  });

  it('fills required controls through the same live-DOM path', async () => {
    const document = createDocument();
    const requiredForm: Form = {
      ...form,
      questions: form.questions.map((item) => ({ ...item, required: true })),
    };
    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'checks', value: ['One'] },
      { questionId: 'short', value: 'Required short' },
      { questionId: 'paragraph', value: 'Required paragraph' },
    ]);

    const result = await fillReviewedAnswers(
      document,
      requiredForm,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'FILLED',
      'FILLED',
      'FILLED',
    ]);
  });

  it('preserves existing answers without overwriting them', async () => {
    const document = createDocument();
    const choice = document.querySelector(
      '[data-question-id="choice"] [aria-label="Alpha"]'
    )!;
    choice.setAttribute('aria-checked', 'true');
    const checks = document.querySelector(
      '[data-question-id="checks"] [aria-label="One"]'
    )!;
    checks.setAttribute('aria-checked', 'true');
    const short = document.querySelector(
      '[data-question-id="short"] input'
    ) as HTMLInputElement;
    short.value = 'Existing short';
    const paragraph = document.querySelector(
      '[data-question-id="paragraph"] textarea'
    ) as HTMLTextAreaElement;
    paragraph.value = 'Existing paragraph';

    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'checks', value: ['One'] },
      { questionId: 'short', value: 'Generated short' },
      { questionId: 'paragraph', value: 'Generated paragraph' },
    ]);
    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      )
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
      'PRESERVED_EXISTING',
    ]);
    expect(short.value).toBe('Existing short');
    expect(paragraph.value).toBe('Existing paragraph');
  });

  it('replaces selected existing answers in Override mode and leaves others unchanged', async () => {
    const document = createDocument();
    const choice = document.querySelector(
      '[data-question-id="choice"] [aria-label="Alpha"]'
    )!;
    choice.setAttribute('aria-checked', 'true');
    const short = document.querySelector(
      '[data-question-id="short"] input'
    ) as HTMLInputElement;
    short.value = 'Existing short';
    const paragraph = document.querySelector(
      '[data-question-id="paragraph"] textarea'
    ) as HTMLTextAreaElement;
    paragraph.value = 'Existing paragraph';

    const report = reportFor([
      { questionId: 'choice', value: 'Beta' },
      { questionId: 'short', value: 'Replacement short' },
    ]);
    const result = await fillReviewedAnswers(
      document,
      form,
      report,
      report.results.map((item) =>
        acceptGeneratedAnswer(item.questionId as string, item.answer!)
      ),
      true
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'FILLED',
    ]);
    expect(
      document
        .querySelector('[data-question-id="choice"] [aria-label="Alpha"]')
        ?.getAttribute('aria-checked')
    ).toBe('false');
    expect(
      document
        .querySelector('[data-question-id="choice"] [aria-label="Beta"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    expect(short.value).toBe('Replacement short');
    expect(paragraph.value).toBe('Existing paragraph');
  });

  it('fills single-choice options without toggling an already-selected target', async () => {
    const cases = [
      { current: 'Beta', target: 'Beta', expected: 'Beta' },
      { current: 'Beta', target: 'Alpha', expected: 'Alpha' },
      { current: null, target: 'Beta', expected: 'Beta' },
    ] as const;

    for (const testCase of cases) {
      const document = createDocument();
      const current = testCase.current
        ? document.querySelector<HTMLElement>(
            `[data-question-id="choice"] [aria-label="${testCase.current}"]`
          )
        : null;
      current?.setAttribute('aria-checked', 'true');
      let clickCount = 0;
      if (current && testCase.current === testCase.target) {
        current.click = () => {
          clickCount += 1;
        };
      }
      const report = reportFor([
        { questionId: 'choice', value: testCase.target },
      ]);

      const result = await fillReviewedAnswers(
        document,
        form,
        report,
        [acceptGeneratedAnswer('choice', report.results[0].answer!)],
        true
      );

      expect(result.outcomes[0]).toMatchObject({
        questionId: 'choice',
        status: 'FILLED',
      });
      if (testCase.current === testCase.target) {
        expect(clickCount).toBe(0);
      }
      expect(
        document
          .querySelector(
            `[data-question-id="choice"] [aria-label="${testCase.expected}"]`
          )
          ?.getAttribute('aria-checked')
      ).toBe('true');
    }
  });

  it('supports edited and skipped review decisions', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'short', value: 'Generated' },
      { questionId: 'paragraph', value: 'Ignored' },
    ]);
    const result = await fillReviewedAnswers(document, form, report, [
      editReviewedAnswer('short', { questionId: 'short', value: 'Edited' }),
      skipReviewedAnswer('paragraph'),
    ]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'SKIPPED',
    ]);
    expect(
      (
        document.querySelector(
          '[data-question-id="short"] input'
        ) as HTMLInputElement
      ).value
    ).toBe('Edited');
    expect(
      (
        document.querySelector(
          '[data-question-id="paragraph"] textarea'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('');
  });

  it('keeps the generated-plus-skipped accounting row explicit in review decisions and fill outcomes', async () => {
    const document = createDocument();
    const report = createGenerationReport('cycle-p4', [
      {
        questionId: 'short',
        status: 'GENERATED' as const,
        answer: { questionId: 'short', value: 'Generated' },
        reason: null,
      },
      {
        questionId: 'paragraph',
        status: 'ABSTAINED' as const,
        answer: null,
        reason: 'LOW_CONFIDENCE',
      },
      {
        questionId: 'choice',
        status: 'GENERATION_FAILED' as const,
        answer: null,
        failure: { code: 'GENERATOR', message: 'No answer' },
      },
    ]);

    const decisions = createAcceptedReviewDecisions(report);
    expect(decisions).toMatchObject([
      { questionId: 'short', decision: 'accept', answer: { questionId: 'short', value: 'Generated' } },
      { questionId: 'paragraph', decision: 'skip', answer: null },
      { questionId: 'choice', decision: 'skip', answer: null },
    ]);

    const result = await fillReviewedAnswers(document, form, report, decisions);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILLED',
      'SKIPPED',
      'SKIPPED',
    ]);
  });

  it('reports checkbox partial and total failures', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'checks', value: ['One', 'Missing'] },
    ]);
    const partial = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);
    expect(partial.outcomes[0]).toMatchObject({
      status: 'PARTIAL_FILL',
      code: 'INVALID_OPTION',
    });
    expect(
      document
        .querySelector('[data-question-id="checks"] [aria-label="One"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');

    const failedReport = reportFor([
      { questionId: 'checks', value: ['Missing'] },
    ]);
    const failed = await fillReviewedAnswers(document, form, failedReport, [
      acceptGeneratedAnswer('checks', failedReport.results[0].answer!),
    ]);
    expect(failed.outcomes[0]).toMatchObject({
      status: 'FILL_FAILED',
      code: 'INVALID_OPTION',
    });
  });

  it('preserves checkbox extras and reports already-satisfied selections', async () => {
    const document = createDocument();
    const checks = document.querySelector('[data-question-id="checks"]')!;
    checks
      .querySelector('[aria-label="One"]')
      ?.setAttribute('aria-checked', 'true');
    checks
      .querySelector('[aria-label="Three"]')
      ?.setAttribute('aria-checked', 'true');
    const report = reportFor([{ questionId: 'checks', value: ['One'] }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);

    expect(result.outcomes[0].status).toBe('PRESERVED_EXISTING');
    expect(
      checks.querySelector('[aria-label="Three"]')?.getAttribute('aria-checked')
    ).toBe('true');
  });

  it('rolls back newly selected checkboxes when mutation fails', async () => {
    const document = createDocument();
    const checks = document.querySelector('[data-question-id="checks"]')!;
    const first = checks.querySelector<HTMLElement>('[aria-label="One"]')!;
    const second = checks.querySelector<HTMLElement>('[aria-label="Two"]')!;
    const firstClick = first.click.bind(first);
    let secondClickCount = 0;
    second.click = () => {
      secondClickCount += 1;
      if (secondClickCount === 1) {
        throw new Error('simulated checkbox failure');
      }
    };
    first.click = firstClick;
    const report = reportFor([{ questionId: 'checks', value: ['One', 'Two'] }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);

    expect(result.outcomes[0].status).toBe('FILL_FAILED');
    expect(first.getAttribute('aria-checked')).toBe('false');
  });

  it('reports partial fill when checkbox rollback cannot restore state', async () => {
    const document = createDocument();
    const checks = document.querySelector('[data-question-id="checks"]')!;
    const first = checks.querySelector<HTMLElement>('[aria-label="One"]')!;
    let clickCount = 0;
    first.click = () => {
      clickCount += 1;
      if (clickCount === 1) {
        first.setAttribute('aria-checked', 'true');
      } else {
        throw new Error('simulated rollback failure');
      }
    };
    const second = checks.querySelector<HTMLElement>('[aria-label="Two"]')!;
    second.click = () => {
      throw new Error('simulated checkbox failure');
    };
    const report = reportFor([{ questionId: 'checks', value: ['One', 'Two'] }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);

    expect(result.outcomes[0].status).toBe('PARTIAL_FILL');
  });

  it('fails single-choice filling when the click does not change live state', async () => {
    const document = createDocument();
    const option = document.querySelector<HTMLElement>(
      '[data-question-id="choice"] [aria-label="Beta"]'
    )!;
    option.replaceWith(option.cloneNode(true));
    const report = reportFor([{ questionId: 'choice', value: 'Beta' }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('choice', report.results[0].answer!),
    ]);

    expect(result.outcomes[0]).toMatchObject({
      status: 'FILL_FAILED',
      code: 'INVALID_OPTION',
    });
    expect(
      document
        .querySelector('[data-question-id="choice"] [aria-label="Beta"]')
        ?.getAttribute('aria-checked')
    ).toBe('false');
  });

  it('waits for asynchronous single-choice selection before verifying', async () => {
    const document = createDocument();
    const option = document.querySelector<HTMLElement>(
      '[data-question-id="choice"] [aria-label="Beta"]'
    )!;
    option.click = () => {
      setTimeout(() => option.setAttribute('aria-checked', 'true'), 0);
    };
    const report = reportFor([{ questionId: 'choice', value: 'Beta' }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('choice', report.results[0].answer!),
    ]);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      questionId: 'choice',
      status: 'FILLED',
    });
    expect(option.getAttribute('aria-checked')).toBe('true');
  });

  it('waits for all asynchronous checkbox selections as one outcome', async () => {
    const document = createDocument();
    const options = ['One', 'Three'].map(
      (label) =>
        document.querySelector<HTMLElement>(
          `[data-question-id="checks"] [aria-label="${label}"]`
        )!
    );
    for (const option of options) {
      option.click = () => {
        setTimeout(() => option.setAttribute('aria-checked', 'true'), 0);
      };
    }
    const report = reportFor([
      { questionId: 'checks', value: ['One', 'Three'] },
    ]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      questionId: 'checks',
      status: 'FILLED',
    });
    expect(
      options.map((option) => option.getAttribute('aria-checked'))
    ).toEqual(['true', 'true']);
  });

  it('fills contenteditable paragraph controls and verifies their content', async () => {
    const document = createDocument(`
      <div role="listitem" data-question-id="editable" data-question-type="paragraph">
        <div contenteditable="true"></div>
      </div>`);
    const editableQuestion = question('editable', 'paragraph');
    const report = reportFor([
      { questionId: 'editable', value: 'Editable details' },
    ]);
    const result = await fillReviewedAnswers(
      document,
      { ...form, questions: [editableQuestion] },
      report,
      [acceptGeneratedAnswer('editable', report.results[0].answer!)]
    );

    expect(result.outcomes[0].status).toBe('FILLED');
    expect(
      document.querySelector(
        '[data-question-id="editable"] [contenteditable="true"]'
      )?.textContent
    ).toBe('Editable details');
  });

  it('fails when a checkbox mutation does not appear in the live DOM', async () => {
    const document = createDocument();
    const option = document.querySelector<HTMLElement>(
      '[data-question-id="checks"] [aria-label="One"]'
    )!;
    option.replaceWith(option.cloneNode(true));
    const report = reportFor([{ questionId: 'checks', value: ['One'] }]);

    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('checks', report.results[0].answer!),
    ]);

    expect(result.outcomes[0].status).toBe('FILL_FAILED');
  });

  it('continues after a failed question and preserves deterministic order', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'missing', value: 'No target' },
      { questionId: 'short', value: 'Still fills' },
    ]);
    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('missing', report.results[0].answer!),
      acceptGeneratedAnswer('short', report.results[1].answer!),
    ]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'FILL_FAILED',
      'FILLED',
    ]);
    expect(
      (
        document.querySelector(
          '[data-question-id="short"] input'
        ) as HTMLInputElement
      ).value
    ).toBe('Still fills');
  });

  it('does not fill a DOM question without a generation result', async () => {
    const document = createDocument();
    const report = reportFor([
      { questionId: 'short', value: 'Only generated answer' },
    ]);
    const result = await fillReviewedAnswers(document, form, report, [
      acceptGeneratedAnswer('short', report.results[0].answer!),
    ]);

    expect(result.outcomes).toHaveLength(1);
    expect(
      (
        document.querySelector(
          '[data-question-id="later"] input'
        ) as HTMLInputElement
      ).value
    ).toBe('');
  });
});
