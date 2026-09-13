import { describe, expect, it, vi } from 'vitest';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';
import {
  buildSettledContext,
  type SettledPageState,
} from '../src/Generation/Context';
import {
  GenerationCoordinator,
  selectGenerationCandidates,
} from '../src/Generation/Pipeline';
import {
  createOverrideFilledIntent,
  validOverrideQuestionIds,
  validateOverrideSelection,
} from '../src/Generation/Intent';
import { createGenerationReport } from '../src/Generation/Report';
import {
  abandonPendingPage,
  commitPendingPageAfterSuccessfulTransition,
  createPendingPageStateFromReport,
  editPendingAnswer,
  restartPendingPage,
} from '../src/Generation/Pending';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import {
  GenerationResponseValidationError,
  validateGenerationResponse,
} from '../src/Generation/Validation';

function createQuestion(
  id: string,
  type: Question['type'],
  options: string[] = [],
  required = false
): Question {
  return {
    id,
    text: `Question ${id}`,
    type,
    required,
    options: options.map((label, index) => ({ label, selected: index === 0 })),
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
  };
}

const form: Form = {
  formId: 'form-1',
  activePageId: 'page-1',
  questions: [
    createQuestion('name', 'short-text', [], true),
    createQuestion('language', 'single-choice', ['TypeScript', 'JavaScript']),
    createQuestion('topics', 'multiple-choice', ['Testing', 'Accessibility']),
  ],
};

const page: NormalizedActivePage = {
  form,
  questionResults: form.questions.map((question) => ({
    questionId: question.id,
    status: 'ready',
    answer: null,
    reason: null,
  })),
  processingCycle: { cycleId: 'discovery' },
};

function validResponse(cycleId = 'cycle-1'): GenerationResponse {
  return {
    cycleId,
    results: [
      {
        questionId: 'name',
        status: 'GENERATED',
        answer: { questionId: 'name', value: 'Ada' },
      },
      {
        questionId: 'language',
        status: 'GENERATED',
        answer: { questionId: 'language', value: 'TypeScript' },
      },
      {
        questionId: 'topics',
        status: 'GENERATED',
        answer: { questionId: 'topics', value: ['Testing'] },
      },
    ],
  };
}

function createGenerator(response: GenerationResponse): GenerationInterface {
  return { generate: vi.fn(async () => response) };
}

describe('Generation response validation', () => {
  it('accepts valid exhaustive results and matches by questionId only', () => {
    const results = validateGenerationResponse(
      validResponse(),
      form,
      'cycle-1'
    );

    expect(results.map((result) => result.status)).toEqual([
      'GENERATED',
      'GENERATED',
      'GENERATED',
    ]);
    expect(results[0].answer?.value).toBe('Ada');
  });

  it('rejects malformed, stale, duplicate, and non-exhaustive responses', () => {
    expect(() => validateGenerationResponse(null, form, 'cycle-1')).toThrow(
      GenerationResponseValidationError
    );
    expect(() =>
      validateGenerationResponse(
        { ...validResponse(), cycleId: '' },
        form,
        'cycle-1'
      )
    ).toThrow();
    expect(() =>
      validateGenerationResponse(
        { ...validResponse(), cycleId: 'cycle-2' },
        form,
        'cycle-1'
      )
    ).toThrow();
    expect(() =>
      validateGenerationResponse(
        {
          ...validResponse(),
          results: [...validResponse().results, validResponse().results[0]],
        },
        form,
        'cycle-1'
      )
    ).toThrow();
    expect(() =>
      validateGenerationResponse(
        {
          ...validResponse(),
          results: validResponse().results.slice(0, 2),
        },
        form,
        'cycle-1'
      )
    ).toThrow();
    expect(() =>
      validateGenerationResponse(
        {
          ...validResponse(),
          results: validResponse().results.map((result) =>
            result.questionId === 'name'
              ? { ...result, questionId: 'question-text-match' }
              : result
          ),
        },
        form,
        'cycle-1'
      )
    ).toThrow();
  });

  it('preserves valid results and marks invalid answers as VALIDATION_FAILED', () => {
    const response = validResponse();
    response.results[1] = {
      questionId: 'language',
      status: 'GENERATED',
      answer: { questionId: 'language', value: 'Rust' },
    };

    const results = validateGenerationResponse(response, form, 'cycle-1');

    expect(results[0].status).toBe('GENERATED');
    expect(results[1]).toMatchObject({
      status: 'VALIDATION_FAILED',
      answer: null,
    });
    expect(results[2].status).toBe('GENERATED');
  });

  it('supports per-question generation failures', () => {
    const response = validResponse();
    response.results[2] = {
      questionId: 'topics',
      status: 'GENERATION_FAILED',
      answer: null,
      failure: { code: 'BACKEND_ERROR', message: 'Unavailable' },
    };

    expect(
      validateGenerationResponse(response, form, 'cycle-1')[2]
    ).toMatchObject({
      status: 'GENERATION_FAILED',
      reason: 'Unavailable',
    });
  });

  it('accepts abstained results as a valid non-answer decision', () => {
    const response: GenerationResponse = {
      cycleId: 'cycle-1',
      results: [
        {
          questionId: 'name',
          status: 'ABSTAINED',
          answer: null,
          reason: 'LOW_CONFIDENCE',
        },
        {
          questionId: 'language',
          status: 'GENERATED',
          answer: { questionId: 'language', value: 'TypeScript' },
        },
        {
          questionId: 'topics',
          status: 'GENERATED',
          answer: { questionId: 'topics', value: ['Testing'] },
        },
      ],
    };

    const results = validateGenerationResponse(response, form, 'cycle-1');
    expect(results[0]).toMatchObject({
      questionId: 'name',
      status: 'ABSTAINED',
      answer: null,
      reason: 'LOW_CONFIDENCE',
    });
    expect(results[1].status).toBe('GENERATED');
    expect(results[2].status).toBe('GENERATED');
  });

  it('keeps required-field final validation with Google Forms', () => {
    const requiredForm: Form = {
      ...form,
      questions: [
        createQuestion('short-required', 'short-text', [], true),
        createQuestion('paragraph-required', 'paragraph', [], true),
        createQuestion('choice-required', 'single-choice', ['A'], true),
        createQuestion('checks-required', 'multiple-choice', ['A'], true),
      ],
    };
    const response: GenerationResponse = {
      cycleId: 'cycle-required',
      results: [
        {
          questionId: 'short-required',
          status: 'GENERATED',
          answer: { questionId: 'short-required', value: '' },
        },
        {
          questionId: 'paragraph-required',
          status: 'GENERATED',
          answer: { questionId: 'paragraph-required', value: '' },
        },
        {
          questionId: 'choice-required',
          status: 'GENERATED',
          answer: { questionId: 'choice-required', value: 'A' },
        },
        {
          questionId: 'checks-required',
          status: 'GENERATED',
          answer: { questionId: 'checks-required', value: [] },
        },
      ],
    };

    expect(
      validateGenerationResponse(response, requiredForm, 'cycle-required').map(
        (result) => result.status
      )
    ).toEqual(['GENERATED', 'GENERATED', 'GENERATED', 'GENERATED']);
  });

  it('excludes unsupported questions from generation requests and results', async () => {
    const unsupportedForm: Form = {
      ...form,
      questions: [
        ...form.questions,
        {
          id: 'dropdown',
          text: 'Dropdown',
          type: null,
          required: false,
          options: [],
          existingInput: null,
          supported: false,
          unsupportedReason: 'Question type is unsupported.',
        },
      ],
    };
    const generator: GenerationInterface = {
      generate: vi.fn(async (request): Promise<GenerationResponse> => ({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: {
            questionId: question.questionId,
            value: question.type === 'multiple-choice' ? ['Testing'] : 'Answer',
          },
        })),
      })),
    };

    const coordinator = new GenerationCoordinator(() => 'cycle-unsupported');
    const report = await coordinator.generate(
      { ...page, form: unsupportedForm },
      [],
      generator
    );

    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: expect.not.arrayContaining([
          expect.objectContaining({ questionId: 'dropdown' }),
        ]),
      })
    );
    expect(report?.results[report.results.length - 1]).toMatchObject({
      questionId: 'dropdown',
      status: 'unsupported',
    });
  });
});

describe('Settled context and pending page state', () => {
  it('includes settled user edits and excludes skipped or unanswered items', () => {
    const settledPages: SettledPageState[] = [
      {
        pageId: 'page-1',
        answers: [
          {
            answer: { questionId: 'name', value: 'User edit' },
            questionText: 'Name',
          },
          {
            answer: { questionId: 'skipped', value: 'ignored' },
            questionText: 'Optional',
            skipped: true,
          },
          { answer: null, questionText: 'Empty' },
        ],
      },
    ];

    expect(buildSettledContext(settledPages)).toEqual([
      { questionId: 'name', questionText: 'Name', answer: 'User edit' },
    ]);
  });

  it('keeps generated and edited answers pending until commit', () => {
    const report = createGenerationReport(
      'cycle-1',
      validateGenerationResponse(validResponse(), form, 'cycle-1')
    );
    const pending = createPendingPageStateFromReport(form, report);
    const edited = editPendingAnswer(pending, 'name', 'Edited before Next');

    expect(buildSettledContext([])).toEqual([]);
    const committed = commitPendingPageAfterSuccessfulTransition(edited, {
      nextAcceptedAndTransitioned: true,
    });
    expect(buildSettledContext([committed])).toContainEqual({
      questionId: 'name',
      questionText: 'Question name',
      answer: 'Edited before Next',
    });
    expect(abandonPendingPage()).toBeNull();
    expect(restartPendingPage()).toBeNull();
  });
});

describe('Generation cycles and reports', () => {
  it.each([
    [['name', 'language', 'topics'], ['name', 'language', 'topics']],
    [['name', 'language'], ['name', 'language']],
    [['name', 'language'], ['name']],
    [['name', 'language'], ['language']],
    [['name', 'language', 'topics'], []],
  ])(
    'partitions Override selection independently for %j selected IDs',
    (selectedIds, validIds) => {
      const filledPage = {
        ...page,
        form: {
          ...form,
          questions: form.questions.map((question) => ({
            ...question,
            existingInput: {
              value: selectedIds.includes(question.id as string) &&
                (validIds as string[]).includes(question.id as string)
                ? 'Existing'
                : null,
              hasValue:
                selectedIds.includes(question.id as string) &&
                (validIds as string[]).includes(question.id as string),
            },
          })),
        },
      };
      expect(
        validOverrideQuestionIds(
          filledPage,
          createOverrideFilledIntent(selectedIds)
        )
      ).toEqual(validIds);
    }
  );

  it('validates an exact non-empty override selection', () => {
    const filledPage = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) => ({
          ...question,
          existingInput: { value: 'Existing', hasValue: true },
        })),
      },
    };
    const intent = createOverrideFilledIntent(['name', 'topics']);

    expect(validateOverrideSelection(filledPage, intent)).toEqual({
      valid: true,
      invalidQuestionIds: [],
    });
  });

  it('rejects every invalid override ID without shrinking the selection', () => {
    const cases = [
      ['disappeared', (question: Question) => question],
      ['unsupported', (question: Question) => ({ ...question, supported: false })],
      ['invalid identity', (question: Question) => ({ ...question, id: '' })],
      ['invalid text', (question: Question) => ({ ...question, text: '' })],
      ['invalid type', (question: Question) => ({ ...question, type: null })],
      ['unanswered', (question: Question) => ({
        ...question,
        existingInput: { value: null, hasValue: false },
      })],
    ] as const;

    for (const [label, update] of cases) {
      const questionId = label === 'disappeared' ? 'disappeared' : 'name';
      const questions =
        label === 'disappeared'
          ? form.questions
          : form.questions.map((question) =>
              question.id === 'name' ? update(question) : question
            );
      const result = validateOverrideSelection(
        { ...page, form: { ...form, questions } },
        createOverrideFilledIntent(['name', questionId])
      );

      expect(result.valid, label).toBe(false);
      expect(result.invalidQuestionIds).toContain(questionId);
    }
  });

  it('rejects an empty override before candidate selection', () => {
    expect(
      validateOverrideSelection(page, createOverrideFilledIntent([]))
    ).toEqual({ valid: false, invalidQuestionIds: ['<empty-selection>'] });
  });

  it('excludes questions with existing current answers from candidates', () => {
    const existing = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) =>
          question.id === 'name'
            ? {
                ...question,
                existingInput: { value: 'Existing', hasValue: true },
              }
            : question
        ),
      },
    };

    expect(selectGenerationCandidates(existing).map((question) => question.id)).toEqual([
      'language',
      'topics',
    ]);
  });

  it('selects only selected filled questions for override generation', () => {
    const overridePage = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) => ({
          ...question,
          existingInput:
            question.id === 'name' || question.id === 'topics'
              ? { value: `Existing ${question.id}`, hasValue: true }
              : question.existingInput,
        })),
      },
    };

    const intent = createOverrideFilledIntent(['topics', 'name']);

    expect(Object.isFrozen(intent.selectedQuestionIds)).toBe(true);
    expect(selectGenerationCandidates(overridePage, intent).map((question) => question.id)).toEqual([
      'name',
      'topics',
    ]);
  });

  it('excludes unsupported selected questions from override candidates', () => {
    const unsupportedFilled = {
      ...form.questions[1],
      id: 'unsupported',
      existingInput: { value: 'Filled', hasValue: true },
      supported: false,
      unsupportedReason: 'Unsupported control',
    };
    const overridePage = {
      ...page,
      form: { ...form, questions: [form.questions[0], unsupportedFilled] },
    };

    expect(
      selectGenerationCandidates(
        overridePage,
        createOverrideFilledIntent(['unsupported'])
      )
    ).toEqual([]);
  });

  it('excludes unanswered and unselected questions from override candidates', () => {
    const overridePage = {
      ...page,
      form: {
        ...form,
        questions: [
          { ...form.questions[0], existingInput: { value: 'Filled', hasValue: true } },
          { ...form.questions[1], existingInput: { value: null, hasValue: false } },
          { ...form.questions[2], existingInput: { value: 'Filled', hasValue: true } },
        ],
      },
    };

    expect(
      selectGenerationCandidates(
        overridePage,
        createOverrideFilledIntent(['language', 'topics'])
      ).map((question) => question.id)
    ).toEqual(['topics']);
  });

  it('does not fall back to unanswered candidates for an empty override', async () => {
    const generator: GenerationInterface = { generate: vi.fn() };
    const coordinator = new GenerationCoordinator(() => 'cycle-empty-override');

    await expect(
      coordinator.generate(
        page,
        [],
        generator,
        undefined,
        createOverrideFilledIntent(['name'])
      )
    ).resolves.toMatchObject({ status: 'complete', results: [] });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('keeps previous answer values out of override generation requests', async () => {
    const filledPage = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) =>
          question.id === 'name'
            ? { ...question, existingInput: { value: 'Private answer', hasValue: true } }
            : question
        ),
      },
    };
    const generator: GenerationInterface = {
      generate: vi.fn(async (request) => ({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: { questionId: question.questionId, value: 'Replacement' },
        })),
      })),
    };
    const coordinator = new GenerationCoordinator(() => 'cycle-privacy');

    await coordinator.generate(
      filledPage,
      [],
      generator,
      undefined,
      createOverrideFilledIntent(['name'])
    );

    expect(generator.generate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        intent: expect.anything(),
        selectedQuestionIds: expect.anything(),
        previousAnswer: expect.anything(),
      })
    );
    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ questionId: 'name' })],
      })
    );
    expect(
      JSON.stringify(
        (generator.generate as ReturnType<typeof vi.fn>).mock.calls[0][0]
      )
    ).not.toContain('Private answer');
  });

  it('completes locally without invoking the generator when all questions are filled', async () => {
    const filledPage = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) => ({
          ...question,
          existingInput: { value: 'Existing', hasValue: true },
        })),
      },
    };
    const generator: GenerationInterface = { generate: vi.fn() };
    const coordinator = new GenerationCoordinator(() => 'cycle-filled');

    await expect(
      coordinator.generate(filledPage, [], generator)
    ).resolves.toMatchObject({ status: 'complete', results: [] });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('keeps sequential regeneration local when all questions remain filled', async () => {
    const filledPage = {
      ...page,
      form: {
        ...form,
        questions: form.questions.map((question) => ({
          ...question,
          existingInput: { value: 'Existing', hasValue: true },
        })),
      },
    };
    const generator: GenerationInterface = { generate: vi.fn() };
    const coordinator = new GenerationCoordinator(() => crypto.randomUUID());

    await coordinator.generate(filledPage, [], generator);
    await coordinator.generate(filledPage, [], generator);

    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('sends only unanswered questions for a mixed page', async () => {
    const mixedPage = {
      ...page,
      form: {
        ...form,
        questions: [
          { ...form.questions[0], existingInput: { value: 'Filled', hasValue: true } },
          { ...form.questions[1], existingInput: { value: null, hasValue: false } },
          { ...form.questions[2], existingInput: { value: 'Selected', hasValue: true } },
        ],
      },
    };
    const generator: GenerationInterface = {
      generate: vi.fn(async (request) => ({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: { questionId: question.questionId, value: 'Answer' },
        })),
      })),
    };
    const coordinator = new GenerationCoordinator(() => 'cycle-mixed');

    await coordinator.generate(mixedPage, [], generator);

    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ questionId: 'language' })],
      })
    );
  });

  it('validates responses against candidates rather than the whole form', () => {
    const candidates = [form.questions[1]];
    const response: GenerationResponse = {
      cycleId: 'cycle-1',
      results: [
        {
          questionId: 'language',
          status: 'GENERATED',
          answer: { questionId: 'language', value: 'TypeScript' },
        },
      ],
    };

    expect(validateGenerationResponse(response, form, 'cycle-1', candidates)).toHaveLength(1);
  });

  it('creates a new cycle for each attempt and ignores stale responses', async () => {
    const resolvers: Array<(response: GenerationResponse) => void> = [];
    const generator: GenerationInterface = {
      generate: vi.fn<
        (request: GenerationRequest) => Promise<GenerationResponse>
      >((_request) => new Promise((resolve) => resolvers.push(resolve))),
    };
    const coordinator = new GenerationCoordinator(
      (() => {
        let count = 0;
        return () => `cycle-${++count}`;
      })()
    );

    const firstAttempt = coordinator.generate(page, [], generator);
    const secondAttempt = coordinator.generate(page, [], generator);
    expect(
      (generator.generate as ReturnType<typeof vi.fn>).mock.calls.map(
        ([request]) => request.cycleId
      )
    ).toEqual(['cycle-1', 'cycle-2']);

    resolvers[0](validResponse('cycle-1'));
    resolvers[1](validResponse('cycle-2'));
    await expect(firstAttempt).resolves.toBeNull();
    await expect(secondAttempt).resolves.toMatchObject({ cycleId: 'cycle-2' });
  });

  it('materializes an exhaustive frozen report without DOM references', () => {
    const report = createGenerationReport(
      'cycle-1',
      validateGenerationResponse(validResponse(), form, 'cycle-1')
    );

    expect(report.results).toHaveLength(3);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.results)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('HTMLElement');
  });
});
