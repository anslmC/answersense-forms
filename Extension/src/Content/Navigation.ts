import type { DiscoveredPage } from '../Forms/Discovery';
import type { NormalizedActivePage } from '../Models/Logical';
import type { PageLifecycle } from '../Lifecycle/PageLifecycle';

export const pageNavigationMutationOptions: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true,
  attributeFilter: [
    'aria-current',
    'aria-hidden',
    'class',
    'data-answersense-active-page',
    'data-page-active',
    'style',
  ],
};

export interface InitialDiscoveryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
}

interface DeferredNavigationRecheck {
  navigation: NonNullable<PageLifecycle['pendingNavigation']>;
  timeoutId: ReturnType<typeof setTimeout>;
}

const deferredNavigationRechecks = new WeakMap<
  PageLifecycle,
  DeferredNavigationRecheck
>();

function clearDeferredNavigationRecheck(lifecycle: PageLifecycle): void {
  const recheck = deferredNavigationRechecks.get(lifecycle);
  if (!recheck) {
    return;
  }
  clearTimeout(recheck.timeoutId);
  deferredNavigationRechecks.delete(lifecycle);
}

function scheduleDeferredNavigationRecheck(
  lifecycle: PageLifecycle,
  document: Document,
  discoverPage: () => DiscoveredPage | null,
  publishTransition: (page: NormalizedActivePage) => Promise<void>,
  onError: (error: unknown) => void
): void {
  const navigation = lifecycle.pendingNavigation;
  if (!navigation || deferredNavigationRechecks.has(lifecycle)) {
    return;
  }

  const timeoutId = setTimeout(() => {
    const recheck = deferredNavigationRechecks.get(lifecycle);
    if (!recheck || lifecycle.pendingNavigation !== recheck.navigation) {
      clearDeferredNavigationRecheck(lifecycle);
      return;
    }
    void processObservedNavigation(
      lifecycle,
      document,
      discoverPage,
      publishTransition,
      onError
    ).catch(onError);
  }, 0);
  deferredNavigationRechecks.set(lifecycle, { navigation, timeoutId });
}

export function waitForInitialDiscovery(
  document: Document,
  discoverPage: () => DiscoveredPage | null,
  options: InitialDiscoveryOptions = {}
): Promise<DiscoveredPage | null> {
  const maxAttempts = options.maxAttempts ?? 20;
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve) => {
    let attempts = 0;
    let settled = false;
    let stabilizationScheduled = false;
    const target = document.documentElement ?? document;
    const observer = new MutationObserver(attempt);
    const timeoutId = setTimeout(() => finish(null), timeoutMs);

    function finish(page: DiscoveredPage | null): void {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      resolve(page);
    }

    function attempt(): void {
      if (settled) {
        return;
      }
      attempts += 1;
      const page = discoverPage();
      if (page) {
        if (stabilizationScheduled) {
          return;
        }
        stabilizationScheduled = true;
        const stabilize = () => {
          stabilizationScheduled = false;
          if (settled) {
            return;
          }
          const currentPage = discoverPage();
          if (currentPage) {
            finish(currentPage);
          } else {
            attempt();
          }
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(stabilize);
        } else {
          queueMicrotask(stabilize);
        }
      } else if (attempts >= maxAttempts) {
        finish(null);
      }
    }

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    attempt();
  });
}

export function shouldGeneratePage(
  revisitStatus: PageLifecycle['currentRevisitStatus']
): boolean {
  return revisitStatus !== 'UNCHANGED_REVISIT';
}

export function processObservedNavigation(
  lifecycle: PageLifecycle,
  document: Document,
  discoverPage: () => DiscoveredPage | null,
  publishTransition: (page: NormalizedActivePage) => Promise<void>,
  onError: (error: unknown) => void = () => undefined
): Promise<boolean> {
  const nextPage = lifecycle.confirmTransition(document);
  if (nextPage) {
    clearDeferredNavigationRecheck(lifecycle);
    return publishTransition(nextPage).then(() => true);
  }

  const discovered = discoverPage();
  if (
    !discovered ||
    discovered.pageId === lifecycle.currentPage.form.activePageId
  ) {
    scheduleDeferredNavigationRecheck(
      lifecycle,
      document,
      discoverPage,
      publishTransition,
      onError
    );
    return Promise.resolve(false);
  }

  const previousPage = lifecycle.handlePreviousOrBack(document);
  if (!previousPage) {
    return Promise.resolve(false);
  }
  return publishTransition(previousPage).then(() => true);
}
