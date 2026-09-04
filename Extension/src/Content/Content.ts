import { EXTENSION_NAME, log } from '../Shared/Utils';
import { discoverActiveGoogleFormsPage } from '../Forms/Discovery';
import { isSupportedGoogleFormsPage } from '../Forms/Detection';

log(`${EXTENSION_NAME} content script initialized.`);

const supportedPage = isSupportedGoogleFormsPage(window.location);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  log('Content script received a message.', request);

  if (request?.type === 'discover-active-page') {
    if (!supportedPage) {
      sendResponse({ status: 'unsupported-page', supported: false });
      return true;
    }

    const page = discoverActiveGoogleFormsPage(document);
    sendResponse({
      status: page ? 'discovered' : 'no-active-page',
      supported: true,
      page,
    });
    return true;
  }

  sendResponse({ status: 'ready', extension: EXTENSION_NAME });
  return true;
});
