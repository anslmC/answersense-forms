import { EXTENSION_NAME, log } from '../Shared/Utils';
import { PopupController } from './Controller';
import {
  isCurrentValidationValid,
  authorizationStatus,
  modelsForProvider,
  validGenerationMessage,
  type PopupConfigurationState,
} from './Configuration';
import { createBrowserPopupWorkflow } from './Workflow';
import type { UiState, WorkflowSnapshot } from './State';

let configurationState: PopupConfigurationState = {
  providers: [],
  credentials: [],
  activeConfiguration: null,
  configurationDigest: null,
  configurationRevision: 0,
  validation: null,
};
let validating = false;
let configurationDirty = false;

function element<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function renderGeneration(state: UiState): void {
  const status = element<HTMLElement>('[data-status]');
  const detail = element<HTMLElement>('[data-detail]');
  const message = element<HTMLElement>('[data-message]');
  const results = element<HTMLElement>('[data-results]');
  const primary = element<HTMLButtonElement>('[data-primary-action]');
  const review = element<HTMLButtonElement>('[data-review-action]');
  if (!status || !detail || !message || !results || !primary || !review) return;

  results.replaceChildren();
  results.hidden = true;
  message.hidden = true;
  primary.hidden = false;
  review.hidden = true;
  primary.disabled = !isCurrentValidationValid(configurationState);
  if (state.name === 'UNSUPPORTED') {
    status.textContent = 'This page is not supported.';
    detail.textContent = state.message;
    primary.hidden = true;
  } else if (state.name === 'READY') {
    status.textContent = primary.disabled
      ? 'Ready to configure'
      : 'Ready to generate';
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
    status.textContent =
      state.name === 'REVIEW' ? 'Review answers' : 'Answers filled';
    detail.textContent =
      state.name === 'REVIEW'
        ? 'Review the values in Google Forms before continuing.'
        : 'Review answers before clicking Next in Google Forms.';
    primary.textContent = 'Regenerate';
    review.hidden = state.name !== 'REVIEW';
    const outcomes = state.result.fillReport.outcomes;
    const filledCount = outcomes.filter(
      ({ status }) => status === 'FILLED'
    ).length;
    const alreadyFilledCount = outcomes.filter(
      ({ status }) => status === 'PRESERVED_EXISTING'
    ).length;
    const failedCount = outcomes.filter(
      ({ status }) => status === 'FILL_FAILED' || status === 'PARTIAL_FILL'
    ).length;

    const summary = document.createElement('p');
    summary.className = 'result-summary';
    summary.textContent = `${filledCount} filled · ${alreadyFilledCount} already filled · ${failedCount} failed`;
    results.append(summary);
    results.hidden = false;
  }
}

function renderValidationAvailability(): void {
  const validateButton = element<HTMLButtonElement>(
    '[data-validate-configuration]'
  );
  const unsavedConfiguration = element<HTMLElement>(
    '[data-unsaved-configuration]'
  );
  if (!validateButton || !unsavedConfiguration) return;

  unsavedConfiguration.hidden = !configurationDirty;
  validateButton.disabled =
    validating || !configurationState.activeConfiguration || configurationDirty;
}

function renderConfiguration(): void {
  const providerSelect = element<HTMLSelectElement>('[data-provider-select]');
  const modelSelect = element<HTMLSelectElement>('[data-model-select]');
  const credentialSelect = element<HTMLSelectElement>(
    '[data-credential-select]'
  );
  const validationStatusElement = element<HTMLElement>(
    '[data-validation-status]'
  );
  const credentialStatus = element<HTMLElement>('[data-credential-status]');
  if (
    !providerSelect ||
    !modelSelect ||
    !credentialSelect ||
    !validationStatusElement ||
    !credentialStatus
  )
    return;

  const active = configurationState.activeConfiguration;
  providerSelect.replaceChildren();
  for (const provider of configurationState.providers) {
    providerSelect.add(new Option(provider.displayName, provider.providerId));
  }
  if (active?.providerId) providerSelect.value = active.providerId;
  const models = modelsForProvider(configurationState, providerSelect.value);
  modelSelect.replaceChildren();
  for (const model of models)
    modelSelect.add(new Option(model.displayName, model.modelId));
  if (active?.modelId) modelSelect.value = active.modelId;

  credentialSelect.replaceChildren();
  const providerCredentials = configurationState.credentials.filter(
    (item) => item.providerId === providerSelect.value
  );
  if (!providerCredentials.length) {
    credentialSelect.add(new Option('No API keys added yet', ''));
  }
  for (const credential of providerCredentials) {
    credentialSelect.add(
      new Option(credential.label || 'Unnamed API key', credential.credentialId)
    );
  }
  if (active?.credentialId) credentialSelect.value = active.credentialId;
  credentialStatus.textContent = configurationState.credentials.length
    ? `${configurationState.credentials.length} credential${configurationState.credentials.length === 1 ? '' : 's'} stored.`
    : 'Add an API key to configure a provider.';
  validationStatusElement.textContent = authorizationStatus(
    configurationState,
    validating,
    configurationDirty
  );
  const validationMessage = element<HTMLElement>('[data-validation-message]');
  if (validationMessage) {
    const generationMessage = validGenerationMessage(configurationState);
    if (generationMessage) {
      validationMessage.textContent = generationMessage;
      validationMessage.hidden = false;
    } else if (
      validationMessage.textContent ===
      'Configuration is valid. Generate is available on a supported page.'
    ) {
      validationMessage.textContent = '';
      validationMessage.hidden = true;
    }
  }
  renderValidationAvailability();
}

function renderAll(state: UiState): void {
  renderConfiguration();
  renderGeneration(state);
}

async function send(
  message: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = (await chrome.runtime.sendMessage(message)) as
    Record<string, unknown> | undefined;
  if (response?.error) throw new Error(String(response.error));
  return response ?? {};
}

async function reloadConfiguration(): Promise<void> {
  configurationState = (await send({
    type: 'configuration-state',
  })) as unknown as PopupConfigurationState;
  renderConfiguration();
}

function showMessage(selector: string, text: string): void {
  const message = element<HTMLElement>(selector);
  if (message) {
    message.textContent = text;
    message.hidden = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  log(`${EXTENSION_NAME} popup initialized.`);
  const controller = new PopupController(createBrowserPopupWorkflow());
  const primary = element<HTMLButtonElement>('[data-primary-action]');
  const review = element<HTMLButtonElement>('[data-review-action]');
  const providerSelect = element<HTMLSelectElement>('[data-provider-select]');
  const modelSelect = element<HTMLSelectElement>('[data-model-select]');
  const credentialSelect = element<HTMLSelectElement>(
    '[data-credential-select]'
  );
  const credentialLabel = element<HTMLInputElement>('[data-credential-label]');
  const credentialSecret = element<HTMLInputElement>(
    '[data-credential-secret]'
  );
  if (
    !primary ||
    !review ||
    !providerSelect ||
    !modelSelect ||
    !credentialSelect ||
    !credentialLabel ||
    !credentialSecret
  )
    return;

  providerSelect.addEventListener('change', () => {
    configurationDirty = true;
    modelSelect.replaceChildren(
      ...modelsForProvider(configurationState, providerSelect.value).map(
        (model) => new Option(model.displayName, model.modelId)
      )
    );
    const credentials = configurationState.credentials.filter(
      (item) => item.providerId === providerSelect.value
    );
    credentialSelect.replaceChildren(
      ...(credentials.length
        ? credentials.map(
            (credential) =>
              new Option(
                credential.label || 'Unnamed API key',
                credential.credentialId
              )
          )
        : [new Option('No API keys added yet', '')])
    );
    renderValidationAvailability();
  });
  modelSelect.addEventListener('change', () => {
    configurationDirty = true;
    renderValidationAvailability();
  });
  credentialSelect.addEventListener('change', () => {
    configurationDirty = true;
    renderValidationAvailability();
  });
  element<HTMLButtonElement>('[data-save-configuration]')?.addEventListener(
    'click',
    async () => {
      try {
        configurationState = (await send({
          type: 'configuration-set',
          providerId: providerSelect.value,
          modelId: modelSelect.value,
          credentialId: credentialSelect.value,
        })) as unknown as PopupConfigurationState;
        configurationDirty = false;
        showMessage(
          '[data-validation-message]',
          'Configuration saved. Validate it before generating.'
        );
        renderAll(controller.state);
      } catch (error) {
        showMessage(
          '[data-validation-message]',
          error instanceof Error
            ? error.message
            : 'Configuration could not be saved.'
        );
      }
    }
  );
  element<HTMLButtonElement>('[data-add-credential]')?.addEventListener(
    'click',
    async () => {
      try {
        await send({
          type: 'credential-create',
          providerId: providerSelect.value,
          label: credentialLabel.value,
          secret: credentialSecret.value,
        });
        credentialSecret.value = '';
        credentialLabel.value = '';
        await reloadConfiguration();
        showMessage('[data-credential-message]', 'API key added.');
      } catch (error) {
        showMessage(
          '[data-credential-message]',
          error instanceof Error ? error.message : 'API key could not be added.'
        );
      }
    }
  );
  element<HTMLButtonElement>('[data-replace-credential]')?.addEventListener(
    'click',
    async () => {
      try {
        await send({
          type: 'credential-replace',
          credentialId: credentialSelect.value,
          providerId: providerSelect.value,
          label: credentialLabel.value,
          secret: credentialSecret.value,
        });
        credentialSecret.value = '';
        credentialLabel.value = '';
        await reloadConfiguration();
        showMessage(
          '[data-credential-message]',
          'API key replaced. Validate the configuration again.'
        );
      } catch (error) {
        showMessage(
          '[data-credential-message]',
          error instanceof Error
            ? error.message
            : 'API key could not be replaced.'
        );
      }
    }
  );
  element<HTMLButtonElement>('[data-delete-credential]')?.addEventListener(
    'click',
    async () => {
      try {
        for (const credential of configurationState.credentials) {
          await send({
            type: 'credential-delete-selected',
            credentialId: credential.credentialId,
          });
        }
        await reloadConfiguration();
        configurationDirty = false;
        renderAll(controller.state);
        showMessage('[data-credential-message]', 'API key deleted.');
      } catch (error) {
        showMessage(
          '[data-credential-message]',
          error instanceof Error
            ? error.message
            : 'API key could not be deleted.'
        );
      }
    }
  );
  element<HTMLButtonElement>('[data-validate-configuration]')?.addEventListener(
    'click',
    async () => {
      if (validating) return;
      validating = true;
      renderConfiguration();
      try {
        await send({ type: 'configuration-validate' });
        await reloadConfiguration();
      } catch (error) {
        await reloadConfiguration().catch(() => undefined);
        showMessage(
          '[data-validation-message]',
          error instanceof Error
            ? error.message
            : 'Configuration validation failed.'
        );
      } finally {
        validating = false;
        renderConfiguration();
        renderGeneration(controller.state);
      }
    }
  );
  primary.addEventListener('click', async () => {
    if (!isCurrentValidationValid(configurationState)) return;
    renderAll(await controller.generate());
  });
  review.addEventListener('click', () => renderAll(controller.finishReview()));
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'p7-state-updated' && message.snapshot) {
      renderAll(controller.restore(message.snapshot as WorkflowSnapshot));
    }
  });
  await reloadConfiguration();
  renderAll(await controller.discover());
});
