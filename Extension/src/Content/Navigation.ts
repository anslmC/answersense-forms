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
