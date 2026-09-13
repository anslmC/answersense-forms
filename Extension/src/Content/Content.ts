import { EXTENSION_NAME, log } from '../Shared/Utils';
import { discoverActiveGoogleFormsPage } from '../Forms/Discovery';
import { isSupportedGoogleFormsPage } from '../Forms/Detection';
import { normalizeDiscoveredActivePage } from '../Forms/Normalization';
import { GenerationCoordinator } from '../Generation/Pipeline';
import { createAcceptedReviewDecisions } from '../Review/Decisions';
import {
  createSkipDiagnostics,
  fillReviewedAnswers,
  type FillOutcome,
} from '../Fill/Filler';
import { createFinalizedPageHandoff } from '../Fill/Handoff';
import { PageLifecycle } from '../Lifecycle/PageLifecycle';
import {
  pageNavigationMutationOptions,
  processObservedNavigation,
  shouldGeneratePage,
  waitForInitialDiscovery,
} from './Navigation';
import { comparePageOrder } from '../Lifecycle/Transition';
import { belongsToSameForm } from './Identity';
import {
  LifecyclePublicationQueue,
  type LifecyclePublicationMessage,
} from './LifecyclePublication';
import { mountOverlay, type OverlayHandle } from '../Overlay/Overlay';
import type {
  GenerationRequest,
  GenerationResponse,
} from '../Generation/Contract';
import {
  createOverrideFilledIntent,
  parseGenerationIntent,
  validOverrideQuestionIds,
  validateOverrideSelection,
  type GenerationIntent,
} from '../Generation/Intent';
import type { DiscoveredPage } from '../Forms/Discovery';

log(`${EXTENSION_NAME} content script initialized.`);

const supportedPage = isSupportedGoogleFormsPage(window.location);
const generation = new GenerationCoordinator(() => crypto.randomUUID());
const OVERLAY_UI_STORAGE_KEY = 'answersense-overlay-opened';

let lifecycle: PageLifecycle | null = null;
let lifecycleInitialization: Promise<void> | null = null;
let lifecyclePublicationError: string | null = null;
let overlayHandle: OverlayHandle | null = null;
const lifecyclePublications = new LifecyclePublicationQueue((message) =>
  chrome.runtime.sendMessage(message)
);

async function setOverlayPreference(open: boolean): Promise<void> {
  await chrome.storage.local.set({ [OVERLAY_UI_STORAGE_KEY]: open });
}

async function readOverlayPreference(): Promise<boolean> {
  const stored = await chrome.storage.local.get(OVERLAY_UI_STORAGE_KEY);
  return stored[OVERLAY_UI_STORAGE_KEY] === true;
}

async function ensureOverlay(): Promise<OverlayHandle | null> {
  if (!supportedPage || !document.body || overlayHandle) {
    return overlayHandle;
  }
  overlayHandle = await mountOverlay({
    onClose: () => {
      overlayHandle = null;
    },
    onRefresh: async () => {
      await resynchronizeCurrentPage();
      await overlayHandle?.refresh();
    },
  });
  return overlayHandle;
}

function publishLifecycleSnapshot(): Promise<void> {
  if (!lifecycle) {
    return Promise.resolve();
  }
  const publication = lifecyclePublications.publish({
    type: 'lifecycle-snapshot',
    snapshot: lifecycle.getSnapshot(window.location.pathname),
  } satisfies LifecyclePublicationMessage);
  return publication.then(() => {
    lifecyclePublicationError = null;
  });
}

function publishResetSnapshot(): Promise<void> {
  if (!lifecycle) {
    return Promise.resolve();
  }
  return lifecyclePublications.publish({
    type: 'lifecycle-snapshot',
    reset: true,
    snapshot: lifecycle.getSnapshot(window.location.pathname),
  } satisfies LifecyclePublicationMessage).then(() => {
    lifecyclePublicationError = null;
  });
}

async function forceClearAnswerSenseState(): Promise<
  ReturnType<PageLifecycle['getSnapshot']>
> {
  await hydration;
  const pageLifecycle = ensureLifecycle();
  pageLifecycle.forceClear();
  const resetSnapshot = pageLifecycle.getSnapshot(
    window.location.pathname
  );
  await publishResetSnapshot();

  lifecycle = null;
  lifecycleInitialization = null;
  return resetSnapshot;
}

async function resynchronizeCurrentPage(): Promise<void> {
  await hydration;
  const discovered = discoverPage();
  if (!discovered) {
    throw new Error('Active page could not be discovered for refresh.');
  }
  ensureLifecycle(discovered).resynchronizeCurrentPage(discovered);
  await publishResetSnapshot();
}

async function synchronizeCurrentPage(): Promise<
  'unchanged' | 'resynchronized' | 'pending'
> {
  const discovered = discoverPage();
  if (!discovered) {
    throw new Error('Active page could not be discovered for generation.');
  }
  const pageLifecycle = ensureLifecycle(discovered);
  const synchronization = pageLifecycle.synchronizeCurrentPage(discovered);
  if (synchronization === 'resynchronized') {
    await publishResetSnapshot();
  }
  return synchronization;
}

function publishTransition(
  page: ReturnType<PageLifecycle['confirmTransition']>
): Promise<void> {
  if (!page || !lifecycle) {
    return Promise.resolve();
  }
  const publication = lifecyclePublications.publish({
    type: 'lifecycle-transition-confirmed',
    pageId: page.form.activePageId,
    questionCount: page.form.questions.length,
    revisitStatus: lifecycle.currentRevisitStatus,
    snapshot: lifecycle.getSnapshot(window.location.pathname),
  } satisfies LifecyclePublicationMessage);
  return publication.then(() => {
    lifecyclePublicationError = null;
    overlayHandle?.refresh();
  });
}

function recordLifecyclePublicationFailure(error: unknown): void {
  lifecyclePublicationError =
    error instanceof Error ? error.message : 'Lifecycle publication failed.';
  console.error('AnswerSense lifecycle publication failed.', error);
}

function isNextNavigationButton(button: HTMLElement): boolean {
  const label = button.textContent?.replace(/\s+/g, ' ').trim().toLowerCase();
  return (
    label === 'next' ||
    label?.endsWith(' next') === true ||
    button.getAttribute('jsname') === 'OCpkoe'
  );
}

function observeNextIntent(): void {
  const captureCurrentAnswers = (): void => {
    if (!lifecycle) return;
    lifecycle.captureCurrentAnswers(document);
    void publishLifecycleSnapshot().catch(recordLifecyclePublicationFailure);
  };

  document.addEventListener('input', captureCurrentAnswers);
  document.addEventListener('change', captureCurrentAnswers);
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest<HTMLElement>('[role="button"], button');
    if (button && isNextNavigationButton(button)) {
      void (async () => {
        try {
          ensureLifecycle().beginNext();
          await publishLifecycleSnapshot();
        } catch (error) {
          recordLifecyclePublicationFailure(error);
        }
      })();
    }
  });

  const observer = new MutationObserver(() => {
    if (!lifecycle) {
      return;
    }
    void processObservedNavigation(
      lifecycle,
      document,
      discoverPage,
      publishTransition,
      recordLifecyclePublicationFailure
    ).catch(recordLifecyclePublicationFailure);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, pageNavigationMutationOptions);
  }
}

function discoverPage() {
  return supportedPage ? discoverActiveGoogleFormsPage(document) : null;
}

function ensureLifecycle(discovered?: DiscoveredPage): PageLifecycle {
  if (lifecycle) {
    return lifecycle;
  }
  const page = discovered ?? discoverPage();
  if (!page) {
    throw new Error('Active page could not be discovered.');
  }
  lifecycle = new PageLifecycle(
    normalizeDiscoveredActivePage(page),
    generation
  );
  return lifecycle;
}

function isViewFormPath(pathname: string): boolean {
  return pathname.endsWith('/viewform');
}

function isFormResponsePath(pathname: string | undefined): boolean {
  return pathname?.endsWith('/formResponse') === true;
}

function documentTransitionFor(
  snapshot: import('../Lifecycle/PageLifecycle').LifecycleSnapshot,
  discovered: DiscoveredPage
): 'forward' | 'backward' | 'reload' {
  const currentPage = normalizeDiscoveredActivePage(discovered);
  if (
    snapshot.activePage.form.activePageId === currentPage.form.activePageId ||
    (isFormResponsePath(snapshot.documentPathname) &&
      isViewFormPath(window.location.pathname))
  ) {
    return 'reload';
  }
  const order = comparePageOrder(snapshot.activePage, currentPage);
  if (order === 1 || snapshot.navigation) {
    return 'forward';
  }
  if (order === -1) {
    return 'backward';
  }
  return 'reload';
}

async function hydrateLifecycle(discovered: DiscoveredPage): Promise<void> {
  if (lifecycleInitialization) {
    return lifecycleInitialization;
  }

  lifecycleInitialization = (async () => {
    const snapshot = await chrome.runtime.sendMessage({
      type: 'get-lifecycle-snapshot',
    });
    if (lifecycle) {
      return;
    }
    if (
      snapshot?.lifecycle &&
      belongsToSameForm(snapshot.lifecycle, discovered)
    ) {
      lifecycle = new PageLifecycle(
        normalizeDiscoveredActivePage(discovered),
        generation,
        snapshot.lifecycle
      );
      const transition = documentTransitionFor(snapshot.lifecycle, discovered);
      const reconciled = lifecycle.reconcileDocument(
        discovered,
        document,
        transition
      );
      if (transition === 'reload') {
        await publishResetSnapshot();
      } else {
        await publishTransition(reconciled);
      }
    } else {
      ensureLifecycle(discovered);
      await publishLifecycleSnapshot();
    }
  })();

  return lifecycleInitialization;
}

const hydration = waitForInitialDiscovery(document, discoverPage)
  .then((discovered) => (discovered ? hydrateLifecycle(discovered) : undefined));
void hydration.catch(recordLifecyclePublicationFailure);
void hydration.then(async () => {
  if (await readOverlayPreference()) {
    const mountedOverlay = await ensureOverlay();
    mountedOverlay?.refresh();
  }
});

function createGeminiGenerator(
  configurationDigest: string,
  configurationRevision: number
) {
  return {
    async generate(request: GenerationRequest): Promise<GenerationResponse> {
      const response = await chrome.runtime.sendMessage({
        type: 'gemini-generate',
        request,
        configurationDigest,
        configurationRevision,
      });
      if (response?.error) {
        throw new Error(String(response.error));
      }
      return response as GenerationResponse;
    },
  };
}

async function handleRequest(request: {
  type?: string;
  configurationDigest?: string;
  configurationRevision?: number;
  intent?: unknown;
}): Promise<unknown> {
  if (request.type === 'toggle-overlay') {
    if (!supportedPage || !document.body) {
      return { status: 'unsupported-page', supported: false };
    }
    if (overlayHandle) {
      overlayHandle.close();
      overlayHandle = null;
      await setOverlayPreference(false);
      return { status: 'closed', supported: true };
    }
    await ensureOverlay();
    await setOverlayPreference(true);
    return { status: 'opened', supported: true };
  }

  if (request.type === 'discover-active-page') {
    if (!supportedPage) {
      return { status: 'unsupported-page', supported: false };
    }
    const page = discoverPage();
    if (page) {
      await hydrateLifecycle(page);
    }
    return {
      status: page ? 'discovered' : 'no-active-page',
      supported: true,
      page,
    };
  }

  if (request.type === 'get-current-state') {
    await hydration;
    if (!supportedPage) {
      return { status: 'unsupported-page', supported: false };
    }
    const page = discoverPage();
    if (!page) {
      return { status: 'no-active-page', supported: true };
    }
    await hydrateLifecycle(page);
    const synchronization = await synchronizeCurrentPage();
    const currentPage = ensureLifecycle().currentPage;
    return {
      status: 'current-state',
      synchronized: synchronization !== 'pending',
      supported: true,
      lifecycle: lifecycle?.getSnapshot(window.location.pathname) ?? null,
      publicationError: lifecyclePublicationError,
      page: {
        pageId: currentPage.form.activePageId,
        questionCount: currentPage.form.questions.length,
      },
    };
  }

  if (request.type === 'preflight-generation') {
    await hydration;
    if (!supportedPage) {
      throw new Error('Override generation is unavailable on this page.');
    }
    const synchronization = await synchronizeCurrentPage();
    if (synchronization === 'pending') {
      throw new Error('Generation is unavailable while page transition is pending.');
    }
    if (synchronization === 'resynchronized') {
      throw new Error('Override generation requires a synchronized current page.');
    }
    const intent = parseGenerationIntent(request.intent);
    const validation = validateOverrideSelection(
      ensureLifecycle().currentPage,
      intent
    );
    if (intent.type === 'OVERRIDE_FILLED' && intent.selectedQuestionIds.length === 0) {
      throw new Error('Override selection is invalid: <empty-selection>');
    }
    return { status: 'valid', invalidQuestionIds: validation.invalidQuestionIds };
  }

  if (request.type === 'generate-current-page') {
    await hydration;
    if (
      !request.configurationDigest ||
      request.configurationRevision === undefined
    ) {
      throw new Error('Generation configuration is missing.');
    }
    const synchronization = await synchronizeCurrentPage();
    if (synchronization === 'pending') {
      throw new Error('Generation is unavailable while page transition is pending.');
    }
    if (synchronization === 'resynchronized') {
      throw new Error('Generation requires a synchronized current page.');
    }
    const pageLifecycle = ensureLifecycle();
    const intent: GenerationIntent = request.intent
      ? parseGenerationIntent(request.intent)
      : { type: 'GENERATE_UNANSWERED' };
    let executionIntent = intent;
    let invalidOverrideQuestionIds: readonly string[] = [];
    if (intent.type === 'OVERRIDE_FILLED') {
      const validation = validateOverrideSelection(pageLifecycle.currentPage, intent);
      if (intent.selectedQuestionIds.length === 0) {
        throw new Error('Override selection is invalid: <empty-selection>');
      }
      invalidOverrideQuestionIds = validation.invalidQuestionIds;
      executionIntent = createOverrideFilledIntent(
        validOverrideQuestionIds(pageLifecycle.currentPage, intent)
      );
    }
    if (!shouldGeneratePage(pageLifecycle.currentRevisitStatus)) {
      return {
        status: 'reused',
        pageId: pageLifecycle.currentPage.form.activePageId,
      };
    }
    const report = await generation.generate(
      pageLifecycle.currentPage,
      pageLifecycle.settledPageStates,
      createGeminiGenerator(
        request.configurationDigest,
        request.configurationRevision
      ),
      pageLifecycle.currentCycle,
      executionIntent
    );
    if (!report) {
      throw new Error('Generation response was stale or invalidated.');
    }
    const filledReport = await fillReviewedAnswers(
      document,
      pageLifecycle.currentPage.form,
      report,
      createAcceptedReviewDecisions(report),
      executionIntent.type === 'OVERRIDE_FILLED'
    );
    const invalidOutcomes: FillOutcome[] = invalidOverrideQuestionIds.map(
      (questionId) => {
        const question = pageLifecycle?.currentPage.form.questions.find(
          (candidate) => candidate.id === questionId
        );
        const isEmpty = question?.existingInput?.hasValue !== true;
        return {
          questionId,
          status: 'FILL_FAILED',
          answer: null,
          reason: isEmpty
            ? 'The question was empty. Consider manually entering an answer or using Auto-Generate.'
            : 'The question could not be validated for Override.',
          code: 'OVERRIDE_VALIDATION_FAILED',
        };
      }
    );
    const fillReport = {
      cycleId: filledReport.cycleId,
      outcomes: Object.freeze([
        ...filledReport.outcomes,
        ...invalidOutcomes,
      ]),
    };
    const handoff = createFinalizedPageHandoff(
      document,
      pageLifecycle.currentPage.form,
      fillReport
    );
    pageLifecycle.acceptFinalizedHandoff(handoff);
    if (typeof globalThis !== 'undefined') {
      const skipDiagnostics = createSkipDiagnostics(report, fillReport);
      (globalThis as typeof globalThis & {
        __answersenseSkipDiagnostics?: readonly object[];
      }).__answersenseSkipDiagnostics = skipDiagnostics;
    }
    await publishLifecycleSnapshot();
    return { report, fillReport };
  }

  if (request.type === 'begin-next') {
    await hydration;
    ensureLifecycle().beginNext();
    await publishLifecycleSnapshot();
    return { status: 'next-initiated' };
  }

  if (request.type === 'force-clear') {
    const snapshot = await forceClearAnswerSenseState();
    return {
      status: 'force-cleared',
      snapshot,
    };
  }

  if (request.type === 'confirm-transition') {
    await hydration;
    const nextPage = ensureLifecycle().confirmTransition(document);
    if (nextPage) {
      await publishTransition(nextPage);
    }
    return nextPage
      ? {
          status: 'transition-confirmed',
          pageId: nextPage.form.activePageId,
          questionCount: nextPage.form.questions.length,
        }
      : { status: 'transition-pending' };
  }

  if (request.type === 'abandon') {
    await hydration;
    ensureLifecycle().abandon();
    await publishLifecycleSnapshot();
    return { status: 'abandoned' };
  }

  if (request.type === 'restart') {
    await hydration;
    const cycle = ensureLifecycle().restart();
    await publishLifecycleSnapshot();
    return { status: 'restarted', cycleId: cycle.cycleId };
  }

  return { status: 'ready', extension: EXTENSION_NAME };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  log('Content script received a message.');
  void handleRequest(request ?? {})
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      sendResponse({
        error:
          error instanceof Error ? error.message : 'Content operation failed.',
      });
    });
  return true;
});

observeNextIntent();
