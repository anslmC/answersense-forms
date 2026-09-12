import { describe, expect, it, vi } from 'vitest';
import type {
  Form,
  NormalizedActivePage,
  Question,
  SupportedQuestionType,
} from '../src/Models/Logical';
import { createFinalizedPageHandoff } from '../src/Fill/Handoff';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { PageLifecycle } from '../src/Lifecycle/PageLifecycle';
import {
  beginNextNavigation,
  confirmPageTransition,
} from '../src/Lifecycle/Transition';
import {
  computePageFingerprint,
  normalizeDiscoveredActivePage,
} from '../src/Forms/Normalization';

function question(id: string): Question {
  return {
    id,
    text: id,
    type: 'short-text',
    required: false,
    options: [],
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
  };
}

const form: Form = {
  formId: 'form-1',
  activePageId: 'page-1',
  questions: [question('name')],
};

const page: NormalizedActivePage = {
  form,
  questionResults: [
    { questionId: 'name', status: 'ready', answer: null, reason: null },
  ],
  processingCycle: { cycleId: 'cycle-1' },
};

function createDocument(activePage = 'page-1'): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><main>
    <section data-page-id="page-1" data-answersense-active-page="${activePage === 'page-1'}">
      <div role="listitem" data-question-id="name" data-question-text="name" data-question-type="short-text">
        <input type="text" value="">
      </div>
    </section>
    <section data-page-id="page-2" data-answersense-active-page="${activePage === 'page-2'}">
      <div role="listitem" data-question-id="next" data-question-text="next" data-question-type="short-text">
        <input type="text" value="">
      </div>
    </section>
  </main>`,
    'text/html'
  );
}

function createLifecycle() {
  let count = 1;
  const coordinator = new GenerationCoordinator(() => `cycle-${++count}`);
  return new PageLifecycle(page, coordinator);
}

function createControlLifecycle(type: SupportedQuestionType) {
  const labels =
    type === 'single-choice' || type === 'multiple-choice'
      ? ['Alpha', 'Beta']
      : [];
  const initialQuestion: Question = {
    ...question('answer'),
    type,
    options: labels.map((label) => ({ label, selected: false })),
  };
  const initialPage: NormalizedActivePage = {
    form: { ...form, questions: [initialQuestion] },
    questionResults: [
      { questionId: 'answer', status: 'ready', answer: null, reason: null },
    ],
    processingCycle: { cycleId: 'cycle-1' },
  };
  const discoveredQuestion = {
    kind: 'supported' as const,
    id: 'answer',
    text: 'answer',
    type,
    required: false,
    options: labels.map((label) => ({ label, selected: false })),
    existingValue: null as string | string[] | null,
  };
  const coordinator = new GenerationCoordinator(() => 'cycle-next');
  return {
    lifecycle: new PageLifecycle(initialPage, coordinator),
    coordinator,
    discovered: {
      pageId: 'page-1',
      formId: 'form-1',
      questions: [discoveredQuestion],
    },
  };
}

function synchronizeAnswer(
  type: SupportedQuestionType,
  value: string | string[]
) {
  const { lifecycle, discovered } = createControlLifecycle(type);
  const selected = new Set(Array.isArray(value) ? value : [value]);
  const refreshed = {
    ...discovered,
    questions: discovered.questions.map((current) => ({
      ...current,
      existingValue: value,
      options: current.options.map((option) => ({
        ...option,
        selected: selected.has(option.label),
      })),
    })),
  };
  const cycleId = lifecycle.currentCycle.cycleId;
  const result = lifecycle.synchronizeCurrentPage(refreshed);
  return { lifecycle, cycleId, result };
}

function createHandoff(document: Document, value = 'Ada', cycleId = 'cycle-1') {
  const report = {
    cycleId,
    pageId: 'page-1',
    outcomes: [
      {
        questionId: 'name',
        status: 'FILLED' as const,
        answer: { questionId: 'name', value },
        reason: null,
        code: null,
      },
    ],
  };
  return createFinalizedPageHandoff(document, form, report);
}

function discoveredPage(
  pageId: string,
  first: number,
  last: number,
  questionId: string
) {
  return {
    pageId,
    formId: 'form-1',
    pageEntryRange: { first, last },
    questions: [
      {
        kind: 'supported' as const,
        id: questionId,
        text: questionId,
        type: 'short-text' as const,
        required: false,
        options: [],
        existingValue: null,
      },
    ],
  };
}

describe('P5 finalized handoff and transition boundary', () => {
  it('snapshots a user-corrected current DOM value before pending state', () => {
    const document = createDocument();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'Corrected by user';
    const handoff = createHandoff(document);

    expect(handoff.entries[0].answer).toEqual({
      questionId: 'name',
      value: 'Corrected by user',
    });
  });

  it('includes a corrected value after a failed fill and excludes partial fill by default', () => {
    const document = createDocument();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'Corrected after failure';
    const handoff = createFinalizedPageHandoff(document, form, {
      cycleId: 'cycle-1',
      outcomes: [
        {
          questionId: 'name',
          status: 'FILL_FAILED',
          answer: null,
          reason: 'Initial target failure',
          code: 'TARGET_NOT_FOUND',
        },
      ],
    });
    expect(handoff.entries[0].answer?.value).toBe('Corrected after failure');

    const partial = createFinalizedPageHandoff(document, form, {
      cycleId: 'cycle-1',
      outcomes: [
        {
          questionId: 'name',
          status: 'PARTIAL_FILL',
          answer: null,
          reason: 'Partial',
          code: 'INVALID_OPTION',
        },
      ],
    });
    expect(partial.entries[0].answer).toBeNull();
  });

  it('does not confirm a transition when only Next intent exists', () => {
    const document = createDocument();
    expect(
      confirmPageTransition(document, beginNextNavigation('page-1'))
    ).toBeNull();
  });

  it('confirms only when the active page identity changes', () => {
    const document = createDocument('page-2');
    expect(
      confirmPageTransition(document, beginNextNavigation('page-1'))?.pageId
    ).toBe('page-2');
  });
});

describe('P5 page lifecycle', () => {
  it('resynchronizes the active page IDs while preserving settled context', () => {
    const lifecycle = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value = 'Ada';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', lifecycle.currentCycle.cycleId)
    );
    lifecycle.beginNext(document);
    lifecycle.confirmTransition(createDocument('page-2'));

    const refreshed = lifecycle.resynchronizeCurrentPage(
      discoveredPage('page-2', 3, 6, 'current')
    );

    expect(refreshed.form.activePageId).toBe('page-2');
    expect(refreshed.form.questions.map((candidate) => candidate.id)).toEqual([
      'current',
    ]);
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Ada' },
    ]);
    expect(lifecycle.pendingPage).toBeNull();
    expect(lifecycle.currentCycle.cycleId).not.toBe('cycle-1');
  });

  it('replaces stale page identity and question IDs from current discovery', () => {
    const lifecycle = createLifecycle();

    lifecycle.resynchronizeCurrentPage(
      discoveredPage('page-2-current', 3, 6, 'current')
    );

    expect(lifecycle.currentPage.form).toMatchObject({
      activePageId: 'page-2-current',
      formId: 'form-1',
    });
    expect(lifecycle.currentPage.form.questions.map((candidate) => candidate.id)).toEqual([
      'current',
    ]);
  });

  it('keeps current identity when synchronized and replaces same-page changed identity', () => {
    const lifecycle = createLifecycle();
    const samePage = discoveredPage('page-1', 0, 3, 'name');
    expect(lifecycle.synchronizeCurrentPage(samePage)).toBe('unchanged');
    const cycleBeforeChange = lifecycle.currentCycle.cycleId;

    expect(lifecycle.synchronizeCurrentPage(
      discoveredPage('page-1', 0, 3, 'changed-question')
    )).toBe('resynchronized');
    expect(lifecycle.currentPage.form.questions[0]?.id).toBe(
      'changed-question'
    );
    expect(lifecycle.currentCycle.cycleId).not.toBe(cycleBeforeChange);
  });

  it('refreshes short-answer state on an unchanged page', () => {
    const { lifecycle, cycleId, result } = synchronizeAnswer(
      'short-text',
      'Ada'
    );

    expect(result).toBe('unchanged');
    expect(lifecycle.currentCycle.cycleId).toBe(cycleId);
    expect(lifecycle.currentPage.form.activePageId).toBe('page-1');
    expect(lifecycle.currentPage.form.questions[0].existingInput).toEqual({
      value: 'Ada',
      hasValue: true,
    });
  });

  it('refreshes paragraph state on an unchanged page', () => {
    const { lifecycle, result } = synchronizeAnswer('paragraph', 'Details');

    expect(result).toBe('unchanged');
    expect(lifecycle.currentPage.form.questions[0].existingInput).toEqual({
      value: 'Details',
      hasValue: true,
    });
  });

  it('refreshes multiple-choice state on an unchanged page', () => {
    const { lifecycle, result } = synchronizeAnswer('single-choice', 'Beta');

    expect(result).toBe('unchanged');
    expect(lifecycle.currentPage.form.questions[0].existingInput).toEqual({
      value: 'Beta',
      hasValue: true,
    });
    expect(lifecycle.currentPage.form.questions[0].options[1].selected).toBe(
      true
    );
  });

  it('refreshes checkbox state on an unchanged page', () => {
    const { lifecycle, result } = synchronizeAnswer(
      'multiple-choice',
      ['Alpha', 'Beta']
    );

    expect(result).toBe('unchanged');
    expect(lifecycle.currentPage.form.questions[0].existingInput).toEqual({
      value: ['Alpha', 'Beta'],
      hasValue: true,
    });
    expect(
      lifecycle.currentPage.form.questions[0].options.every(
        (option) => option.selected
      )
    ).toBe(true);
  });

  it('excludes refreshed answers from all-filled Regenerate', async () => {
    const { lifecycle, coordinator, discovered } = createControlLifecycle(
      'short-text'
    );
    const refreshed = {
      ...discovered,
      questions: [{ ...discovered.questions[0], existingValue: 'Filled' }],
    };
    expect(lifecycle.synchronizeCurrentPage(refreshed)).toBe('unchanged');
    const generator: GenerationInterface = { generate: vi.fn() };

    const report = await coordinator.generate(
      lifecycle.currentPage,
      lifecycle.settledPageStates,
      generator,
      lifecycle.currentCycle
    );

    expect(report?.results).toEqual([]);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('sends only unanswered questions after mixed-page refresh', async () => {
    const initialQuestions = ['answered', 'unanswered', 'also-answered'].map(
      (id) => question(id)
    );
    const coordinator = new GenerationCoordinator(() => 'cycle-mixed');
    const lifecycle = new PageLifecycle(
      {
        form: { ...form, questions: initialQuestions },
        questionResults: initialQuestions.map((current) => ({
          questionId: current.id,
          status: 'ready' as const,
          answer: null,
          reason: null,
        })),
        processingCycle: { cycleId: 'cycle-1' },
      },
      coordinator
    );
    const discovered = {
      pageId: 'page-1',
      formId: 'form-1',
      questions: initialQuestions.map((current) => ({
        kind: 'supported' as const,
        id: current.id,
        text: current.text!,
        type: 'short-text' as const,
        required: false,
        options: [],
        existingValue: current.id === 'unanswered' ? null : current.id,
      })),
    };
    expect(lifecycle.synchronizeCurrentPage(discovered)).toBe('unchanged');
    const generator: GenerationInterface = {
      generate: vi.fn(async (request) => ({
        cycleId: request.cycleId,
        results: [{
          questionId: 'unanswered',
          status: 'GENERATED' as const,
          answer: { questionId: 'unanswered', value: 'Generated' },
        }],
      })),
    };

    await coordinator.generate(
      lifecycle.currentPage,
      lifecycle.settledPageStates,
      generator,
      lifecycle.currentCycle
    );

    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ questionId: 'unanswered' })],
      })
    );
  });

  it('rejects generation admission while Next is pending on the outgoing page', () => {
    const lifecycle = createLifecycle();
    const outgoingDocument = createDocument();
    lifecycle.beginNext(outgoingDocument);

    expect(lifecycle.synchronizeCurrentPage(
      discoveredPage('page-1', 0, 3, 'name')
    )).toBe('pending');
    expect(lifecycle.currentPage.form.activePageId).toBe('page-1');
  });

  it('leaves the current page unchanged when synchronization cannot normalize input', () => {
    const lifecycle = createLifecycle();
    const before = lifecycle.currentPage;

    expect(() => lifecycle.resynchronizeCurrentPage(null as never)).toThrow();
    expect(lifecycle.currentPage).toBe(before);
  });

  it('force clears every settled page and cycle, including a revisited Page 3', () => {
    const generation = new GenerationCoordinator(() => 'cycle-reset');
    const pageThree = {
      ...page,
      form: { ...form, activePageId: 'page-3' },
      processingCycle: { cycleId: 'cycle-3' },
      questionResults: [
        {
          questionId: 'name',
          status: 'GENERATED' as const,
          answer: { questionId: 'name', value: 'stale answer' },
          reason: null,
        },
      ],
    };
    const lifecycle = new PageLifecycle(pageThree, generation, {
      activePage: pageThree,
      activeCycle: { cycleId: 'cycle-3' },
      pending: null,
      settledPages: [
        {
          pageId: 'page-1',
          pageFingerprint: 'page-1-fingerprint',
          answers: [],
        },
        {
          pageId: 'page-2',
          pageFingerprint: 'page-2-fingerprint',
          answers: [],
        },
        {
          pageId: 'page-3',
          pageFingerprint: 'page-3-fingerprint',
          answers: [],
        },
      ],
      visits: [
        { pageId: 'page-1', cycleId: 'cycle-1', status: 'settled' },
        { pageId: 'page-2', cycleId: 'cycle-2', status: 'abandoned' },
        { pageId: 'page-3', cycleId: 'cycle-3', status: 'active' },
      ],
      navigation: null,
    });

    lifecycle.forceClear();

    expect(lifecycle.context).toEqual([]);
    expect(lifecycle.settledPageStates).toEqual([]);
    expect(lifecycle.currentRevisitStatus).toBe('NEW');
    expect(lifecycle.currentPage.questionResults[0]).toMatchObject({
      status: 'ready',
      answer: null,
    });
    expect(lifecycle.pageVisits).toEqual([
      {
        pageId: 'page-3',
        cycleId: 'cycle-reset',
        status: 'active',
      },
    ]);
    expect(lifecycle.currentCycle.cycleId).toBe('cycle-reset');
  });

  it('keeps pending and context unchanged after rejected Next, then settles after change', () => {
    const lifecycle = createLifecycle();
    const document = createDocument();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'Final answer';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', lifecycle.currentCycle.cycleId)
    );
    lifecycle.beginNext(document);

    expect(lifecycle.confirmTransition(document)).toBeNull();
    expect(lifecycle.pendingPage).not.toBeNull();
    expect(lifecycle.context).toEqual([]);

    const nextDocument = createDocument('page-2');
    const nextPage = lifecycle.confirmTransition(nextDocument);
    expect(nextPage?.form.activePageId).toBe('page-2');
    expect(lifecycle.currentRevisitStatus).toBe('NEW');
    expect(lifecycle.pendingPage).toBeNull();
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Final answer' },
    ]);
  });

  it('uses the live DOM answer from the old page at successful settlement time', () => {
    const lifecycle = createLifecycle();
    const oldDocument = createDocument();
    const oldInput = oldDocument.querySelector('input') as HTMLInputElement;
    oldInput.value = 'Generated value';

    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        oldDocument,
        'Generated value',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(oldDocument);
    oldInput.value = 'Edited by user';

    const nextDocument = createDocument('page-2');
    const nextPage = lifecycle.confirmTransition(nextDocument);

    expect(nextPage?.form.activePageId).toBe('page-2');
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Edited by user' },
    ]);
  });

  it('classifies revisit state by pageId and fingerprint without reusing pending state', () => {
    const lifecycle = createLifecycle();
    const document = createDocument();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'Stable answer';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(document, 'Stable answer', lifecycle.currentCycle.cycleId)
    );
    lifecycle.beginNext(document);
    lifecycle.confirmTransition(createDocument('page-2'));

    const samePage = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'name',
            text: 'name',
            type: 'short-text',
            required: false,
            options: [],
            existingValue: null,
          },
        ],
      },
      'cycle-next'
    );
    expect(lifecycle.classifyPageRevisit(samePage)).toBe('UNCHANGED_REVISIT');

    const changed = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'name',
            text: 'renamed',
            type: 'short-text',
            required: true,
            options: [],
            existingValue: null,
          },
        ],
      },
      'cycle-next'
    );
    expect(lifecycle.classifyPageRevisit(changed)).toBe('CHANGED_REVISIT');

    const newPage = normalizeDiscoveredActivePage(
      {
        pageId: 'page-3',
        questions: [
          {
            kind: 'supported',
            id: 'new-question',
            text: 'new question',
            type: 'short-text',
            required: false,
            options: [],
            existingValue: null,
          },
        ],
      },
      'cycle-next'
    );
    expect(lifecycle.classifyPageRevisit(newPage)).toBe('NEW');
  });

  it('classifies actual Previous/Back transitions and prevents pending reuse', () => {
    const lifecycle = createLifecycle();
    const oldDocument = createDocument();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        oldDocument,
        'Settled answer',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(oldDocument);
    lifecycle.confirmTransition(createDocument('page-2'));

    const revisited = lifecycle.handlePreviousOrBack(createDocument('page-1'));

    expect(revisited?.form.activePageId).toBe('page-1');
    expect(lifecycle.currentRevisitStatus).toBe('UNCHANGED_REVISIT');
    expect(lifecycle.pendingPage).toBeNull();
  });

  it('classifies a changed actual revisit for reprocessing', () => {
    const lifecycle = createLifecycle();
    const oldDocument = createDocument();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        oldDocument,
        'Settled answer',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(oldDocument);
    lifecycle.confirmTransition(createDocument('page-2'));

    const changedPage = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'name',
            text: 'Changed question',
            type: 'short-text',
            required: false,
            options: [],
            existingValue: null,
          },
        ],
      },
      'cycle-changed'
    );
    const changedDocument = createDocument('page-1');
    changedDocument
      .querySelector('[data-question-id="name"]')
      ?.setAttribute(
        'data-question-text',
        changedPage.form.questions[0].text ?? ''
      );
    const revisited = lifecycle.handlePreviousOrBack(changedDocument);

    expect(revisited?.form.activePageId).toBe('page-1');
    expect(lifecycle.currentRevisitStatus).toBe('CHANGED_REVISIT');
    expect(lifecycle.pendingPage).toBeNull();
  });

  it('replaces changed settled state without duplicating or regenerating downstream state', () => {
    const lifecycle = createLifecycle();
    const pageOneDocument = createDocument('page-1');
    (pageOneDocument.querySelector('input') as HTMLInputElement).value =
      'Original answer';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        pageOneDocument,
        'Original answer',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(pageOneDocument);
    lifecycle.confirmTransition(createDocument('page-2'));

    const pageTwoDocument = createDocument('page-2');
    (
      pageTwoDocument.querySelector(
        '[data-page-id="page-2"] input'
      ) as HTMLInputElement
    ).value = 'Downstream answer';
    lifecycle.acceptFinalizedHandoff(
      createFinalizedPageHandoff(pageTwoDocument, lifecycle.currentPage.form, {
        cycleId: lifecycle.currentCycle.cycleId,
        outcomes: [
          {
            questionId: 'next',
            status: 'FILLED',
            answer: { questionId: 'next', value: 'Downstream answer' },
            reason: null,
            code: null,
          },
        ],
      })
    );
    lifecycle.beginNext(pageTwoDocument);
    lifecycle.confirmTransition(createDocument('page-1'));
    expect(
      lifecycle.settledPageStates.map((settled) => settled.pageId)
    ).toEqual(['page-1', 'page-2']);
    expect(lifecycle.context).toContainEqual({
      questionId: 'next',
      questionText: 'next',
      answer: 'Downstream answer',
    });

    lifecycle.handlePreviousOrBack(createDocument('page-2'));
    const changedPageDocument = createDocument('page-1');
    (changedPageDocument.querySelector('input') as HTMLInputElement).value =
      'Revised answer';
    changedPageDocument
      .querySelector('[data-question-id="name"]')
      ?.setAttribute('data-question-text', 'Changed question');
    lifecycle.handlePreviousOrBack(changedPageDocument);
    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        changedPageDocument,
        'Revised answer',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(changedPageDocument);
    lifecycle.confirmTransition(createDocument('page-2'));

    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Revised answer' },
      { questionId: 'next', questionText: 'next', answer: 'Downstream answer' },
    ]);
    expect(lifecycle.settledPageStates).toHaveLength(2);
    expect(
      lifecycle.settledPageStates.map((settled) => settled.pageId)
    ).toEqual(['page-1', 'page-2']);
  });

  it('fingerprints normalized page content and order without including user answers', () => {
    const base = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'q1',
            text: 'What is your name?',
            type: 'short-text',
            required: true,
            options: [],
            existingValue: 'Ada',
          },
          {
            kind: 'supported',
            id: 'q2',
            text: 'Which language?',
            type: 'single-choice',
            required: false,
            options: [
              { label: 'TypeScript', selected: true },
              { label: 'JavaScript', selected: false },
            ],
            existingValue: 'TypeScript',
          },
        ],
      },
      'cycle-1'
    );
    const sameValueDifferentAnswer = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'q1',
            text: 'What is your name?',
            type: 'short-text',
            required: true,
            options: [],
            existingValue: 'Grace',
          },
          {
            kind: 'supported',
            id: 'q2',
            text: 'Which language?',
            type: 'single-choice',
            required: false,
            options: [
              { label: 'TypeScript', selected: true },
              { label: 'JavaScript', selected: false },
            ],
            existingValue: 'TypeScript',
          },
        ],
      },
      'cycle-1'
    );
    const reordered = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'q2',
            text: 'Which language?',
            type: 'single-choice',
            required: false,
            options: [
              { label: 'TypeScript', selected: true },
              { label: 'JavaScript', selected: false },
            ],
            existingValue: 'TypeScript',
          },
          {
            kind: 'supported',
            id: 'q1',
            text: 'What is your name?',
            type: 'short-text',
            required: true,
            options: [],
            existingValue: 'Ada',
          },
        ],
      },
      'cycle-1'
    );
    const createVariant = (questionOverrides: {
      id?: string;
      text?: string;
      type?: SupportedQuestionType;
      required?: boolean;
      options?: { label: string; selected: boolean }[];
      existingValue?: string | null;
    }) =>
      normalizeDiscoveredActivePage(
        {
          pageId: 'page-1',
          questions: [
            {
              kind: 'supported',
              id: questionOverrides.id ?? 'q1',
              text: questionOverrides.text ?? 'What is your name?',
              type: questionOverrides.type ?? 'short-text',
              required: questionOverrides.required ?? true,
              options: questionOverrides.options ?? [],
              existingValue: questionOverrides.existingValue ?? 'Ada',
            },
          ],
        },
        'cycle-1'
      );
    const selectedChanged = normalizeDiscoveredActivePage(
      {
        pageId: 'page-1',
        questions: [
          {
            kind: 'supported',
            id: 'q1',
            text: 'What is your name?',
            type: 'short-text',
            required: true,
            options: [],
            existingValue: 'Grace',
          },
          {
            kind: 'supported',
            id: 'q2',
            text: 'Which language?',
            type: 'single-choice',
            required: false,
            options: [
              { label: 'TypeScript', selected: false },
              { label: 'JavaScript', selected: true },
            ],
            existingValue: 'JavaScript',
          },
        ],
      },
      'cycle-1'
    );
    const optionChanged = createVariant({
      type: 'single-choice',
      options: [{ label: 'Rust', selected: false }],
      existingValue: 'Rust',
    });

    expect(base.form.pageFingerprint).toBeDefined();
    expect(base.form.pageFingerprint).toBe(
      sameValueDifferentAnswer.form.pageFingerprint
    );
    expect(base.form.pageFingerprint).toBe(
      selectedChanged.form.pageFingerprint
    );
    expect(base.form.pageFingerprint).not.toBe(reordered.form.pageFingerprint);
    expect(base.form.pageFingerprint).not.toBe(
      createVariant({ id: 'different-id' }).form.pageFingerprint
    );
    expect(base.form.pageFingerprint).not.toBe(
      createVariant({ type: 'paragraph' }).form.pageFingerprint
    );
    expect(base.form.pageFingerprint).not.toBe(
      createVariant({ text: 'A different question' }).form.pageFingerprint
    );
    expect(base.form.pageFingerprint).not.toBe(
      createVariant({ required: false }).form.pageFingerprint
    );
    expect(base.form.pageFingerprint).not.toBe(
      optionChanged.form.pageFingerprint
    );
    expect(computePageFingerprint(base.form)).toBe(base.form.pageFingerprint);
    expect(base.form.pageFingerprint).not.toContain('Ada');
    expect(base.form.pageFingerprint).not.toContain('TypeScript');
  });

  it('excludes skipped and failed handoff entries from settled context', () => {
    const lifecycle = createLifecycle();
    lifecycle.acceptFinalizedHandoff({
      cycleId: lifecycle.currentCycle.cycleId,
      pageId: 'page-1',
      entries: [
        {
          questionId: 'name',
          questionText: 'name',
          answer: null,
          outcome: 'SKIPPED',
          reason: 'skip',
          code: null,
        },
        {
          questionId: 'failed',
          questionText: 'failed',
          answer: null,
          outcome: 'FILL_FAILED',
          reason: 'missing',
          code: 'ELEMENT_NOT_FOUND',
        },
      ],
    });
    lifecycle.beginNext();
    expect(
      lifecycle.confirmTransition(createDocument('page-2'))?.form.activePageId
    ).toBe('page-2');
    expect(lifecycle.context).toEqual([]);
  });

  it('abandonment invalidates generation and restart creates a new cycle', () => {
    const lifecycle = createLifecycle();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(createDocument(), 'Ada', lifecycle.currentCycle.cycleId)
    );
    lifecycle.abandon();
    expect(lifecycle.pendingPage).toBeNull();
    expect(lifecycle.context).toEqual([]);
    const restarted = lifecycle.restart();
    expect(restarted.cycleId).not.toBe('cycle-1');
    expect(lifecycle.pendingPage).toBeNull();
  });

  it('creates a new cycle for a user retry and rejects the previous response', async () => {
    let count = 1;
    const coordinator = new GenerationCoordinator(() => `cycle-${++count}`);
    const lifecycle = new PageLifecycle(page, coordinator);
    const firstCycle = lifecycle.currentCycle;
    const resolvers: Array<(response: GenerationResponse) => void> = [];
    const generator: GenerationInterface = {
      generate: vi.fn<(request: GenerationRequest) => Promise<GenerationResponse>>(
        (request) =>
          new Promise<GenerationResponse>((resolve) => {
            void request;
            resolvers.push(resolve);
          })
      ),
    };

    const firstAttempt = coordinator.generate(
      lifecycle.currentPage,
      lifecycle.settledPageStates,
      generator,
      firstCycle
    );
    const secondCycle = lifecycle.retryGeneration();
    const secondAttempt = coordinator.generate(
      lifecycle.currentPage,
      lifecycle.settledPageStates,
      generator,
      secondCycle
    );

    expect(secondCycle.cycleId).not.toBe(firstCycle.cycleId);
    resolvers[0]({
      cycleId: firstCycle.cycleId,
      results: [
        {
          questionId: 'name',
          status: 'GENERATED',
          answer: { questionId: 'name', value: 'Ada' },
        },
      ],
    });
    resolvers[1]({
      cycleId: secondCycle.cycleId,
      results: [
        {
          questionId: 'name',
          status: 'GENERATED',
          answer: { questionId: 'name', value: 'Ada' },
        },
      ],
    });

    await expect(firstAttempt).resolves.toBeNull();
    await expect(secondAttempt).resolves.toMatchObject({
      cycleId: secondCycle.cycleId,
    });
    expect(
      (generator.generate as ReturnType<typeof vi.fn>).mock.calls.map(
        ([request]) => request.cycleId
      )
    ).toEqual([firstCycle.cycleId, secondCycle.cycleId]);
  });

  it('revisiting a page creates a new visit and preserves settled context without duplication', () => {
    const lifecycle = createLifecycle();
    const pageDocument = createDocument();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(pageDocument, 'Ada', lifecycle.currentCycle.cycleId)
    );
    lifecycle.beginNext(pageDocument);
    lifecycle.confirmTransition(createDocument('page-2'));
    const before = lifecycle.context;

    const revisited = lifecycle.handlePreviousOrBack(createDocument('page-1'));
    expect(revisited?.form.activePageId).toBe('page-1');
    expect(lifecycle.context).toEqual(before);
    expect(
      lifecycle.pageVisits.filter((visit) => visit.pageId === 'page-1')
    ).toHaveLength(2);
    expect(lifecycle.pageVisits[2].cycleId).not.toBe(
      lifecycle.pageVisits[0].cycleId
    );

    const revisitedDocument = createDocument('page-1');
    (revisitedDocument.querySelector('input') as HTMLInputElement).value =
      'Revised answer';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(
        revisitedDocument,
        'Revised answer',
        lifecycle.currentCycle.cycleId
      )
    );
    lifecycle.beginNext(revisitedDocument);
    lifecycle.confirmTransition(createDocument('page-2'));
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Revised answer' },
    ]);
  });

  it('rehydrates P5 from a worker snapshot after a document replacement', () => {
    const original = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value =
      'Settled after navigation';
    original.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', original.currentCycle.cycleId)
    );
    original.beginNext(document);
    const snapshot = original.getSnapshot();

    const replacementCoordinator = new GenerationCoordinator(
      () => 'cycle-rehydrated'
    );
    const replacement = new PageLifecycle(
      page,
      replacementCoordinator,
      snapshot
    );
    const nextPage = replacement.confirmTransition(createDocument('page-2'));

    expect(nextPage?.form.activePageId).toBe('page-2');
    expect(replacement.context).toEqual([
      {
        questionId: 'name',
        questionText: 'name',
        answer: 'Settled after navigation',
      },
    ]);
    expect(replacement.currentCycle.cycleId).toBe('cycle-rehydrated');
  });

  it('reconciles a forward document replacement from serialized lifecycle state', () => {
    const original = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value = 'Ada';
    original.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', original.currentCycle.cycleId)
    );
    original.beginNext(document);
    const snapshot = original.getSnapshot('/forms/d/e/form/viewform');
    const next = discoveredPage('entry:3-6', 3, 6, 'next');
    const replacement = new PageLifecycle(
      normalizeDiscoveredActivePage(next),
      new GenerationCoordinator(() => 'cycle-next-document'),
      snapshot
    );

    const active = replacement.reconcileDocument(next, createDocument('page-2'), 'forward');

    expect(active.form.activePageId).toBe('entry:3-6');
    expect(replacement.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Ada' },
    ]);
    expect(replacement.currentCycle.cycleId).toBe('cycle-next-document');
  });

  it('reconciles a Back document replacement as an unchanged revisit', () => {
    const original = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value = 'Ada';
    original.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', original.currentCycle.cycleId)
    );
    original.beginNext(document);
    const next = discoveredPage('entry:3-6', 3, 6, 'next');
    original.reconcileDocument(next, createDocument('page-2'), 'forward');
    const snapshot = original.getSnapshot('/forms/d/e/form/formResponse');
    const previousPage = discoveredPage('page-1', 0, 3, 'name');
    const replacement = new PageLifecycle(
      normalizeDiscoveredActivePage(previousPage),
      new GenerationCoordinator(() => 'cycle-back-document'),
      snapshot
    );

    replacement.reconcileDocument(
      previousPage,
      createDocument(),
      'backward'
    );

    expect(replacement.currentRevisitStatus).toBe('UNCHANGED_REVISIT');
    expect(replacement.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Ada' },
    ]);
    expect(replacement.currentCycle.cycleId).toBe('cycle-back-document');
  });

  it('resets the active page and cycle on a reload document replacement', () => {
    const original = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value = 'Ada';
    original.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', original.currentCycle.cycleId)
    );
    original.beginNext(document);
    const next = discoveredPage('entry:3-6', 3, 6, 'next');
    original.reconcileDocument(next, createDocument('page-2'), 'forward');
    const snapshot = original.getSnapshot('/forms/d/e/form/formResponse');
    const first = discoveredPage('entry:0-3', 0, 3, 'name');
    const replacement = new PageLifecycle(
      normalizeDiscoveredActivePage(first),
      new GenerationCoordinator(() => 'cycle-reloaded'),
      snapshot
    );

    replacement.reconcileDocument(first, createDocument(), 'reload');

    expect(replacement.currentPage.form.activePageId).toBe('entry:0-3');
    expect(replacement.pendingPage).toBeNull();
    expect(replacement.currentCycle.cycleId).toBe('cycle-reloaded');
    expect(replacement.settledPageStates.map((page) => page.pageId)).toEqual([
      'page-1',
    ]);
  });
});

describe('P5 stale cycle protection', () => {
  it('rejects a response after explicit invalidation', async () => {
    let resolveResponse: ((response: GenerationResponse) => void) | undefined;
    const generator: GenerationInterface = {
      generate: vi.fn<
        (request: GenerationRequest) => Promise<GenerationResponse>
      >(
        (_request) =>
          new Promise((resolve) => {
            resolveResponse = resolve;
          })
      ),
    };
    const coordinator = new GenerationCoordinator(() => 'cycle-live');
    const request = coordinator.generate(page, [], generator);
    coordinator.invalidate();
    resolveResponse?.({
      cycleId: 'cycle-live',
      results: [
        {
          questionId: 'name',
          status: 'GENERATED',
          answer: { questionId: 'name', value: 'stale' },
        },
      ],
    });

    await expect(request).resolves.toBeNull();
  });
});
