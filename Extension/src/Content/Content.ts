// AnswerSense: Forms Content Script
// Placeholder implementation

console.log('AnswerSense: Forms content script loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  console.log('Content script received message:', request);
  sendResponse({ received: true });
});
