import { describe, expect, it, vi } from 'vitest';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';
import { buildSettledContext, type SettledPageState } from '../src/Generation/Context';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { createGenerationReport } from '../src/Generation/Report';
import {
  abandonPendingPage,
  commitPendingPageAfterSuccessfulTransition,
  createPendingPageStateFromReport,
  editPendingAnswer,
  restartPendingPage,
} from '../src/Generation/Pending';
import type { GenerationInterface, GenerationRequest, GenerationResponse } from '../src/Generation/Contract';
import {
  GenerationResponseValidationError,
  validateGenerationResponse,
} from '../src/Generation/Validation';

function createQuestion(
  id: string,
  type: Question['type'],
  options: string[] = [],
  required = false,
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
    const results = validateGenerationResponse(validResponse(), form, 'cycle-1');

    expect(results.map((result) => result.status)).toEqual([
      'GENERATED',
      'GENERATED',
      'GENERATED',
    ]);
    expect(results[0].answer?.value).toBe('Ada');
  });

  it('rejects malformed, stale, duplicate, and non-exhaustive responses', () => {
    expect(() => validateGenerationResponse(null, form, 'cycle-1')).toThrow(
      GenerationResponseValidationError,
    );
    expect(() => validateGenerationResponse({ ...validResponse(), cycleId: '' }, form, 'cycle-1')).toThrow();
    expect(() => validateGenerationResponse({ ...validResponse(), cycleId: 'cycle-2' }, form, 'cycle-1')).toThrow();
    expect(() => validateGenerationResponse({
      ...validResponse(),
      results: [...validResponse().results, validResponse().results[0]],
    }, form, 'cycle-1')).toThrow();
    expect(() => validateGenerationResponse({
      ...validResponse(),
      results: validResponse().results.slice(0, 2),
    }, form, 'cycle-1')).toThrow();
    expect(() => validateGenerationResponse({
      ...validResponse(),
      results: validResponse().results.map((result) =>
        result.questionId === 'name' ? { ...result, questionId: 'question-text-match' } : result,
      ),
    }, form, 'cycle-1')).toThrow();
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
      failure: { code: 'BACKEND_ERROR', message: 'Unavailable' },
    };

    expect(validateGenerationResponse(response, form, 'cycle-1')[2]).toMatchObject({
      status: 'GENERATION_FAILED',
      reason: 'Unavailable',
    });
  });
});

describe('Settled context and pending page state', () => {
  it('includes settled user edits and excludes skipped or unanswered items', () => {
    const settledPages: SettledPageState[] = [{
      pageId: 'page-1',
      answers: [
        { answer: { questionId: 'name', value: 'User edit' }, questionText: 'Name' },
        { answer: { questionId: 'skipped', value: 'ignored' }, questionText: 'Optional', skipped: true },
        { answer: null, questionText: 'Empty' },
      ],
    }];

    expect(buildSettledContext(settledPages)).toEqual([
      { questionId: 'name', questionText: 'Name', answer: 'User edit' },
    ]);
  });

  it('keeps generated and edited answers pending until commit', () => {
    const report = createGenerationReport(
      'cycle-1',
      validateGenerationResponse(validResponse(), form, 'cycle-1'),
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
  it('creates a new cycle for each attempt and ignores stale responses', async () => {
    const resolvers: Array<(response: GenerationResponse) => void> = [];
    const generator: GenerationInterface = {
      generate: vi.fn<(request: GenerationRequest) => Promise<GenerationResponse>>((_request) => new Promise((resolve) => resolvers.push(resolve))),
    };
    const coordinator = new GenerationCoordinator(
      (() => {
        let count = 0;
        return () => `cycle-${++count}`;
      })(),
    );

    const firstAttempt = coordinator.generate(page, [], generator);
    const secondAttempt = coordinator.generate(page, [], generator);
    expect((generator.generate as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.cycleId)).toEqual([
      'cycle-1',
      'cycle-2',
    ]);

    resolvers[0](validResponse('cycle-1'));
    resolvers[1](validResponse('cycle-2'));
    await expect(firstAttempt).resolves.toBeNull();
    await expect(secondAttempt).resolves.toMatchObject({ cycleId: 'cycle-2' });
  });

  it('materializes an exhaustive frozen report without DOM references', () => {
    const report = createGenerationReport(
      'cycle-1',
      validateGenerationResponse(validResponse(), form, 'cycle-1'),
    );

    expect(report.results).toHaveLength(3);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.results)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('HTMLElement');
  });
});
