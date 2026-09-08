import { EXTENSION_NAME, log } from '../Shared/Utils';
import { discoverActiveGoogleFormsPage } from '../Forms/Discovery';
import { isSupportedGoogleFormsPage } from '../Forms/Detection';
import { normalizeDiscoveredActivePage } from '../Forms/Normalization';
import { GenerationCoordinator } from '../Generation/Pipeline';
import { createAcceptedReviewDecisions } from '../Review/Decisions';
import { fillReviewedAnswers } from '../Fill/Filler';
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
import type {
  GenerationRequest,
  GenerationResponse,
} from '../Generation/Contract';
import type { DiscoveredPage } from '../Forms/Discovery';

log(`${EXTENSION_NAME} content script initialized.`);

const supportedPage = isSupportedGoogleFormsPage(window.location);
const generation = new GenerationCoordinator(() => crypto.randomUUID());
let lifecycle: PageLifecycle | null = null;
let lifecycleInitialization: Promise<void> | null = null;

function publishLifecycleSnapshot(): void {
  if (lifecycle) {
    void chrome.runtime.sendMessage({
      type: 'lifecycle-snapshot',
      snapshot: lifecycle.getSnapshot(window.location.pathname),
    });
  }
}

function publishTransition(
  page: ReturnType<PageLifecycle['confirmTransition']>
): void {
  if (!page || !lifecycle) {
    return;
  }
  void chrome.runtime.sendMessage({
    type: 'lifecycle-transition-confirmed',
    pageId: page.form.activePageId,
    questionCount: page.form.questions.length,
    revisitStatus: lifecycle.currentRevisitStatus,
    snapshot: lifecycle.getSnapshot(window.location.pathname),
  });
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
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest<HTMLElement>('[role="button"], button');
    if (button && isNextNavigationButton(button)) {
      try {
        ensureLifecycle().beginNext();
        publishLifecycleSnapshot();
      } catch {
        // Discovery remains authoritative if no active lifecycle exists yet.
      }
    }
  });

  const observer = new MutationObserver(() => {
    if (!lifecycle) {
      return;
    }
    processObservedNavigation(
      lifecycle,
      document,
      discoverPage,
      publishTransition
    );
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
  publishLifecycleSnapshot();
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
        publishLifecycleSnapshot();
      } else {
        publishTransition(reconciled);
      }
    } else {
      ensureLifecycle(discovered);
    }
  })();

  return lifecycleInitialization;
}

const hydration = waitForInitialDiscovery(document, discoverPage)
  .then((discovered) => (discovered ? hydrateLifecycle(discovered) : undefined))
  .catch(() => undefined);

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
  retry?: boolean;
  configurationDigest?: string;
  configurationRevision?: number;
}): Promise<unknown> {
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
    return {
      status: 'current-state',
      supported: true,
      lifecycle: lifecycle?.getSnapshot(window.location.pathname) ?? null,
      page: {
        pageId: page.pageId,
        questionCount: page.questions.length,
      },
    };
  }

  if (request.type === 'generate-current-page') {
    await hydration;
    if (
      !request.configurationDigest ||
      request.configurationRevision === undefined
    ) {
      throw new Error('Generation configuration is missing.');
    }
    const pageLifecycle = ensureLifecycle();
    if (request.retry === true) {
      pageLifecycle.retryGeneration();
      publishLifecycleSnapshot();
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
      pageLifecycle.currentCycle
    );
    if (!report) {
      throw new Error('Generation response was stale or invalidated.');
    }
    const fillReport = await fillReviewedAnswers(
      document,
      pageLifecycle.currentPage.form,
      report,
      createAcceptedReviewDecisions(report)
    );
    const handoff = createFinalizedPageHandoff(
      document,
      pageLifecycle.currentPage.form,
      fillReport
    );
    pageLifecycle.acceptFinalizedHandoff(handoff);
    publishLifecycleSnapshot();
    return { report, fillReport };
  }

  if (request.type === 'begin-next') {
    await hydration;
    ensureLifecycle().beginNext();
    publishLifecycleSnapshot();
    return { status: 'next-initiated' };
  }

  if (request.type === 'confirm-transition') {
    await hydration;
    const nextPage = ensureLifecycle().confirmTransition(document);
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
    publishLifecycleSnapshot();
    return { status: 'abandoned' };
  }

  if (request.type === 'restart') {
    await hydration;
    const cycle = ensureLifecycle().restart();
    publishLifecycleSnapshot();
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
