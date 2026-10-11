import { NVIDIA_HOST_PERMISSION } from '../Generation/NvidiaProvider';

const grantButton = document.querySelector<HTMLButtonElement>(
  '#grant-nvidia-access'
);
const status = document.querySelector<HTMLElement>('#permission-status');

grantButton?.addEventListener('click', async () => {
  grantButton.disabled = true;
  if (status) status.textContent = 'Requesting permission...';
  try {
    const granted = await chrome.permissions.request({
      origins: [NVIDIA_HOST_PERMISSION],
    });
    if (status) {
      status.textContent = granted
        ? 'NVIDIA access granted. Return to AnswerSense to validate the provider.'
        : 'NVIDIA access was not granted. You can retry or close this page.';
    }
  } catch {
    if (status) {
      status.textContent = 'The permission request could not be completed. Please retry.';
    }
  } finally {
    grantButton.disabled = false;
  }
});