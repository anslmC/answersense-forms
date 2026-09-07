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

export function waitForInitialDiscovery(
  document: Document,
  discoverPage: () => DiscoveredPage | null,
  options: InitialDiscoveryOptions = {},
): Promise<DiscoveredPage | null> {
  const maxAttempts = options.maxAttempts ?? 20;
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise((resolve) => {
    let attempts = 0;
    let settled = false;
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
        finish(page);
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
  revisitStatus: PageLifecycle['currentRevisitStatus'],
): boolean {
  return revisitStatus !== 'UNCHANGED_REVISIT';
}

export function processObservedNavigation(
  lifecycle: PageLifecycle,
  document: Document,
  discoverPage: () => DiscoveredPage | null,
  publishTransition: (page: NormalizedActivePage) => void,
): boolean {
  const nextPage = lifecycle.confirmTransition(document);
  if (nextPage) {
    publishTransition(nextPage);
    return true;
  }

  const discovered = discoverPage();
  if (!discovered || discovered.pageId === lifecycle.currentPage.form.activePageId) {
    return false;
  }

  const previousPage = lifecycle.handlePreviousOrBack(document);
  if (!previousPage) {
    return false;
  }
  publishTransition(previousPage);
  return true;
}
