const nativeClearFormSelector =
  '[role="button"].freebirdFormviewerViewNavigationClearButton, ' +
  'button.freebirdFormviewerViewNavigationClearButton';

export function isNativeClearFormButton(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(nativeClearFormSelector) !== null
  );
}

export function observeNativeClear(
  document: Document,
  onClear: () => void
): () => void {
  const handledEvents = new WeakSet<Event>();
  const listener = (event: Event): void => {
    if (handledEvents.has(event) || !isNativeClearFormButton(event.target)) {
      return;
    }
    handledEvents.add(event);
    onClear();
  };
  document.addEventListener('click', listener, true);
  return () => document.removeEventListener('click', listener, true);
}