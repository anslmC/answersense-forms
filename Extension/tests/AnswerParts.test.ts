import { describe, expect, it, vi } from 'vitest';
import {
  buildAnswerPartsInstructions,
  countAnswerParts,
  formatAnswerParts,
  resolveAnswerParts,
  splitAnswerParts,
} from '../src/Generation/AnswerParts';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { validateGenerationResponse } from '../src/Generation/Validation';
import { NVIDIA_MODEL, NvidiaProvider } from '../src/Generation/NvidiaProvider';
import type { Form, Question } from '../src/Models/Logical';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { fillReviewedAnswers } from '../src/Fill/Filler';
import { createAcceptedReviewDecisions } from '../src/Review/Decisions';

function respondentDocument(
  questionText: string,
  type: 'short-text' | 'paragraph'
): Document {
  const control =
    type === 'paragraph'
      ? '<textarea></textarea>'
      : '<input type="text" value="">';
  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/form-1/viewform">
        <div role="list">
          <div role="listitem" data-question-type="${type}">
            <div data-params="%.@.[7001]"></div>
            <h3 class="M7eMe" role="heading">${questionText}</h3>
            ${control}
          </div>
        </div>
      </form>
    </main>`,
    'text/html'
  );
}

function textControl(
  document: Document
): HTMLTextAreaElement | HTMLInputElement {
  return document.querySelector('textarea, input[type="text"]') as
    HTMLTextAreaElement | HTMLInputElement;
}

function question(
  id: string,
  text: string,
  type: Question['type'],
  answerParts?: number,
  options: string[] = []
): Question {
  return {
    id,
    text,
    type,
    required: false,
    options: options.map((label) => ({ label, selected: false })),
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
    ...(answerParts ? { answerParts } : {}),
  };
}

function reportInput(
  cycleId: string,
  questionId: string,
  value: string | string[]
): GenerationResponse {
  return {
    cycleId,
    results: [
      {
        questionId,
        status: 'GENERATED',
        answer: { questionId, value },
      },
    ],
  };
}

const THREE_BLANKS =
  'Name the country, the painting, and the artist: ________ was home to the ________ painted by ________.';

describe('multi-part answer helpers', () => {
  it('counts blank markers and keeps single-part questions unchanged', () => {
    expect(countAnswerParts(THREE_BLANKS)).toBe(3);
    expect(countAnswerParts('Capital of France is ____?')).toBe(1);
    expect(countAnswerParts('Explain your reasoning.')).toBe(1);
    expect(resolveAnswerParts({ text: 'a ____ b ____', answerParts: 4 })).toBe(
      4
    );
    expect(resolveAnswerParts({ text: null })).toBe(1);
  });

  it('splits and formats components without losing ordering', () => {
    expect(splitAnswerParts('Italy, Mona Lisa; Michelangelo')).toEqual([
      'Italy',
      'Mona Lisa',
      'Michelangelo',
    ]);
    expect(formatAnswerParts(['Italy', 'Mona Lisa', 'Michelangelo'])).toBe(
      'Italy, Mona Lisa, Michelangelo'
    );
  });

  it('describes the blank requirement the same way for every provider', () => {
    expect(
      buildAnswerPartsInstructions([
        {
          questionId: 'q1',
          text: THREE_BLANKS,
          type: 'paragraph',
          answerParts: 3,
        },
      ])
    ).toEqual([
      expect.stringContaining('Question q1 contains 3 blank markers'),
    ]);
    expect(
      buildAnswerPartsInstructions([
        {
          questionId: 'q2',
          text: 'One ____ blank only',
          type: 'paragraph',
        },
      ])
    ).toEqual([]);
  });
});

describe('multi-part question extraction and filling', () => {
  it('keeps a two-blank paragraph as one question with two answer parts', () => {
    const document = respondentDocument(
      'The first city is ____ and the second city is ____.',
      'paragraph'
    );
    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions).toHaveLength(1);
    expect(discovered?.questions[0]).toMatchObject({
      kind: 'supported',
      id: '7001',
      type: 'paragraph',
      answerParts: 2,
    });

    const normalized = normalizeDiscoveredActivePage(discovered!);
    expect(normalized.form.questions).toHaveLength(1);
    expect(normalized.form.questions[0]).toMatchObject({
      id: '7001',
      answerParts: 2,
    });
  });

  it('keeps a three-blank paragraph as one question with three answer parts', () => {
    const document = respondentDocument(THREE_BLANKS, 'paragraph');
    const discovered = discoverActiveGoogleFormsPage(document);
    const normalized = normalizeDiscoveredActivePage(discovered!);

    expect(normalized.form.questions).toHaveLength(1);
    expect(normalized.form.questions[0].answerParts).toBe(3);
  });

  it('treats a two-blank short-answer question as one multi-part question', () => {
    const document = respondentDocument(
      'First name ____ and last name ____',
      'short-text'
    );
    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions).toHaveLength(1);
    expect(discovered?.questions[0]).toMatchObject({
      type: 'short-text',
      answerParts: 2,
    });
  });

  it('sends the blank requirement and fills ordered components for three blanks', async () => {
    const document = respondentDocument(THREE_BLANKS, 'paragraph');
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    let receivedRequest: GenerationRequest | undefined;
    const generator: GenerationInterface = {
      generate: async (request) => {
        receivedRequest = request;
        return reportInput(request.cycleId, '7001', [
          'Italy',
          'Mona Lisa',
          'Michelangelo',
        ]);
      },
    };

    const report = await new GenerationCoordinator(
      () => 'cycle-parts'
    ).generate(page, [], generator);

    expect(receivedRequest?.questions[0]).toMatchObject({
      questionId: '7001',
      answerParts: 3,
    });
    expect(report?.results[0]).toMatchObject({
      status: 'GENERATED',
      answer: {
        questionId: '7001',
        value: 'Italy, Mona Lisa, Michelangelo',
      },
    });

    const fillReport = await fillReviewedAnswers(
      document,
      page.form,
      report!,
      createAcceptedReviewDecisions(report!)
    );

    expect(fillReport.outcomes[0].status).toBe('FILLED');
    expect(textControl(document).value).toBe('Italy, Mona Lisa, Michelangelo');
  });

  it('accepts a comma-separated string for two blanks and normalizes separators', async () => {
    const document = respondentDocument(
      'The first city is ____ and the second city is ____.',
      'paragraph'
    );
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    const generator: GenerationInterface = {
      generate: async (request) => ({
        cycleId: request.cycleId,
        results: [
          {
            questionId: '7001',
            status: 'GENERATED',
            answer: { questionId: '7001', value: 'Paris; Rome' },
          },
        ],
      }),
    };

    const report = await new GenerationCoordinator(() => 'cycle-two').generate(
      page,
      [],
      generator
    );

    expect(report?.results[0]).toMatchObject({
      status: 'GENERATED',
      answer: { value: 'Paris, Rome' },
    });

    const fillReport = await fillReviewedAnswers(
      document,
      page.form,
      report!,
      createAcceptedReviewDecisions(report!)
    );
    expect(fillReport.outcomes[0].status).toBe('FILLED');
    expect(textControl(document).value).toBe('Paris, Rome');
  });

  it('rejects a concatenated three-blank answer instead of filling it', async () => {
    const document = respondentDocument(THREE_BLANKS, 'paragraph');
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    const generator: GenerationInterface = {
      generate: async (request) => ({
        cycleId: request.cycleId,
        results: [
          {
            questionId: '7001',
            status: 'GENERATED',
            answer: {
              questionId: '7001',
              value: 'ItalyMona LisaMichelangelo',
            },
          },
        ],
      }),
    };

    const report = await new GenerationCoordinator(
      () => 'cycle-concatenated'
    ).generate(page, [], generator);

    expect(report?.results[0]).toMatchObject({
      status: 'VALIDATION_FAILED',
      answer: null,
      reason:
        'The generated answer did not include a value for every blank in the question.',
    });

    const fillReport = await fillReviewedAnswers(
      document,
      page.form,
      report!,
      createAcceptedReviewDecisions(report!)
    );
    expect(fillReport.outcomes[0].status).toBe('SKIPPED');
    expect(textControl(document).value).toBe('');
  });

  it('rejects incomplete multi-part answers in both representations', () => {
    const form: Form = {
      formId: 'form-1',
      activePageId: 'page-1',
      questions: [question('q', THREE_BLANKS, 'paragraph', 3)],
    };

    expect(
      validateGenerationResponse(
        reportInput('cycle-incomplete', 'q', 'Italy, Mona Lisa'),
        form,
        'cycle-incomplete'
      )[0]
    ).toMatchObject({ status: 'VALIDATION_FAILED', answer: null });

    expect(
      validateGenerationResponse(
        reportInput('cycle-incomplete-array', 'q', ['Italy', 'Mona Lisa']),
        form,
        'cycle-incomplete-array'
      )[0]
    ).toMatchObject({ status: 'VALIDATION_FAILED', answer: null });
  });

  it('accepts valid multi-part answers from strings and arrays', () => {
    const form: Form = {
      formId: 'form-1',
      activePageId: 'page-1',
      questions: [question('q', THREE_BLANKS, 'paragraph', 3)],
    };

    expect(
      validateGenerationResponse(
        reportInput('cycle-string', 'q', 'Italy, Mona Lisa, Michelangelo'),
        form,
        'cycle-string'
      )[0]
    ).toMatchObject({
      status: 'GENERATED',
      answer: { value: 'Italy, Mona Lisa, Michelangelo' },
    });

    expect(
      validateGenerationResponse(
        reportInput('cycle-array', 'q', ['Italy', 'Mona Lisa', 'Michelangelo']),
        form,
        'cycle-array'
      )[0]
    ).toMatchObject({
      status: 'GENERATED',
      answer: { value: 'Italy, Mona Lisa, Michelangelo' },
    });
  });

  it('leaves single-part text answers untouched, including commas', () => {
    const form: Form = {
      formId: 'form-1',
      activePageId: 'page-1',
      questions: [
        question('short', 'Where do you live?', 'short-text'),
        question('paragraph', 'Describe the painting: ____', 'paragraph', 1),
      ],
    };

    const results = validateGenerationResponse(
      {
        cycleId: 'cycle-single',
        results: [
          {
            questionId: 'short',
            status: 'GENERATED',
            answer: { questionId: 'short', value: 'Nice, France' },
          },
          {
            questionId: 'paragraph',
            status: 'GENERATED',
            answer: {
              questionId: 'paragraph',
              value: 'A portrait, oil on poplar',
            },
          },
        ],
      },
      form,
      'cycle-single'
    );

    expect(results).toEqual([
      {
        questionId: 'short',
        status: 'GENERATED',
        answer: { questionId: 'short', value: 'Nice, France' },
        reason: null,
      },
      {
        questionId: 'paragraph',
        status: 'GENERATED',
        answer: {
          questionId: 'paragraph',
          value: 'A portrait, oil on poplar',
        },
        reason: null,
      },
    ]);
  });

  it('keeps choice validation unchanged for supported option types', () => {
    const form: Form = {
      formId: 'form-1',
      activePageId: 'page-1',
      questions: [
        question('choice', 'Pick one', 'single-choice', undefined, [
          'Alpha',
          'Beta',
        ]),
        question('checks', 'Pick some', 'multiple-choice', undefined, [
          'One',
          'Two',
        ]),
      ],
    };

    expect(
      validateGenerationResponse(
        {
          cycleId: 'cycle-choice',
          results: [
            {
              questionId: 'choice',
              status: 'GENERATED',
              answer: { questionId: 'choice', value: 'Beta' },
            },
            {
              questionId: 'checks',
              status: 'GENERATED',
              answer: { questionId: 'checks', value: ['One', 'Two'] },
            },
          ],
        },
        form,
        'cycle-choice'
      ).map((result) => result.status)
    ).toEqual(['GENERATED', 'GENERATED']);
  });
});

describe('provider multi-part guidance parity', () => {
  it('gives NVIDIA the same one-value-per-blank instruction', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  cycleId: 'nvidia-parts',
                  results: [
                    {
                      questionId: '7001',
                      status: 'GENERATED',
                      answer: {
                        questionId: '7001',
                        value: 'Italy, Mona Lisa, Michelangelo',
                      },
                    },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200 }
      );
    });

    await new NvidiaProvider(
      'synthetic-test-key',
      NVIDIA_MODEL,
      fetchMock
    ).generate({
      cycleId: 'nvidia-parts',
      pageId: 'page-1',
      questions: [
        {
          questionId: '7001',
          text: THREE_BLANKS,
          type: 'paragraph',
          required: false,
          options: [],
          answerParts: 3,
        },
      ],
      settledContext: [],
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const payload = JSON.parse(String(init.body));
    expect(payload.messages[1].content).toContain(
      'Question 7001 contains 3 blank markers'
    );
    expect(payload.messages[1].content).toContain(
      'Do not concatenate the values into a single token.'
    );
  });
});
