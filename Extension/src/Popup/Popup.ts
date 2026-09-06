import { EXTENSION_NAME, log } from '../Shared/Utils';
import { PopupController } from './Controller';
import { createBrowserPopupWorkflow } from './Workflow';
import type { UiState } from './State';
import type { WorkflowSnapshot } from './State';

function render(state: UiState): void {
  const status = document.querySelector<HTMLElement>('[data-status]');
  const detail = document.querySelector<HTMLElement>('[data-detail]');
  const message = document.querySelector<HTMLElement>('[data-message]');
  const results = document.querySelector<HTMLElement>('[data-results]');
  const primary = document.querySelector<HTMLButtonElement>('[data-primary-action]');
  const review = document.querySelector<HTMLButtonElement>('[data-review-action]');
  if (!status || !detail || !message || !results || !primary || !review) {
    return;
  }

  results.replaceChildren();
  message.hidden = true;
  primary.hidden = false;
  review.hidden = true;
  primary.disabled = false;

  if (state.name === 'UNSUPPORTED') {
    status.textContent = 'This page is not supported.';
    detail.textContent = state.message;
    primary.hidden = true;
  } else if (state.name === 'READY') {
    status.textContent = 'Ready to generate';
    detail.textContent = `${state.page.questionCount} question${state.page.questionCount === 1 ? '' : 's'} on page ${state.page.pageId}.`;
    primary.textContent = 'Generate & Auto-Fill';
  } else if (state.name === 'GENERATING') {
    status.textContent = 'Generating answers...';
    detail.textContent = 'Working with the current page.';
    primary.textContent = 'Generating...';
    primary.disabled = true;
  } else if (state.name === 'ERROR') {
    status.textContent = "Couldn't generate answers.";
    detail.textContent = state.page ? `Page ${state.page.pageId}` : '';
    message.textContent = state.message;
    message.hidden = false;
    primary.textContent = 'Retry';
  } else {
    if ('status' in state.result) {
      status.textContent = 'Answers already settled';
      detail.textContent = `Reused answers for page ${state.result.pageId}.`;
      primary.textContent = 'Already settled';
      primary.disabled = true;
      return;
    }
    status.textContent = state.name === 'REVIEW' ? 'Review answers' : 'Answers filled';
    detail.textContent = state.name === 'REVIEW'
      ? 'Review the values in Google Forms before continuing.'
      : 'Review answers before clicking Next in Google Forms.';
    primary.textContent = 'Regenerate';
    review.hidden = state.name !== 'REVIEW';
    const fragment = document.createDocumentFragment();
    for (const outcome of state.result.fillReport.outcomes) {
      const item = document.createElement('p');
      item.className = `result result-${outcome.status.toLowerCase()}`;
      item.textContent = `${outcome.questionId ?? 'Question'}: ${outcome.status.replace(/_/g, ' ')}`;
      fragment.append(item);
    }
    results.append(fragment);
    results.hidden = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  log(`${EXTENSION_NAME} popup initialized.`);
  const controller = new PopupController(createBrowserPopupWorkflow());
  const primary = document.querySelector<HTMLButtonElement>('[data-primary-action]');
  const review = document.querySelector<HTMLButtonElement>('[data-review-action]');
  if (!primary || !review) {
    return;
  }
  primary.addEventListener('click', async () => {
    render(await controller.generate());
  });
  review.addEventListener('click', () => render(controller.finishReview()));
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'p7-state-updated' && message.snapshot) {
      render(controller.restore(message.snapshot as WorkflowSnapshot));
    }
  });
  render(await controller.discover());
});
