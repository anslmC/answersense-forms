import {
  discoverActiveGoogleFormsPage,
  type DiscoveredPage,
} from '../Forms/Discovery';
import type { NormalizedActivePage } from '../Models/Logical';

export interface PendingNavigation {
  readonly oldPageId: string;
}

export type DocumentPageTransition = 'forward' | 'backward' | 'reload';

export function beginNextNavigation(oldPageId: string): PendingNavigation {
  return { oldPageId };
}

export function confirmPageTransition(
  document: Document,
  navigation: PendingNavigation
): DiscoveredPage | null {
  const activePage = discoverActiveGoogleFormsPage(document);
  return activePage && activePage.pageId !== navigation.oldPageId
    ? activePage
    : null;
}

export function comparePageOrder(
  previous: NormalizedActivePage,
  next: NormalizedActivePage
): -1 | 0 | 1 | null {
  const previousRange = previous.form.pageEntryRange;
  const nextRange = next.form.pageEntryRange;
  if (!previousRange || !nextRange) {
    return previous.form.activePageId === next.form.activePageId ? 0 : null;
  }
  if (
    previousRange.first === nextRange.first &&
    previousRange.last === nextRange.last
  ) {
    return 0;
  }
  return nextRange.first > previousRange.first ? 1 : -1;
}
