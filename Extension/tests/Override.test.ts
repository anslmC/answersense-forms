import { describe, expect, it } from 'vitest';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import type { GenerationInterface } from '../src/Generation/Contract';
import { createOverrideFilledIntent } from '../src/Generation/Intent';
import { fillReviewedAnswers } from '../src/Fill/Filler';
import { createFinalizedPageHandoff } from '../src/Fill/Handoff';
import {
  eligibleOverrideQuestionIds,
  inspectOverrideTarget,
  inspectOverrideTargets,
  OVERRIDE_EMPTY_REASON,
} from '../src/Fill/Override';
import { createAcceptedReviewDecisions } from '../src/Review/Decisions';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';

const THREE_BLANKS =
  'Name the country, the painting, and the artist: ________ was home to the ________ painted by ________.';

function respondentDocument(
  questionText: string,
  type: 'short-text' | 'paragraph',
  options: { value?: string; control?: boolean; controlType?: string } = {}
): Document {
  const controlType =
    options.controlType ?? (type === 'paragraph' ? 'textarea' : 'text');
  const control =
    options.control === false
      ? ''
      : controlType === 'textarea'
        ? '<textarea></textarea>'
        : `<input type="text" value="${options.value ?? ''}">`;
  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/form-1/viewform">
        <div role="list">
          <div role="listitem" data-question-type="${type}">
            <div data-params="%.@.[9001]"></div>
            <h3 class="M7eMe" role="heading">${questionText}</h3>
            ${control}
          </div>
        </div>
      </form>
    </main>`,
    'text/html'
  );
}

function normalize(document: Document): NormalizedActivePage {
  return normalizeDiscoveredActivePage(
    discoverActiveGoogleFormsPage(document)!
  );
}

function withExistingInput(
  page: NormalizedActivePage,
  questionId: string,
  value: string | string[] | null
): Form {
  return {
    ...page.form,
    questions: page.form.questions.map((question) =>
      question.id === questionId
        ? { ...question, existingInput: { value, hasValue: value !== null } }
        : question
    ),
  };
}

function question(
  id: string,
  text: string,
  type: Question['type'] = 'short-text'
): Question {
  return {
    id,
    text,
    type,
    required: false,
    options: [],
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
  };
}

function generatorFor(value: string | string[]): GenerationInterface {
  return {
    generate: async (request) => ({
      cycleId: request.cycleId,
      results: [
        {
          questionId: request.questions[0].questionId,
          status: 'GENERATED',
          answer: {
            questionId: request.questions[0].questionId,
            value,
          },
        },
      ],
    }),
  };
}

describe('override target classification', () => {
  it('accepts a question whose stored answer and live control both hold a value', () => {
    const document = respondentDocument('Your name?', 'short-text', {
      value: 'Ada',
    });
    const page = normalize(document);
    const target = inspectOverrideTarget(document, page.form, '9001');

    expect(target).toMatchObject({
      status: 'eligible',
      code: null,
      answer: { questionId: '9001', value: 'Ada' },
    });
  });

  it('accepts a live answer even when the stored record is stale-empty', () => {
    const document = respondentDocument('Your name?', 'short-text', {
      value: 'Ada',
    });
    const page = normalize(document);
    const staleForm = withExistingInput(page, '9001', null);

    const target = inspectOverrideTarget(document, staleForm, '9001');

    expect(target).toMatchObject({
      status: 'eligible',
      answer: { questionId: '9001', value: 'Ada' },
    });
  });

  it('does not report a stale-filled record as empty when the control still holds an answer', () => {
    const document = respondentDocument('Your name?', 'short-text', {
      value: 'Ada',
    });
    const page = normalize(document);
    const recordOnlyForm = withExistingInput(page, '9001', 'Ada');

    expect(
      inspectOverrideTarget(document, recordOnlyForm, '9001')
    ).toMatchObject({
      status: 'eligible',
      reason: null,
    });
  });

  it('keeps override available when the record holds an answer but the control is now empty', () => {
    const document = respondentDocument('Your name?', 'short-text');
    const page = normalize(document);
    const staleForm = withExistingInput(page, '9001', 'Ada');

    const target = inspectOverrideTarget(document, staleForm, '9001');

    expect(target).toMatchObject({
      status: 'eligible',
      answer: { questionId: '9001', value: 'Ada' },
    });
  });

  it('reports a genuinely empty control with the override message and code', () => {
    const document = respondentDocument('Your name?', 'short-text');
    const page = normalize(document);

    expect(inspectOverrideTarget(document, page.form, '9001')).toEqual({
      questionId: '9001',
      status: 'empty',
      code: 'OVERRIDE_VALIDATION_FAILED',
      reason: OVERRIDE_EMPTY_REASON,
      answer: null,
    });
  });

  it('distinguishes a missing question, a missing control, and a changed type', () => {
    const emptyDocument = respondentDocument('Your name?', 'short-text');

    expect(
      inspectOverrideTarget(
        emptyDocument,
        {
          formId: 'form-1',
          activePageId: 'page-1',
          questions: [question('absent', 'Absent question')],
        },
        'absent'
      )
    ).toMatchObject({
      status: 'unavailable',
      code: 'ELEMENT_NOT_FOUND',
      reason: expect.stringContaining('no longer present'),
    });

    const controlDocument = respondentDocument('Your name?', 'short-text', {
      control: false,
    });
    const controlPage = normalize(controlDocument);
    expect(
      inspectOverrideTarget(controlDocument, controlPage.form, '9001')
    ).toMatchObject({
      status: 'unavailable',
      code: 'TARGET_NOT_FOUND',
    });

    const typedDocument = respondentDocument('Your name?', 'paragraph');
    const typedPage = normalize(typedDocument);
    const changedTypeForm: Form = {
      ...typedPage.form,
      questions: typedPage.form.questions.map((item) => ({
        ...item,
        type: 'short-text',
        existingInput: { value: 'Ada', hasValue: true },
      })),
    };
    expect(
      inspectOverrideTarget(typedDocument, changedTypeForm, '9001')
    ).toMatchObject({
      status: 'unavailable',
      code: 'TYPE_MISMATCH',
    });
  });

  it('keeps the selection order and drops only ineligible questions', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
        <form data-clean-viewform-url="https://docs.google.com/forms/d/e/form-1/viewform">
          <div role="list">
            <div role="listitem" data-question-type="short-text">
              <div data-params="%.@.[9002]"></div>
              <h3 class="M7eMe" role="heading">First</h3>
              <input type="text" value="One">
            </div>
            <div role="listitem" data-question-type="short-text">
              <div data-params="%.@.[9003]"></div>
              <h3 class="M7eMe" role="heading">Second</h3>
              <input type="text" value="">
            </div>
            <div role="listitem" data-question-type="short-text">
              <div data-params="%.@.[9004]"></div>
              <h3 class="M7eMe" role="heading">Third</h3>
              <input type="text" value="Three">
            </div>
          </div>
        </form>
      </main>`,
      'text/html'
    );
    const page = normalize(document);

    const targets = inspectOverrideTargets(document, page.form, [
      '9003',
      '9002',
      '9004',
    ]);

    expect(targets.map((target) => target.status)).toEqual([
      'empty',
      'eligible',
      'eligible',
    ]);
    expect(eligibleOverrideQuestionIds(targets)).toEqual(['9002', '9004']);
  });
});

describe('override execution and reconciliation', () => {
  it('replaces an existing answer and records the replacement in the handoff', async () => {
    const document = respondentDocument('Your name?', 'short-text', {
      value: 'Ada',
    });
    const page = normalize(document);
    const report = await new GenerationCoordinator(
      () => 'cycle-override'
    ).generate(
      page,
      [],
      generatorFor('Grace'),
      undefined,
      createOverrideFilledIntent(['9001'])
    );

    const fillReport = await fillReviewedAnswers(
      document,
      page.form,
      report!,
      createAcceptedReviewDecisions(report!),
      true
    );

    expect(fillReport.outcomes).toEqual([
      {
        questionId: '9001',
        status: 'FILLED',
        answer: { questionId: '9001', value: 'Grace' },
        reason: null,
        code: null,
      },
    ]);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe(
      'Grace'
    );

    const handoff = createFinalizedPageHandoff(document, page.form, fillReport);
    expect(handoff.entries[0]).toMatchObject({
      questionId: '9001',
      answer: { questionId: '9001', value: 'Grace' },
      outcome: 'FILLED',
    });
  });

  it('runs Generate then Override for the reported multi-blank sequence', async () => {
    const document = respondentDocument(THREE_BLANKS, 'paragraph');
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const page = normalize(document);

    const generation = await new GenerationCoordinator(
      () => 'cycle-1'
    ).generate(page, [], generatorFor('Italy, Mona Lisa, Michelangelo'));
    const fill = await fillReviewedAnswers(
      document,
      page.form,
      generation!,
      createAcceptedReviewDecisions(generation!)
    );
    expect(fill.outcomes[0].status).toBe('FILLED');
    expect(textarea.value).toBe('Italy, Mona Lisa, Michelangelo');

    const refreshed = normalize(document);
    expect(refreshed.form.questions[0]).toMatchObject({
      answerParts: 3,
      existingInput: {
        value: 'Italy, Mona Lisa, Michelangelo',
        hasValue: true,
      },
    });
    expect(
      inspectOverrideTargets(document, refreshed.form, ['9001'])[0].status
    ).toBe('eligible');

    const override = await new GenerationCoordinator(() => 'cycle-2').generate(
      refreshed,
      [],
      generatorFor('Greece, Starry Night, Van Gogh'),
      undefined,
      createOverrideFilledIntent(['9001'])
    );
    const overrideFill = await fillReviewedAnswers(
      document,
      refreshed.form,
      override!,
      createAcceptedReviewDecisions(override!),
      true
    );

    expect(overrideFill.outcomes[0]).toMatchObject({
      status: 'FILLED',
      answer: { value: 'Greece, Starry Night, Van Gogh' },
    });
    expect(textarea.value).toBe('Greece, Starry Night, Van Gogh');
    expect(
      createFinalizedPageHandoff(document, refreshed.form, overrideFill)
        .entries[0].answer
    ).toMatchObject({ value: 'Greece, Starry Night, Van Gogh' });
  });

  it('overrides a live-filled answer after state reconciliation', async () => {
    const document = respondentDocument('Your name?', 'short-text', {
      value: 'Ada',
    });
    const page = normalize(document);
    const reconciledForm = withExistingInput(page, '9001', 'Ada');
    const selected = await new GenerationCoordinator(
      () => 'cycle-live'
    ).generate(
      { ...page, form: reconciledForm },
      [],
      generatorFor('Grace'),
      undefined,
      createOverrideFilledIntent(['9001'])
    );
    expect(selected?.results[0]).toMatchObject({ status: 'GENERATED' });

    const fillReport = await fillReviewedAnswers(
      document,
      reconciledForm,
      selected!,
      createAcceptedReviewDecisions(selected!),
      true
    );

    expect(fillReport.outcomes[0].status).toBe('FILLED');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe(
      'Grace'
    );
  });
});
