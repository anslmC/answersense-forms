import { EXTENSION_NAME, log } from '../Shared/Utils';

document.addEventListener('DOMContentLoaded', () => {
  const statusNode = document.querySelector('[data-status]');

  log(`${EXTENSION_NAME} popup initialized.`);

  if (statusNode) {
    statusNode.textContent = 'Foundation ready';
  }
});
