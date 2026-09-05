import { describe, expect, it, vi } from 'vitest';
import type { Form, NormalizedActivePage, Question } from '../src/Models/Logical';
import { createFinalizedPageHandoff } from '../src/Fill/Handoff';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { PageLifecycle } from '../src/Lifecycle/PageLifecycle';
import { beginNextNavigation, confirmPageTransition } from '../src/Lifecycle/Transition';

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
  questionResults: [{ questionId: 'name', status: 'ready', answer: null, reason: null }],
  processingCycle: { cycleId: 'cycle-1' },
};

function createDocument(activePage = 'page-1'): Document {
  return new DOMParser().parseFromString(`<!doctype html><main>
    <section data-page-id="page-1" data-answersense-active-page="${activePage === 'page-1'}">
      <div role="listitem" data-question-id="name" data-question-type="short-text">
        <input type="text" value="">
      </div>
    </section>
    <section data-page-id="page-2" data-answersense-active-page="${activePage === 'page-2'}">
      <div role="listitem" data-question-id="next" data-question-type="short-text">
        <input type="text" value="">
      </div>
    </section>
  </main>`, 'text/html');
}

function createLifecycle() {
  let count = 1;
  const coordinator = new GenerationCoordinator(() => `cycle-${++count}`);
  return new PageLifecycle(page, coordinator);
}

function createHandoff(document: Document, value = 'Ada', cycleId = 'cycle-1') {
  const report = {
    cycleId,
    pageId: 'page-1',
    outcomes: [{
      questionId: 'name',
      status: 'FILLED' as const,
      answer: { questionId: 'name', value },
      reason: null,
      code: null,
    }],
  };
  return createFinalizedPageHandoff(document, form, report);
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
      outcomes: [{
        questionId: 'name',
        status: 'PARTIAL_FILL',
        answer: null,
        reason: 'Partial',
        code: 'INVALID_OPTION',
      }],
    });
    expect(partial.entries[0].answer).toBeNull();
  });

  it('does not confirm a transition when only Next intent exists', () => {
    const document = createDocument();
    expect(confirmPageTransition(document, beginNextNavigation('page-1'))).toBeNull();
  });

  it('confirms only when the active page identity changes', () => {
    const document = createDocument('page-2');
    expect(confirmPageTransition(document, beginNextNavigation('page-1'))?.pageId).toBe('page-2');
  });
});

describe('P5 page lifecycle', () => {
  it('keeps pending and context unchanged after rejected Next, then settles after change', () => {
    const lifecycle = createLifecycle();
    const document = createDocument();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'Final answer';
    lifecycle.acceptFinalizedHandoff(createHandoff(document, 'Ada', lifecycle.currentCycle.cycleId));
    lifecycle.beginNext();

    expect(lifecycle.confirmTransition(document)).toBeNull();
    expect(lifecycle.pendingPage).not.toBeNull();
    expect(lifecycle.context).toEqual([]);

    const nextDocument = createDocument('page-2');
    const nextPage = lifecycle.confirmTransition(nextDocument);
    expect(nextPage?.form.activePageId).toBe('page-2');
    expect(lifecycle.pendingPage).toBeNull();
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Final answer' },
    ]);
  });

  it('excludes skipped and failed handoff entries from settled context', () => {
    const lifecycle = createLifecycle();
    lifecycle.acceptFinalizedHandoff({
      cycleId: lifecycle.currentCycle.cycleId,
      pageId: 'page-1',
      entries: [
        { questionId: 'name', questionText: 'name', answer: null, outcome: 'SKIPPED', reason: 'skip', code: null },
        { questionId: 'failed', questionText: 'failed', answer: null, outcome: 'FILL_FAILED', reason: 'missing', code: 'ELEMENT_NOT_FOUND' },
      ],
    });
    lifecycle.beginNext();
    expect(lifecycle.confirmTransition(createDocument('page-2'))?.form.activePageId).toBe('page-2');
    expect(lifecycle.context).toEqual([]);
  });

  it('abandonment invalidates generation and restart creates a new cycle', () => {
    const lifecycle = createLifecycle();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(createDocument(), 'Ada', lifecycle.currentCycle.cycleId),
    );
    lifecycle.abandon();
    expect(lifecycle.pendingPage).toBeNull();
    expect(lifecycle.context).toEqual([]);
    const restarted = lifecycle.restart();
    expect(restarted.cycleId).not.toBe('cycle-1');
    expect(lifecycle.pendingPage).toBeNull();
  });

  it('revisiting a page creates a new visit and preserves settled context without duplication', () => {
    const lifecycle = createLifecycle();
    lifecycle.acceptFinalizedHandoff(
      createHandoff(createDocument(), 'Ada', lifecycle.currentCycle.cycleId),
    );
    lifecycle.beginNext();
    lifecycle.confirmTransition(createDocument('page-2'));
    const before = lifecycle.context;

    const revisited = lifecycle.handlePreviousOrBack(createDocument('page-1'));
    expect(revisited?.form.activePageId).toBe('page-1');
    expect(lifecycle.context).toEqual(before);
    expect(lifecycle.pageVisits.filter((visit) => visit.pageId === 'page-1')).toHaveLength(2);
    expect(lifecycle.pageVisits[2].cycleId).not.toBe(lifecycle.pageVisits[0].cycleId);

    const revisitedDocument = createDocument('page-1');
    (revisitedDocument.querySelector('input') as HTMLInputElement).value = 'Revised answer';
    lifecycle.acceptFinalizedHandoff(
      createHandoff(revisitedDocument, 'Revised answer', lifecycle.currentCycle.cycleId),
    );
    lifecycle.beginNext();
    lifecycle.confirmTransition(createDocument('page-2'));
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Revised answer' },
    ]);
  });

  it('rehydrates P5 from a worker snapshot after a document replacement', () => {
    const original = createLifecycle();
    const document = createDocument();
    (document.querySelector('input') as HTMLInputElement).value = 'Settled after navigation';
    original.acceptFinalizedHandoff(
      createHandoff(document, 'Ada', original.currentCycle.cycleId),
    );
    original.beginNext();
    const snapshot = original.getSnapshot();

    const replacementCoordinator = new GenerationCoordinator(() => 'cycle-rehydrated');
    const replacement = new PageLifecycle(
      page,
      replacementCoordinator,
      snapshot,
    );
    const nextPage = replacement.confirmTransition(createDocument('page-2'));

    expect(nextPage?.form.activePageId).toBe('page-2');
    expect(replacement.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Settled after navigation' },
    ]);
    expect(replacement.currentCycle.cycleId).toBe('cycle-rehydrated');
  });
});

describe('P5 stale cycle protection', () => {
  it('rejects a response after explicit invalidation', async () => {
    let resolveResponse: ((response: GenerationResponse) => void) | undefined;
    const generator: GenerationInterface = {
      generate: vi.fn<(request: GenerationRequest) => Promise<GenerationResponse>>(
        (_request) => new Promise((resolve) => { resolveResponse = resolve; }),
      ),
    };
    const coordinator = new GenerationCoordinator(() => 'cycle-live');
    const request = coordinator.generate(page, [], generator);
    coordinator.invalidate();
    resolveResponse?.({ cycleId: 'cycle-live', results: [{
      questionId: 'name',
      status: 'GENERATED',
      answer: { questionId: 'name', value: 'stale' },
    }] });

    await expect(request).resolves.toBeNull();
  });
});

