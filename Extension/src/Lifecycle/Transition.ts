import {
  discoverActiveGoogleFormsPage,
  type DiscoveredPage,
} from '../Forms/Discovery';

export interface PendingNavigation {
  readonly oldPageId: string;
}

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
