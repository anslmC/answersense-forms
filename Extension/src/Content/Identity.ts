import type { DiscoveredPage } from '../Forms/Discovery';
import type { LifecycleSnapshot } from '../Lifecycle/PageLifecycle';

export function belongsToSameForm(
  snapshot: LifecycleSnapshot,
  discovered: DiscoveredPage
): boolean {
  const previousFormId = snapshot.activePage.form.formId;
  const currentFormId = discovered.formId;
  return (
    previousFormId !== null &&
    currentFormId !== null &&
    previousFormId === currentFormId
  );
}
