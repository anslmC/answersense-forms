import type { DiscoveredPage } from '../Forms/Discovery';
import type { LifecycleSnapshot } from '../Lifecycle/PageLifecycle';

export function belongsToSameForm(
  snapshot: LifecycleSnapshot,
  discovered: DiscoveredPage
): boolean {
  const previousFormId = snapshot.activePage.form.formId;
  const currentFormId = discovered.formId ?? null;
  const previousPageId = snapshot.activePage.form.activePageId;
  const currentPageId = discovered.pageId;

  if (previousFormId !== null && currentFormId !== null) {
    return previousFormId === currentFormId;
  }

  if (previousPageId === currentPageId) {
    return true;
  }

  const previousRange = snapshot.activePage.form.pageEntryRange;
  const currentRange = discovered.pageEntryRange;
  if (
    previousRange &&
    currentRange &&
    previousRange.first === currentRange.first &&
    previousRange.last === currentRange.last
  ) {
    return true;
  }

  return false;
}
