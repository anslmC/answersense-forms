import { discoverActiveGoogleFormsPage, type DiscoveredPage } from '../Forms/Discovery';
import type { PendingPageState } from '../Generation/Pending';

export interface PendingNavigation {
  readonly oldPageId: string;
  readonly oldPageSnapshot?: PendingPageState | null;
}

export function beginNextNavigation(
  oldPageId: string,
  oldPageSnapshot: PendingPageState | null = null,
): PendingNavigation {
  return { oldPageId, oldPageSnapshot };
}

export function confirmPageTransition(
  document: Document,
  navigation: PendingNavigation,
): DiscoveredPage | null {
  const activePage = discoverActiveGoogleFormsPage(document);
  return activePage && activePage.pageId !== navigation.oldPageId
    ? activePage
    : null;
}
