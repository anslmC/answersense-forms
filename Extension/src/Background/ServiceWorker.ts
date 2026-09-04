import { EXTENSION_NAME, log } from '../Shared/Utils';

log(`${EXTENSION_NAME} service worker initialized.`);

chrome.runtime.onInstalled.addListener(() => {
  log('Extension installed and ready for foundation initialization.');
});
