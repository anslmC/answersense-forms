export function findTopLevelQuestionContainers(
  form: HTMLFormElement
): HTMLElement[] | null {
  const lists = Array.from(
    form.querySelectorAll<HTMLElement>('[role="list"]')
  ).filter((list) => list.closest('[role="listitem"]') === null);
  if (lists.length !== 1) {
    return null;
  }

  return Array.from(lists[0].children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.getAttribute('role') === 'listitem'
  );
}
