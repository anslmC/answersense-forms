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
import {
  createAllOverrideIntent,
  createSpecificOverrideIntent,
  filledSupportedQuestions,
  overrideQuestionLabel,
  type UiState,
  type WorkflowSnapshot,
} from './State';
import {
  createOverrideFilledIntent,
  type GenerationIntent,
} from '../Generation/Intent';

export interface WorkflowAppOptions {
  root?: ParentNode;
  onState?: (state: UiState) => void;
  onOverrideIntent?: (intent: GenerationIntent) => void;
  surface?: 'popup' | 'overlay';
}

export interface WorkflowAppHandle {
  refresh: () => Promise<void>;
}

export function mountAnswerSenseApp(
  options: WorkflowAppOptions = {}
): WorkflowAppHandle {
  log(`${EXTENSION_NAME} UI initialized.`);
  const scope: ParentNode = options.root ?? document;
  const ownerDocument = scope instanceof Document ? scope : scope.ownerDocument;
  const element = <T extends HTMLElement>(selector: string): T | null =>
    scope.querySelector<T>(selector);
  const createElement = (name: string): HTMLElement =>
    (ownerDocument ?? document).createElement(name);

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
  let pendingOverrideIntent: GenerationIntent | null = null;
  let pendingAllQuestionIds: readonly string[] | null = null;
  let selectedSpecificQuestionIds: string[] = [];

  const controller = new PopupController(createBrowserPopupWorkflow());
  let primaryAction: HTMLButtonElement | null = null;
  let primaryActionContainer: HTMLElement | null = null;

  function renderGeneration(state: UiState): void {
    const status = element<HTMLElement>('[data-status]');
    const detail = element<HTMLElement>('[data-detail]');
    const message = element<HTMLElement>('[data-message]');
    const results = element<HTMLElement>('[data-results]');
    const primary =
      primaryAction ?? element<HTMLButtonElement>('[data-primary-action]');
    const filledStatus = element<HTMLElement>('[data-filled-status]');
    const progress = element<HTMLElement>('[data-workflow-progress]');
    const progressBar = element<HTMLElement>('[data-workflow-progress-bar]');
    const progressText = element<HTMLElement>('[data-workflow-progress-text]');
    const progressFill = element<HTMLElement>('[data-workflow-progress-fill]');
    const overlayPanel = scope instanceof HTMLElement ? scope.parentElement : null;
    if (
      !status ||
      !detail ||
      !message ||
      !results ||
      !primary ||
      !filledStatus ||
      !progress ||
      !progressBar ||
      !progressText ||
      !progressFill
    )
      return;
    primaryAction = primary;
    primaryActionContainer ??= primary.parentElement;

    if (overlayPanel) {
      overlayPanel.classList.toggle('is-generating', state.name === 'GENERATING');
    }

    if (overrideAction) {
      const hideOverride = state.name !== 'REVIEW';
      overrideAction.toggleAttribute('hidden', hideOverride);
      overrideAction.disabled = state.name === 'GENERATING';
    }

    results.replaceChildren();
    results.hidden = true;
    message.hidden = true;
    filledStatus.textContent = 'Filled';
    filledStatus.classList.remove('is-settled');
    if (state.name === 'REVIEW') {
      primary.remove();
    } else {
      primaryActionContainer?.insertBefore(primary, filledStatus);
      primary.hidden = false;
    }
    filledStatus.hidden = true;
    progress.hidden = true;
    progress.classList.remove('is-processing', 'is-complete', 'is-partial', 'is-error');
    progressText.textContent = '';
    primary.disabled = !isCurrentValidationValid(configurationState);
    if (state.name === 'UNSUPPORTED') {
      status.textContent = 'This page is not supported.';
      detail.textContent = state.message;
      primary.hidden = true;
    } else if (state.name === 'READY') {
      if (state.page.questionCount === 0) {
        progress.hidden = true;
      }
      status.textContent = primary.disabled
        ? 'Ready to configure'
        : 'Ready to generate';
      detail.textContent = `${state.page.questionCount} question${state.page.questionCount === 1 ? '' : 's'} on page ${state.page.pageId}.`;
      primary.textContent = 'Generate & Auto-Fill';
    } else if (state.name === 'GENERATING') {
      progress.hidden = false;
      progress.classList.remove('is-complete', 'is-partial', 'is-error');
      progress.classList.add('is-processing');
      progressFill.style.width = '';
      progressBar.removeAttribute('aria-valuetext');
      progressText.textContent = 'Processing page…';
      progressBar.setAttribute('aria-label', 'Generate and Auto-Fill progress');
      status.textContent = 'Generating answers...';
      detail.textContent = 'Working with the current page.';
      primary.textContent = 'Generating...';
      primary.disabled = true;
    } else if (state.name === 'ERROR') {
      progress.hidden = false;
      progress.classList.add('is-error');
      progressBar.setAttribute('aria-valuetext', 'Failed');
      progressText.textContent = 'Failed';
      progressFill.style.width = '100%';
      status.textContent = "Couldn't generate answers.";
      detail.textContent = state.page ? `Page ${state.page.pageId}` : '';
      message.textContent = state.message;
      message.hidden = false;
      primary.hidden = true;
    } else {
      if ('status' in state.result) {
        status.textContent = 'Answers already settled';
        detail.textContent = `Reused answers for page ${state.result.pageId}.`;
        filledStatus.textContent = 'Page Answers already settled';
        filledStatus.classList.add('is-settled');
        filledStatus.hidden = false;
        return;
      }
      progress.hidden = false;
      progress.classList.add('is-complete');
      progressBar.setAttribute('aria-valuetext', 'Completed');
      progressText.textContent = 'Completed';
      progressFill.style.width = '100%';
      status.textContent =
        state.name === 'REVIEW' ? 'Review answers' : 'Answers filled';
      detail.textContent =
        state.name === 'REVIEW'
          ? 'Review the values in Google Forms before continuing.'
          : 'Review answers before clicking Next in Google Forms.';
      primary.hidden = true;
      const outcomes = state.result.fillReport.outcomes;
      const filledCount = outcomes.filter(
        ({ status }) => status === 'FILLED'
      ).length;
      const failedCount = outcomes.filter(
        ({ status }) => status === 'FILL_FAILED' || status === 'PARTIAL_FILL'
      ).length;
      const skippedCount = outcomes.filter(
        ({ status }) => status === 'SKIPPED'
      ).length;

      const summary = createElement('p');
      summary.className = 'result-summary';
      summary.textContent = `${filledCount} filled · ${failedCount} failed · ${skippedCount} skipped`;
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
    const replaceCredentialSelect = element<HTMLSelectElement>(
      '[data-replace-credential-select]'
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

    if (replaceCredentialSelect) {
      replaceCredentialSelect.replaceChildren();
      const replaceableCredentials = configurationState.credentials.filter(
        (item) => item.providerId === providerSelect.value
      );
      if (!replaceableCredentials.length) {
        replaceCredentialSelect.add(new Option('No API keys added yet', ''));
      }
      for (const credential of replaceableCredentials) {
        replaceCredentialSelect.add(
          new Option(credential.label || 'Unnamed API key', credential.credentialId)
        );
      }
    }

    credentialStatus.textContent = configurationState.credentials.length
      ? `${configurationState.credentials.length} API key${configurationState.credentials.length === 1 ? '' : 's'} stored.`
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
      | Record<string, unknown>
      | undefined;
    if (response?.error) throw new Error(String(response.error));
    return response ?? {};
  }

  async function reloadConfiguration(): Promise<void> {
    configurationState = (await send({
      type: 'configuration-state',
    })) as unknown as PopupConfigurationState;
    renderAll(controller.state);
  }

  function showMessage(selector: string, text: string): void {
    const message = element<HTMLElement>(selector);
    if (message) {
      message.textContent = text;
      message.hidden = false;
    }
  }

  const primary = element<HTMLButtonElement>('[data-primary-action]');
  const forceClear = element<HTMLButtonElement>('[data-force-clear]');
  const providerSelect = element<HTMLSelectElement>('[data-provider-select]');
  const modelSelect = element<HTMLSelectElement>('[data-model-select]');
  const credentialSelect = element<HTMLSelectElement>(
    '[data-credential-select]'
  );
  const replaceCredentialSelect = element<HTMLSelectElement>(
    '[data-replace-credential-select]'
  );
  const credentialLabel = element<HTMLInputElement>('[data-credential-label]');
  const credentialSecret = element<HTMLInputElement>(
    '[data-credential-secret]'
  );
  const replaceCredentialSecret = element<HTMLInputElement>(
    '[data-replace-credential-secret]'
  );
  const addCredentialForm = element<HTMLElement>('[data-add-credential-form]');
  const replaceCredentialForm = element<HTMLElement>(
    '[data-replace-credential-form]'
  );
  const addCredentialButton = element<HTMLButtonElement>('[data-add-credential]');
  const replaceCredentialButton = element<HTMLButtonElement>(
    '[data-replace-credential]'
  );
  if (!primary || !forceClear) return { refresh: async () => undefined };

  const overrideAction = element<HTMLButtonElement>('[data-override-action]');
  const overrideAll = element<HTMLButtonElement>('[data-override-all]');
  const overrideSpecific = element<HTMLButtonElement>('[data-override-specific]');
  const overrideConfirmation = element<HTMLElement>('[data-override-confirmation]');
  const overrideConfirmationText = element<HTMLElement>('[data-override-confirmation-text]');
  const overrideCancel = element<HTMLButtonElement>('[data-override-cancel]');
  const overrideConfirm = element<HTMLButtonElement>('[data-override-confirm]');
  const overrideMessage = element<HTMLElement>('[data-override-message]');

  function publishOverrideIntent(intent: GenerationIntent): void {
    const frozenIntent =
      intent.type === 'OVERRIDE_FILLED'
        ? createOverrideFilledIntent(intent.selectedQuestionIds)
        : intent;
    pendingOverrideIntent = frozenIntent;
    options.onOverrideIntent?.(frozenIntent);
  }

  function renderSpecificQuestions(): void {
    const list = element<HTMLElement>('[data-override-specific-list]');
    const state = controller.state;
    if (!list || state.name === 'UNSUPPORTED' || !state.page) return;
    const filledQuestions = filledSupportedQuestions(state.page);
    list.replaceChildren();
    for (const [index, question] of filledQuestions.entries()) {
      const label = createElement('label');
      const checkbox = createElement('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.value = question.id as string;
      checkbox.checked = selectedSpecificQuestionIds.includes(checkbox.value);
      checkbox.addEventListener('change', () => {
        selectedSpecificQuestionIds = selectedSpecificQuestionIds.filter(
          (questionId) => questionId !== checkbox.value
        );
        if (checkbox.checked) selectedSpecificQuestionIds.push(checkbox.value);
        if (selectedSpecificQuestionIds.length > 0) {
          publishOverrideIntent(
            createSpecificOverrideIntent(selectedSpecificQuestionIds)
          );
          if (overrideConfirmationText) {
            overrideConfirmationText.textContent =
              `Override ${selectedSpecificQuestionIds.length} filled answer${selectedSpecificQuestionIds.length === 1 ? '' : 's'}?`;
          }
          overrideConfirmation?.removeAttribute('hidden');
        } else {
          pendingOverrideIntent = null;
          overrideConfirmation?.setAttribute('hidden', '');
        }
      });
      label.append(checkbox, overrideQuestionLabel(question, index));
      list.append(label);
    }
    list.removeAttribute('hidden');
  }

  overrideAction?.addEventListener('click', () => {
    const flow = element<HTMLElement>('[data-override-flow]');
    if (!flow || controller.state.name === 'UNSUPPORTED') return;
    const shouldOpen = flow.hidden;
    flow.toggleAttribute('hidden', !shouldOpen);
    if (shouldOpen) {
      pendingAllQuestionIds = null;
      pendingOverrideIntent = null;
      element<HTMLElement>('[data-override-confirmation]')?.setAttribute('hidden', '');
      element<HTMLElement>('[data-override-specific-list]')?.setAttribute('hidden', '');
      if (overrideMessage) overrideMessage.textContent = '';
    }
  });
  overrideAll?.addEventListener('click', () => {
    if (controller.state.name === 'UNSUPPORTED' || !controller.state.page) return;
    const intent = createAllOverrideIntent(controller.state.page);
    if (intent.type !== 'OVERRIDE_FILLED') return;
    const selected = [...intent.selectedQuestionIds];
    pendingAllQuestionIds = selected;
    if (overrideConfirmationText) {
      overrideConfirmationText.textContent =
        `Override ${selected.length} filled answer${selected.length === 1 ? '' : 's'}?`;
    }
    overrideConfirmation?.removeAttribute('hidden');
  });
  overrideSpecific?.addEventListener('click', renderSpecificQuestions);
  overrideCancel?.addEventListener('click', () => {
    pendingOverrideIntent = null;
    pendingAllQuestionIds = null;
    overrideConfirmation?.setAttribute('hidden', '');
  });
  overrideConfirm?.addEventListener('click', () => {
    let intent: GenerationIntent | null = null;
    if (pendingAllQuestionIds) {
      intent = createOverrideFilledIntent(pendingAllQuestionIds);
    } else if (pendingOverrideIntent?.type === 'OVERRIDE_FILLED') {
      intent = pendingOverrideIntent;
    } else {
      return;
    }
    publishOverrideIntent(intent);
    pendingAllQuestionIds = null;
    overrideConfirmation?.setAttribute('hidden', '');
    if (overrideMessage) overrideMessage.textContent = 'Override selection ready.';
    void controller.generate(renderAll, intent).then((state) => renderAll(state));
  });

  if (
    providerSelect &&
    modelSelect &&
    credentialSelect &&
    credentialLabel &&
    credentialSecret &&
    replaceCredentialSecret &&
    replaceCredentialSelect &&
    addCredentialForm &&
    replaceCredentialForm &&
    addCredentialButton &&
    replaceCredentialButton
  ) {

    const addCredentialFormElement = addCredentialForm;
    const replaceCredentialFormElement = replaceCredentialForm;
    const credentialLabelElement = credentialLabel;
    const credentialSecretElement = credentialSecret;
    const replaceCredentialSecretElement = replaceCredentialSecret;
    const replaceCredentialSelectElement = replaceCredentialSelect;
    const providerSelectElement = providerSelect;

    function hideCredentialForms(): void {
      addCredentialFormElement.hidden = true;
      replaceCredentialFormElement.hidden = true;
      credentialLabelElement.value = '';
      credentialSecretElement.value = '';
      replaceCredentialSecretElement.value = '';
      replaceCredentialSelectElement.replaceChildren();
      replaceCredentialSelectElement.disabled = false;
      replaceCredentialSelectElement.value = '';
    }

    function openAddCredentialForm(): void {
      hideCredentialForms();
      addCredentialFormElement.hidden = false;
    }

    function openReplaceCredentialForm(): void {
      hideCredentialForms();
      replaceCredentialFormElement.hidden = false;
      replaceCredentialSelectElement.replaceChildren();
      const providerCredentials = configurationState.credentials.filter(
        (item) => item.providerId === providerSelectElement.value
      );
      if (!providerCredentials.length) {
        replaceCredentialSelectElement.add(
          new Option('No API keys added yet', '')
        );
        replaceCredentialSelectElement.disabled = true;
      } else {
        replaceCredentialSelectElement.disabled = false;
        for (const credential of providerCredentials) {
          replaceCredentialSelectElement.add(
            new Option(
              credential.label || 'Unnamed API key',
              credential.credentialId
            )
          );
        }
      }
    }

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

    addCredentialButton.addEventListener('click', () => {
      openAddCredentialForm();
    });
    replaceCredentialButton.addEventListener('click', () => {
      openReplaceCredentialForm();
    });

    element<HTMLButtonElement>('[data-save-add-credential]')?.addEventListener(
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
          hideCredentialForms();
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
    element<HTMLButtonElement>('[data-cancel-add-credential]')?.addEventListener(
      'click',
      () => {
        hideCredentialForms();
      }
    );
    element<HTMLButtonElement>('[data-save-replace-credential]')?.addEventListener(
      'click',
      async () => {
        try {
          const selectedCredentialId = replaceCredentialSelect.value;
          if (!selectedCredentialId) {
            showMessage(
              '[data-credential-message]',
              'Select an existing API key to replace.'
            );
            return;
          }
          const selectedCredential = configurationState.credentials.find(
            (credential) => credential.credentialId === selectedCredentialId
          );
          await send({
            type: 'credential-replace',
            credentialId: selectedCredentialId,
            providerId: providerSelect.value,
            label: selectedCredential?.label || 'Unnamed API key',
            secret: replaceCredentialSecret.value,
          });
          replaceCredentialSecret.value = '';
          credentialLabel.value = '';
          hideCredentialForms();
          await reloadConfiguration();
          showMessage(
            '[data-credential-message]',
            'API key replaced. Validate the configuration again.'
          );
        } catch (error) {
          showMessage(
            '[data-credential-message]',
            error instanceof Error ? error.message : 'API key could not be replaced.'
          );
        }
      }
    );
    element<HTMLButtonElement>('[data-cancel-replace-credential]')?.addEventListener(
      'click',
      () => {
        hideCredentialForms();
      }
    );
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
            error instanceof Error ? error.message : 'Configuration could not be saved.'
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
            error instanceof Error ? error.message : 'API key could not be deleted.'
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
            error instanceof Error ? error.message : 'Configuration validation failed.'
          );
        } finally {
          validating = false;
          renderConfiguration();
          renderGeneration(controller.state);
        }
      }
    );
  }
  primary.addEventListener('click', () => {
    if (!isCurrentValidationValid(configurationState)) return;
    void controller.generate(renderAll).then((state) => renderAll(state));
  });
  forceClear.addEventListener('click', async () => {
    forceClear.disabled = true;
    renderAll(await controller.forceClear());
    forceClear.disabled = false;
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'p7-state-updated' && message.snapshot) {
      const state = controller.restore(message.snapshot as WorkflowSnapshot);
      options.onState?.(state);
      renderAll(state);
    }
  });

  async function refresh(): Promise<void> {
    await Promise.all([
      reloadConfiguration(),
      controller.discover().then((state) => {
      options.onState?.(state);
      renderAll(state);
      }),
    ]);
  }

  void refresh();

  return { refresh };
}
