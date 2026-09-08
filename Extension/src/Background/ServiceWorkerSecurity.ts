export interface MessageSenderLike {
  id?: string;
  tab?: unknown;
}

export function isTrustedExtensionSender(
  sender: MessageSenderLike,
  extensionId: string
): boolean {
  return sender.id === extensionId;
}

export function isTrustedPopupSender(
  sender: MessageSenderLike,
  extensionId: string
): boolean {
  return isTrustedExtensionSender(sender, extensionId) && !sender.tab;
}

export function isTrustedContentSender(
  sender: MessageSenderLike,
  extensionId: string
): boolean {
  if (!isTrustedExtensionSender(sender, extensionId) || !sender.tab) {
    return false;
  }
  const tabId = (sender.tab as { id?: unknown }).id;
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0;
}

export function isTrustedContentTabSender(
  sender: MessageSenderLike,
  extensionId: string,
  activeTabId: number
): boolean {
  return (
    isTrustedContentSender(sender, extensionId) &&
    (sender.tab as { id: number }).id === activeTabId
  );
}
