import { describe, expect, it, vi } from 'vitest';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';
import { createFinalizedPageHandoff } from '../src/Fill/Handoff';
import type {
  GenerationInterface,
  GenerationResponse,
} from '../src/Generation/Contract';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { PageLifecycle } from '../src/Lifecycle/PageLifecycle';
import {
  pageNavigationMutationOptions,
  processObservedNavigation,
  shouldGeneratePage,
  waitForInitialDiscovery,
} from '../src/Content/Navigation';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';

function createQuestion(id: string, text = id): Question {
  return {
    id,
    text,
    type: 'short-text',
    required: false,
    options: [],
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
  };
}

const initialForm: Form = {
  formId: 'form-1',
  activePageId: 'page-1',
  questions: [createQuestion('name')],
};

const initialPage: NormalizedActivePage = {
  form: initialForm,
  questionResults: [
    { questionId: 'name', status: 'ready', answer: null, reason: null },
  ],
  processingCycle: { cycleId: 'cycle-1' },
};

function createDocument(
  activePage = 'page-1',
  questionText = 'name'
): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><main>
    <section data-page-id="page-1" data-answersense-active-page="${activePage === 'page-1'}">
      <div role="listitem" data-question-id="name" data-question-text="${questionText}" data-question-type="short-text">
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
  const generation = new GenerationCoordinator(() => `cycle-${++count}`);
  return { lifecycle: new PageLifecycle(initialPage, generation), generation };
}

function settleInitialPage(lifecycle: PageLifecycle, document: Document): void {
  (document.querySelector('input') as HTMLInputElement).value =
    'Settled answer';
  lifecycle.acceptFinalizedHandoff(
    createFinalizedPageHandoff(document, initialForm, {
      cycleId: lifecycle.currentCycle.cycleId,
      pageId: 'page-1',
      outcomes: [
        {
          questionId: 'name',
          status: 'FILLED',
          answer: { questionId: 'name', value: 'Settled answer' },
          reason: null,
          code: null,
        },
      ],
    })
  );
  lifecycle.beginNext(document);
}

async function observe(
  lifecycle: PageLifecycle,
  document: Document
): Promise<{ transitioned: boolean; published: NormalizedActivePage[] }> {
  const published: NormalizedActivePage[] = [];
  const transitioned = await processObservedNavigation(
    lifecycle,
    document,
    () => discoverActiveGoogleFormsPage(document),
    async (page) => {
      published.push(page);
    }
  );
  return { transitioned, published };
}

describe('Content navigation runtime adapter', () => {
  it('waits for a page inserted after content-script startup', async () => {
    const document = new DOMParser().parseFromString(
      '<!doctype html><main></main>',
      'text/html'
    );
    let discoveryAttempts = 0;
    const discovery = waitForInitialDiscovery(
      document,
      () => {
        discoveryAttempts += 1;
        return discoverActiveGoogleFormsPage(document);
      },
      { maxAttempts: 5, timeoutMs: 1000 }
    );

    const page = document.createElement('section');
    page.dataset.pageId = 'page-1';
    page.innerHTML =
      '<div role="listitem" data-question-id="name" data-question-text="Name"><input type="text"></div>';
    document.querySelector('main')?.append(page);

    await expect(discovery).resolves.toMatchObject({ pageId: 'page-1' });
    const attemptsAfterSuccess = discoveryAttempts;
    page.setAttribute('aria-current', 'page');
    await Promise.resolve();
    expect(discoveryAttempts).toBe(attemptsAfterSuccess);
  });

  it('terminates when no valid page appears', async () => {
    const document = new DOMParser().parseFromString(
      '<!doctype html><main></main>',
      'text/html'
    );
    const discovery = waitForInitialDiscovery(
      document,
      () => discoverActiveGoogleFormsPage(document),
      { maxAttempts: 2, timeoutMs: 10 }
    );

    await expect(discovery).resolves.toBeNull();
  });

  it('observes child-list and active-state attribute mutations', () => {
    expect(pageNavigationMutationOptions.childList).toBe(true);
    expect(pageNavigationMutationOptions.attributes).toBe(true);
    expect(pageNavigationMutationOptions.characterData).toBe(true);
    expect(pageNavigationMutationOptions.attributeFilter).toEqual(
      expect.arrayContaining(['aria-current', 'class', 'style'])
    );
  });

  it('routes Next to a new page through discovery and classification', async () => {
    const { lifecycle } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);

    const result = await observe(lifecycle, createDocument('page-2'));

    expect(result.transitioned).toBe(true);
    expect(result.published[0]?.form.activePageId).toBe('page-2');
    expect(lifecycle.currentRevisitStatus).toBe('NEW');
  });

  it('does not complete a transition before publication is acknowledged', async () => {
    const { lifecycle } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });

    const transition = processObservedNavigation(
      lifecycle,
      createDocument('page-2'),
      () => discoverActiveGoogleFormsPage(createDocument('page-2')),
      () => publication
    );
    let completed = false;
    void transition.then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    releasePublication();
    await expect(transition).resolves.toBe(true);
  });

  it('propagates a publication failure instead of reporting transition success', async () => {
    const { lifecycle } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);
    const publicationFailure = new Error('publication failed');

    await expect(
      processObservedNavigation(
        lifecycle,
        createDocument('page-2'),
        () => discoverActiveGoogleFormsPage(createDocument('page-2')),
        async () => {
          throw publicationFailure;
        }
      )
    ).rejects.toBe(publicationFailure);
  });

  it('reuses an unchanged Previous/Back revisit without invoking generation', async () => {
    const { lifecycle, generation } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);
    await observe(lifecycle, createDocument('page-2'));

    const result = await observe(lifecycle, createDocument('page-1'));
    const backend: GenerationInterface = {
      generate: vi.fn(async (request): Promise<GenerationResponse> => ({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: {
            questionId: question.questionId,
            value: 'Generated answer',
          },
        })),
      })),
    };
    if (shouldGeneratePage(lifecycle.currentRevisitStatus)) {
      await generation.generate(
        lifecycle.currentPage,
        lifecycle.settledPageStates,
        backend,
        lifecycle.currentCycle
      );
    }

    expect(result.transitioned).toBe(true);
    expect(result.published[0]?.form.activePageId).toBe('page-1');
    expect(lifecycle.currentRevisitStatus).toBe('UNCHANGED_REVISIT');
    expect(shouldGeneratePage(lifecycle.currentRevisitStatus)).toBe(false);
    expect(backend.generate).not.toHaveBeenCalled();
    expect(lifecycle.pendingPage).toBeNull();
  });

  it('reprocesses a changed Previous/Back revisit through the existing coordinator', async () => {
    const { lifecycle, generation } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);
    await observe(lifecycle, createDocument('page-2'));

    const result = await observe(
      lifecycle,
      createDocument('page-1', 'Changed question')
    );
    const backend: GenerationInterface = {
      generate: vi.fn(async (request): Promise<GenerationResponse> => ({
        cycleId: request.cycleId,
        results: request.questions.map((question) => ({
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: {
            questionId: question.questionId,
            value: 'Generated answer',
          },
        })),
      })),
    };
    if (shouldGeneratePage(lifecycle.currentRevisitStatus)) {
      await generation.generate(
        lifecycle.currentPage,
        lifecycle.settledPageStates,
        backend,
        lifecycle.currentCycle
      );
    }

    expect(result.transitioned).toBe(true);
    expect(lifecycle.currentRevisitStatus).toBe('CHANGED_REVISIT');
    expect(shouldGeneratePage(lifecycle.currentRevisitStatus)).toBe(true);
    expect(backend.generate).toHaveBeenCalledTimes(1);
  });

  it('does not settle or duplicate context across repeated blocked and confirmed attempts', async () => {
    const { lifecycle } = createLifecycle();
    const oldDocument = createDocument();
    settleInitialPage(lifecycle, oldDocument);

    const blocked = await observe(lifecycle, createDocument());
    const repeatedBlocked = await observe(lifecycle, createDocument());
    expect(blocked.transitioned).toBe(false);
    expect(repeatedBlocked.transitioned).toBe(false);
    expect(lifecycle.context).toEqual([]);
    expect(lifecycle.pendingPage).not.toBeNull();

    const transitioned = await observe(lifecycle, createDocument('page-2'));
    const repeatedTransition = await observe(lifecycle, createDocument('page-2'));
    expect(transitioned.transitioned).toBe(true);
    expect(repeatedTransition.transitioned).toBe(false);
    expect(lifecycle.context).toEqual([
      { questionId: 'name', questionText: 'name', answer: 'Settled answer' },
    ]);
  });
});
