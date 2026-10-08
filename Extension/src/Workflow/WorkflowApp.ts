import { EXTENSION_NAME, log } from '../Shared/Utils';
import { WorkflowController } from './Controller';
import {
  isCurrentValidationValid,
  authorizationStatus,
  modelsForProvider,
  validGenerationMessage,
  type ConfigurationState,
} from './Configuration';
import { createBrowserWorkflow } from './Workflow';
import { GEMINI_MODEL } from '../Generation/GeminiProvider';
import {
  createAllOverrideIntent,
  createSpecificOverrideIntent,
  filledOverrideCandidates,
  overrideQuestionLabel,
  type GeneratedUiResult,
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
  onRefresh?: () => void | Promise<void>;
  surface?: 'popup' | 'overlay';
}

export interface WorkflowAppHandle {
  refresh: () => Promise<void>;
  ready: Promise<void>;
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

  let configurationState: ConfigurationState = {
    providers: [],
    credentials: [],
    activeConfiguration: null,
    configurationDigest: null,
    configurationRevision: 0,
    validation: null,
  };
  let validating = false;
  let preserveConfigurationDraft = false;
  let selectionLookupSequence = 0;
  let localGenerationSnapshotPending = false;
  let invalidatedGenerationOperationToken: number | null = null;
  let lockedConfigurationControls: Array<{
    control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
    disabled: boolean;
    title: string | null;
  }> | null = null;
  let pendingOverrideIntent: GenerationIntent | null = null;
  let pendingAllQuestionIds: readonly string[] | null = null;
  let selectedSpecificQuestionIds: string[] = [];

  const controller = new WorkflowController(createBrowserWorkflow());
  let primaryAction: HTMLButtonElement | null = null;
  let primaryActionContainer: HTMLElement | null = null;
  let overridePresentation: {
    normalResult: GeneratedUiResult;
    overrideResult: GeneratedUiResult;
  } | null = null;

  function selectedConfigurationMatchesActive(): boolean {
    const active = configurationState.activeConfiguration;
    return Boolean(
      active &&
      element<HTMLSelectElement>('[data-provider-select]')?.value ===
        active.providerId &&
      element<HTMLSelectElement>('[data-model-select]')?.value === active.modelId &&
      element<HTMLSelectElement>('[data-credential-select]')?.value ===
        active.credentialId
    );
  }

  function canGenerateCurrentSelection(): boolean {
    return (
      !validating &&
      selectedConfigurationMatchesActive() &&
      isCurrentValidationValid(configurationState)
    );
  }

  function configurationStateForSelection(): ConfigurationState {
    if (selectedConfigurationMatchesActive()) return configurationState;

    const selected = configurationState.selectedConfiguration;
    const selectionMatches = Boolean(
      selected &&
      element<HTMLSelectElement>('[data-provider-select]')?.value ===
        selected.providerId &&
      element<HTMLSelectElement>('[data-model-select]')?.value === selected.modelId &&
      element<HTMLSelectElement>('[data-credential-select]')?.value ===
        selected.credentialId
    );
    if (!selectionMatches || !selected) {
      return {
        ...configurationState,
        activeConfiguration: null,
        configurationDigest: null,
        validation: null,
      };
    }
    return {
      ...configurationState,
      activeConfiguration: selected,
      configurationDigest: configurationState.selectedConfigurationDigest ?? null,
      validation: configurationState.selectedValidation ?? null,
    };
  }

  function resetOverrideFlow(): void {
    const flow = element<HTMLElement>('[data-override-flow]');
    if (flow) flow.hidden = true;
    pendingOverrideIntent = null;
    pendingAllQuestionIds = null;
    selectedSpecificQuestionIds = [];
    element<HTMLElement>('[data-override-confirmation]')?.setAttribute('hidden', '');
    element<HTMLElement>('[data-override-specific-list]')?.setAttribute('hidden', '');
    const overrideMessage = element<HTMLElement>('[data-override-message]');
    if (overrideMessage) overrideMessage.textContent = '';
  }

  function resetGenerationForConfigurationChange(): void {
    if (localGenerationSnapshotPending) {
      invalidatedGenerationOperationToken =
        controller.stateMachine.activeOperationToken;
    }
    overridePresentation = null;
    resetOverrideFlow();
    const current = controller.state;
    const state = controller.stateMachine.setPage(
      current.name === 'UNSUPPORTED' ? null : current.page
    );
    options.onState?.(state);
    renderAll(state);
  }

  function appendRefreshAction(container: HTMLElement): void {
    const refresh = createElement('button') as HTMLButtonElement;
    refresh.type = 'button';
    refresh.className = 'override-failure-refresh';
    refresh.textContent = '↻';
    refresh.title = 'Refresh';
    refresh.setAttribute('aria-label', 'Refresh');
    refresh.addEventListener('click', () => {
      void options.onRefresh?.();
    });
    container.append(refresh);
  }

  function createValidationFailureInfoTooltip(
    tooltipText = 'Key was invalid. Please check if you entered the correct key.'
  ): HTMLElement {
    const infoTooltip = createElement('span');
    infoTooltip.className = 'validation-failure-info-tooltip';
    infoTooltip.dataset.tooltip = tooltipText;
    infoTooltip.setAttribute('role', 'img');
    infoTooltip.setAttribute('aria-label', tooltipText);
    infoTooltip.tabIndex = 0;

    const svgDocument = ownerDocument ?? document;
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const infoIcon = svgDocument.createElementNS(svgNamespace, 'svg');
    infoIcon.classList.add('validation-failure-info');
    infoIcon.setAttribute('fill', '#000000');
    infoIcon.setAttribute('viewBox', '0 0 22 22');
    infoIcon.setAttribute('id', 'memory-tooltip-end-alert');
    infoIcon.setAttribute('aria-hidden', 'true');
    infoIcon.setAttribute('focusable', 'false');

    const backgroundCarrier = svgDocument.createElementNS(svgNamespace, 'g');
    backgroundCarrier.setAttribute('id', 'SVGRepo_bgCarrier');
    backgroundCarrier.setAttribute('stroke-width', '0');

    const tracerCarrier = svgDocument.createElementNS(svgNamespace, 'g');
    tracerCarrier.setAttribute('id', 'SVGRepo_tracerCarrier');
    tracerCarrier.setAttribute('stroke-linecap', 'round');
    tracerCarrier.setAttribute('stroke-linejoin', 'round');

    const iconCarrier = svgDocument.createElementNS(svgNamespace, 'g');
    iconCarrier.setAttribute('id', 'SVGRepo_iconCarrier');
    const alertPath = svgDocument.createElementNS(svgNamespace, 'path');
    alertPath.setAttribute(
      'd',
      'M14 15H12V13H14V15M14 12H12V7H14V12M21 2V20H20V21H6V20H5V15H4V14H3V13H2V12H1V10H2V9H3V8H4V7H5V2H6V1H20V2H21M19 3H7V8H6V9H5V10H4V12H5V13H6V14H7V19H19V3Z'
    );
    iconCarrier.append(alertPath);
    infoIcon.append(backgroundCarrier, tracerCarrier, iconCarrier);
    infoTooltip.append(infoIcon);
    return infoTooltip;
  }

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
    const forceClearNote = element<HTMLElement>('[data-force-clear-note]');
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
    renderConfigurationGenerationLock(state.name === 'GENERATING');

    if (overrideAction) {
      const hideOverride =
        state.name !== 'REVIEW' || 'status' in state.result;
      overrideAction.toggleAttribute('hidden', hideOverride);
      overrideAction.disabled = state.name === 'GENERATING';
    }

    results.replaceChildren();
    results.hidden = true;
    message.hidden = true;
    filledStatus.textContent = 'Filled';
    filledStatus.classList.remove('is-settled');
    detail.classList.remove('settled-detail');
    if (forceClearNote) forceClearNote.hidden = true;
    if (state.name === 'READY') {
      primary.textContent = 'Generate & Auto-Fill';
      primary.disabled = !canGenerateCurrentSelection();
    }
    if (state.name === 'REVIEW') {
      primary.remove();
    } else {
      if (
        primary.parentElement !== primaryActionContainer ||
        primary.nextElementSibling !== filledStatus
      ) {
        primaryActionContainer?.insertBefore(primary, filledStatus);
      }
      primary.hidden = false;
    }
    filledStatus.hidden = true;
    element<HTMLButtonElement>('[data-force-clear]')?.toggleAttribute('hidden', true);
    progress.hidden = true;
    progress.classList.remove('is-processing', 'is-complete', 'is-partial', 'is-error');
    progressText.textContent = '';
    primary.disabled = !canGenerateCurrentSelection();
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
      const modelAccessErrorMessage =
        'This key or project doesn’t have access to the selected model. Check your API key and project permissions.';
      status.textContent =
        state.message === 'Server was busy. Try again.'
          ? state.message
          : "Couldn't generate answers.";
      detail.textContent = state.page ? `Page ${state.page.pageId}` : '';
      if (state.message === modelAccessErrorMessage) {
        message.replaceChildren(
          document.createTextNode(
            'This key or project doesn’t have access to the selected model.'
          ),
          createValidationFailureInfoTooltip(
            "Tip: Check your API key, account, and provider access. Some providers may restrict access to certain models or require specific permissions. Read the provider's policies to avoid key restrictions."
          ),
          document.createTextNode(' Check your API key and project permissions. ')
        );
      } else {
        message.textContent = state.message;
        message.append(document.createTextNode(' '));
      }
      appendRefreshAction(message);
      message.hidden = false;
      primary.hidden = true;
    } else {
      if ('status' in state.result) {
        status.textContent = 'Answers already settled';
        detail.textContent = `Reused answers for page ${state.result.pageId}.`;
        detail.classList.add('settled-detail');
        filledStatus.textContent = 'Page Answers already settled';
        filledStatus.classList.add('is-settled');
        filledStatus.hidden = false;
        element<HTMLButtonElement>('[data-force-clear]')?.toggleAttribute('hidden', false);
        if (forceClearNote) forceClearNote.hidden = false;
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
      const activeOverridePresentation =
        overridePresentation && state.result === overridePresentation.overrideResult
          ? overridePresentation
          : null;
      const isOverrideResult = activeOverridePresentation !== null;
      const summaryOutcomes = isOverrideResult
        ? activeOverridePresentation.normalResult.fillReport.outcomes.map((outcome) => {
            const overrideOutcome = activeOverridePresentation.overrideResult.fillReport.outcomes.find(
              (candidate) => candidate.questionId === outcome.questionId
            );
            return overrideOutcome ?? outcome;
          })
        : outcomes;
      const filledCount = summaryOutcomes.filter(
        ({ status }) => status === 'FILLED'
      ).length;
      const alreadyFilledCount = summaryOutcomes.filter(
        ({ status }) => status === 'PRESERVED_EXISTING'
      ).length;
      const failedCount = summaryOutcomes.filter(
        ({ status }) => status === 'FILL_FAILED' || status === 'PARTIAL_FILL'
      ).length;
      const skippedCount = summaryOutcomes.filter(
        ({ status }) => status === 'SKIPPED'
      ).length;
      const overridedCount =
        overridePresentation && state.result === overridePresentation.overrideResult
          ? overridePresentation.overrideResult.fillReport.outcomes.filter(
              ({ status }) => status === 'FILLED'
            ).length
          : 0;

      const summary = createElement('p');
      summary.className = 'result-summary';
      summary.textContent = `${filledCount} filled · ${alreadyFilledCount} already filled · ${failedCount} failed · ${skippedCount} skipped${overridedCount > 0 ? ` · ${overridedCount} overrided` : ''}`;
      results.append(summary);
      let hasFailureAction = false;
      if (isOverrideResult) {
        const failedOverrides = activeOverridePresentation.overrideResult.fillReport.outcomes.filter(
          (outcome) =>
            outcome.status === 'FILL_FAILED' &&
            typeof outcome.questionId === 'string'
        );
        if (failedOverrides.length > 0) {
          const labels = failedOverrides.map(({ questionId }) => {
            const questionIndex = state.page.questions?.findIndex(
              (question) => question.id === questionId
            );
            return questionIndex !== undefined && questionIndex >= 0
              ? `Q${questionIndex + 1}`
              : questionId as string;
          });
          const failureNote = createElement('p');
          failureNote.className = 'result-note override-failure';
          failureNote.append(`Override failed for ${labels.join(', ')}. `);
          appendRefreshAction(failureNote);
          hasFailureAction = true;
          results.append(failureNote);
          const failureDetail = createElement('p');
          failureDetail.className = 'result-note override-failure-detail';
          failureDetail.textContent = `${labels.join(' and ')} ${labels.length === 1 ? 'was' : 'were'} empty. Consider manually entering ${labels.length === 1 ? 'an answer' : 'answers'} or using Auto-Generate.`;
          results.append(failureDetail);
        }
      }
      if (failedCount > 0 && !hasFailureAction) {
        summary.append(document.createTextNode(' '));
        appendRefreshAction(summary);
      }
      if (state.name === 'REVIEW' && !('status' in state.result)) {
        const note = createElement('p');
        note.className = 'result-note all-filled-note';
        note.textContent =
          "All answers are already filled. Override is available if you want to replace them. Using Override will make another API call and replace the existing filled answer(s), whether they are correct or incorrect. Recommended: don't override every time to avoid rate limiting, unless your API key has no rate limit.";
        results.append(note);
      }
      results.hidden = false;
    }
  }

  function renderValidationAvailability(): void {
    const saveButton = element<HTMLButtonElement>(
      '[data-save-validate-configuration]'
    );
    const providerSelect = element<HTMLSelectElement>('[data-provider-select]');
    const modelSelect = element<HTMLSelectElement>('[data-model-select]');
    const credentialSelect = element<HTMLSelectElement>(
      '[data-credential-select]'
    );
    if (!saveButton || !providerSelect || !modelSelect || !credentialSelect) return;

    saveButton.disabled =
      validating ||
      !providerSelect.value ||
      !modelSelect.value ||
      !credentialSelect.value;
  }

  function renderConfigurationGenerationLock(isGenerating: boolean): void {
    if (isGenerating) {
      if (lockedConfigurationControls) return;
      lockedConfigurationControls = Array.from(
        scope.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >(
          '[data-configuration-content] button, [data-configuration-content] input, [data-configuration-content] select'
        )
      ).map((control) => ({
        control,
        disabled: control.disabled,
        title: control.getAttribute('title'),
      }));
      for (const { control } of lockedConfigurationControls) {
        control.disabled = true;
        control.title = 'Generation in progress';
      }
      return;
    }

    if (!lockedConfigurationControls) return;
    for (const { control, disabled, title } of lockedConfigurationControls) {
      control.disabled = disabled;
      if (title === null) {
        control.removeAttribute('title');
      } else {
        control.setAttribute('title', title);
      }
    }
    lockedConfigurationControls = null;
  }

  function renderConfiguration(): void {
    const configurationGuidance = element<HTMLElement>(
      '[data-configuration-guidance]'
    );
    const providerSelect = element<HTMLSelectElement>('[data-provider-select]');
    const modelSelect = element<HTMLSelectElement>('[data-model-select]');
    const credentialSelect = element<HTMLSelectElement>(
      '[data-credential-select]'
    );
    const replaceCredentialSelect = element<HTMLSelectElement>(
      '[data-replace-credential-select]'
    );
    const configurationStatus = element<HTMLElement>(
      '[data-configuration-status]'
    );
    const credentialStatus = element<HTMLElement>('[data-credential-status]');
    if (
      !providerSelect ||
      !modelSelect ||
      !credentialSelect ||
      !configurationStatus ||
      !credentialStatus
    )
      return;

    const active = configurationState.activeConfiguration;
    const previousProviderId = providerSelect.value;
    const previousModelId = modelSelect.value;
    const previousCredentialId = credentialSelect.value;
    providerSelect.replaceChildren();
    for (const provider of configurationState.providers) {
      providerSelect.add(new Option(provider.displayName, provider.providerId));
    }
    providerSelect.value = preserveConfigurationDraft && configurationState.providers.some(
      (provider) => provider.providerId === previousProviderId
    )
      ? previousProviderId
      : (configurationState.providers.some(
            (provider) => provider.providerId === active?.providerId
          )
          ? active?.providerId
          : configurationState.providers[0]?.providerId) ?? '';
    const models = modelsForProvider(configurationState, providerSelect.value);
    modelSelect.replaceChildren();
    for (const model of models)
      modelSelect.add(new Option(model.displayName, model.modelId));
    const selectedModelId = preserveConfigurationDraft && models.some(
      (model) => model.modelId === previousModelId
    )
      ? previousModelId
      : models.some((model) => model.modelId === active?.modelId)
        ? active?.modelId
        : undefined;
    modelSelect.value =
      selectedModelId ??
      (models.some((model) => model.modelId === GEMINI_MODEL)
        ? GEMINI_MODEL
        : models[0]?.modelId ?? '');

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
    credentialSelect.value = preserveConfigurationDraft && providerCredentials.some(
      (credential) => credential.credentialId === previousCredentialId
    )
      ? previousCredentialId
      : (providerCredentials.some(
            (credential) => credential.credentialId === active?.credentialId
          )
          ? active?.credentialId
          : providerCredentials[0]?.credentialId) ?? '';

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
    if (configurationGuidance) {
      configurationGuidance.textContent =
        (selectedConfigurationMatchesActive()
          ? validGenerationMessage(configurationState)
          : null) ??
        'Configure the extension before generating.';
    }
    const configurationStatusText = authorizationStatus(
      configurationStateForSelection(),
      validating,
      !selectedConfigurationMatchesActive()
    );
    const isValidationSuccessful = configurationStatusText === 'Already validated.';
    const needsResave =
      configurationStatusText ===
      'Already validated. Save & Validate to use this configuration.';
    const isNotValidatedAndNotSaved =
      configurationStatusText ===
      'Unsaved changes. Save & Validate to use this configuration.';
    const isValidationFailure =
      configurationStatusText ===
      'Validation failed. Save & Validate to try again.';
    if (needsResave) {
      const resaveStatus = createElement('span');
      resaveStatus.dataset.resaveStatus = '';
      resaveStatus.textContent = 'Status: Valid — re-save needed';
      configurationStatus.replaceChildren(
        resaveStatus,
        document.createTextNode(' Save & Validate to use this configuration.')
      );
    } else if (isNotValidatedAndNotSaved) {
      const unsavedStatus = createElement('span');
      unsavedStatus.dataset.unsavedStatus = '';
      unsavedStatus.textContent = 'Status: Not validated and not saved';
      configurationStatus.replaceChildren(
        unsavedStatus,
        document.createTextNode(' Save & Validate to use this configuration.')
      );
    } else if (isValidationFailure) {
      const failureStatus = createElement('span');
      failureStatus.dataset.validationFailureStatus = '';
      failureStatus.textContent = 'Validation failed';

      configurationStatus.replaceChildren(
        failureStatus,
        document.createTextNode(' '),
        createValidationFailureInfoTooltip(),
        document.createTextNode(' Save & Validate to try again.')
      );
    } else {
      configurationStatus.textContent = isValidationSuccessful
        ? 'Status: Valid'
        : configurationStatusText;
    }
    configurationStatus.classList.toggle(
      'is-validation-success',
      isValidationSuccessful
    );
    configurationStatus.classList.toggle('is-resave-warning', needsResave);
    configurationStatus.classList.toggle(
      'is-unsaved-warning',
      isNotValidatedAndNotSaved
    );
    configurationStatus.classList.toggle(
      'is-validation-failure',
      isValidationFailure
    );
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

  async function reloadConfiguration(shouldRender = true): Promise<void> {
    selectionLookupSequence += 1;
    configurationState = (await send({
      type: 'configuration-state',
    })) as unknown as ConfigurationState;
    preserveConfigurationDraft = false;
    if (shouldRender) {
      renderAll(controller.state);
    }
  }

  async function refreshSelectedConfigurationValidation(): Promise<void> {
    const selectedConfiguration = {
      providerId: element<HTMLSelectElement>('[data-provider-select]')?.value ?? '',
      modelId: element<HTMLSelectElement>('[data-model-select]')?.value ?? '',
      credentialId:
        element<HTMLSelectElement>('[data-credential-select]')?.value ?? '',
    };
    const lookupSequence = ++selectionLookupSequence;
    if (
      !selectedConfiguration.providerId ||
      !selectedConfiguration.modelId ||
      !selectedConfiguration.credentialId
    ) {
      configurationState = {
        ...configurationState,
        selectedConfiguration: null,
        selectedConfigurationDigest: null,
        selectedValidation: null,
      };
      renderConfiguration();
      return;
    }
    try {
      const selectedState = (await send({
        type: 'configuration-state',
        selectedConfiguration,
      })) as unknown as ConfigurationState;
      if (lookupSequence !== selectionLookupSequence) return;
      configurationState = {
        ...configurationState,
        selectedConfiguration: selectedState.selectedConfiguration ?? null,
        selectedConfigurationDigest:
          selectedState.selectedConfigurationDigest ?? null,
        selectedValidation: selectedState.selectedValidation ?? null,
      };
    } catch {
      if (lookupSequence !== selectionLookupSequence) return;
      configurationState = {
        ...configurationState,
        selectedConfiguration: null,
        selectedConfigurationDigest: null,
        selectedValidation: null,
      };
    }
    renderConfiguration();
  }

  function showMessage(selector: string, text: string): void {
    const message = element<HTMLElement>(selector);
    if (message) {
      message.textContent = text;
      message.hidden = false;
    }
  }

  function clearProviderRequestFailureMessage(): void {
    const message = element<HTMLElement>('[data-configuration-message]');
    if (message?.textContent === 'Provider request failed.') {
      message.textContent = '';
      message.hidden = true;
    }
  }

  function promptForCredentialSecret(action: 'add' | 'replace'): string | null {
    const promptText =
      action === 'add'
        ? 'Enter the API key. It will be sent directly to the extension service worker.'
        : 'Enter the replacement API key. It will be sent directly to the extension service worker.';
    const secret = window.prompt(promptText);
    if (secret === null || !secret.trim()) {
      return null;
    }
    return secret;
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
  const addCredentialForm = element<HTMLElement>('[data-add-credential-form]');
  const replaceCredentialForm = element<HTMLElement>(
    '[data-replace-credential-form]'
  );
  const addCredentialButton = element<HTMLButtonElement>('[data-add-credential]');
  const replaceCredentialButton = element<HTMLButtonElement>(
    '[data-replace-credential]'
  );
  if (!primary || !forceClear) {
    return { refresh: async () => undefined, ready: Promise.resolve() };
  }

  const overrideAction = element<HTMLButtonElement>('[data-override-action]');
  const overrideAll = element<HTMLButtonElement>('[data-override-all]');
  const overrideUncheck = element<HTMLButtonElement>('[data-override-uncheck]');
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

  function appendOverrideQuestionLabel(
    label: HTMLElement,
    question: Parameters<typeof overrideQuestionLabel>[0],
    index: number
  ): void {
    const text = question.text ?? '';
    const questionPrefix = document.createTextNode(`Q${index + 1} — `);
    label.append(questionPrefix);
    if (text.length <= 180) {
      label.append(text);
      return;
    }

    const preview = createElement('span');
    const fullText = createElement('span');
    const toggle = createElement('button') as HTMLButtonElement;
    const shortened = `${text.slice(0, 180).trimEnd()}...`;
    preview.textContent = shortened;
    fullText.textContent = text;
    fullText.hidden = true;
    toggle.type = 'button';
    toggle.className = 'override-question-toggle';
    toggle.setAttribute('data-question-toggle', '');
    toggle.textContent = '►';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Expand question');
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = fullText.hidden;
      preview.hidden = expanded;
      fullText.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} question`);
      toggle.textContent = expanded ? '▼' : '►';
    });
    label.append(preview, fullText, toggle);
  }

  function renderSpecificQuestions(): void {
    const list = element<HTMLElement>('[data-override-specific-list]');
    const state = controller.state;
    if (!list || state.name === 'UNSUPPORTED' || !state.page) return;
    const filledQuestions = filledOverrideCandidates(state.page);
    list.replaceChildren();
    for (const [index, question] of filledQuestions.entries()) {
      const label = createElement('label');
      const checkbox = createElement('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.value = question.id as string;
      checkbox.checked = selectedSpecificQuestionIds.includes(checkbox.value);
      checkbox.addEventListener('change', () => {
        pendingAllQuestionIds = null;
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
      label.append(checkbox);
      appendOverrideQuestionLabel(label, question, index);
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
      selectedSpecificQuestionIds = [];
      element<HTMLElement>('[data-override-confirmation]')?.setAttribute('hidden', '');
      renderSpecificQuestions();
      if (overrideMessage) overrideMessage.textContent = '';
    }
  });
  overrideAll?.addEventListener('click', () => {
    if (controller.state.name === 'UNSUPPORTED' || !controller.state.page) return;
    const intent = createAllOverrideIntent(controller.state.page);
    if (intent.type !== 'OVERRIDE_FILLED') return;
    const selected = [...intent.selectedQuestionIds];
    selectedSpecificQuestionIds = selected;
    element<HTMLElement>('[data-override-specific-list]')
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((checkbox) => {
        checkbox.checked = selected.includes(checkbox.value);
      });
    pendingAllQuestionIds = selected;
    if (overrideConfirmationText) {
      overrideConfirmationText.textContent =
        `Override ${selected.length} filled answer${selected.length === 1 ? '' : 's'}?`;
    }
    overrideConfirmation?.removeAttribute('hidden');
  });
  overrideUncheck?.addEventListener('click', () => {
    selectedSpecificQuestionIds = [];
    pendingAllQuestionIds = null;
    pendingOverrideIntent = null;
    element<HTMLElement>('[data-override-specific-list]')
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((checkbox) => {
        checkbox.checked = false;
      });
    overrideConfirmation?.setAttribute('hidden', '');
  });
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
    const normalResult =
      controller.state.name === 'REVIEW' && !('status' in controller.state.result)
        ? controller.state.result
        : null;
    pendingAllQuestionIds = null;
    overrideConfirmation?.setAttribute('hidden', '');
    if (overrideMessage) overrideMessage.textContent = 'Override selection ready.';
    publishOverrideIntent(intent);
    const generation = controller.generate(renderAll, intent);
    localGenerationSnapshotPending = controller.state.name === 'GENERATING';
    void generation.then((state) => {
      if (normalResult && state.name === 'REVIEW' && !('status' in state.result)) {
        overridePresentation = { normalResult, overrideResult: state.result };
        resetOverrideFlow();
      } else {
        overridePresentation = null;
      }
      renderAll(state);
    });
  });

  if (
    providerSelect &&
    modelSelect &&
    credentialSelect &&
    credentialLabel &&
    replaceCredentialSelect &&
    addCredentialForm &&
    replaceCredentialForm &&
    addCredentialButton &&
    replaceCredentialButton
  ) {

    const addCredentialFormElement = addCredentialForm;
    const replaceCredentialFormElement = replaceCredentialForm;
    const credentialLabelElement = credentialLabel;
    const replaceCredentialSelectElement = replaceCredentialSelect;
    const providerSelectElement = providerSelect;
    const modelSelectElement = modelSelect;
    const credentialSelectElement = credentialSelect;

    function hideCredentialForms(): void {
      addCredentialFormElement.hidden = true;
      replaceCredentialFormElement.hidden = true;
      credentialLabelElement.value = '';
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
      clearProviderRequestFailureMessage();
      preserveConfigurationDraft = true;
      modelSelect.replaceChildren(
        ...modelsForProvider(configurationState, providerSelect.value).map(
          (model) => new Option(model.displayName, model.modelId)
        )
      );
      const models = modelsForProvider(configurationState, providerSelect.value);
      modelSelect.value =
        (models.some((model) => model.modelId === GEMINI_MODEL)
          ? GEMINI_MODEL
          : models[0]?.modelId) ?? '';
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
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
      void refreshSelectedConfigurationValidation();
    });
    modelSelect.addEventListener('change', () => {
      clearProviderRequestFailureMessage();
      preserveConfigurationDraft = true;
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
      void refreshSelectedConfigurationValidation();
    });
    credentialSelect.addEventListener('change', () => {
      clearProviderRequestFailureMessage();
      preserveConfigurationDraft = true;
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
      void refreshSelectedConfigurationValidation();
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
          const secret = promptForCredentialSecret('add');
          if (secret === null) {
            return;
          }
          await send({
            type: 'credential-create',
            providerId: providerSelect.value,
            label: credentialLabel.value,
            secret,
          });
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
          const replacingActiveCredential =
            configurationState.activeConfiguration?.credentialId ===
            selectedCredentialId;
          const secret = promptForCredentialSecret('replace');
          if (secret === null) {
            return;
          }
          await send({
            type: 'credential-replace',
            credentialId: selectedCredentialId,
            providerId: providerSelect.value,
            label: selectedCredential?.label || 'Unnamed API key',
            secret,
          });
          credentialLabel.value = '';
          hideCredentialForms();
          await reloadConfiguration();
          showMessage('[data-credential-message]', 'API key replaced.');
          if (replacingActiveCredential) {
            await saveAndValidateConfiguration();
          }
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
    async function saveAndValidateConfiguration(): Promise<void> {
      if (validating) return;
      const configurationMessage = element<HTMLElement>(
        '[data-configuration-message]'
      );
      if (configurationMessage) {
        configurationMessage.textContent = '';
        configurationMessage.hidden = true;
      }
      selectionLookupSequence += 1;
      validating = true;
      renderConfiguration();
      renderGeneration(controller.state);
      try {
        configurationState = (await send({
          type: 'configuration-set',
          providerId: providerSelectElement.value,
          modelId: modelSelectElement.value,
          credentialId: credentialSelectElement.value,
        })) as unknown as ConfigurationState;
        preserveConfigurationDraft = false;
        renderAll(controller.state);
        if (!isCurrentValidationValid(configurationState)) {
          await send({ type: 'configuration-validate' });
          await reloadConfiguration();
        }
      } catch (error) {
        await reloadConfiguration().catch(() => undefined);
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Configuration could not be validated.';
        if (errorMessage !== 'Provider request failed.') {
          showMessage('[data-configuration-message]', errorMessage);
        }
      } finally {
        validating = false;
        renderConfiguration();
        renderGeneration(controller.state);
      }
    }

    element<HTMLButtonElement>('[data-save-validate-configuration]')?.addEventListener(
      'click',
      () => void saveAndValidateConfiguration()
    );
    const deleteConfirmation = element<HTMLElement>(
      '[data-delete-confirmation]'
    );
    const deleteConfirmationCopy = element<HTMLElement>(
      '[data-delete-confirmation-copy]'
    );
    function updateDeleteConfirmationCopy(): void {
      const selectedCredentialId = credentialSelectElement.value;
      if (!selectedCredentialId) {
        if (deleteConfirmation) deleteConfirmation.hidden = true;
        return;
      }
      const selectedCredential = configurationState.credentials.find(
        (credential) => credential.credentialId === selectedCredentialId
      );
      const keyName =
        selectedCredential?.label ||
        credentialSelectElement.selectedOptions[0]?.textContent?.trim() ||
        'Unnamed API key';
      if (deleteConfirmationCopy) {
        deleteConfirmationCopy.textContent =
          `Are you sure you want to delete “${keyName}”?`;
      }
    }
    element<HTMLButtonElement>('[data-delete-credential]')?.addEventListener(
      'click',
      () => {
        if (!credentialSelectElement.value || !deleteConfirmation) return;
        updateDeleteConfirmationCopy();
        deleteConfirmation.hidden = false;
      }
    );
    element<HTMLButtonElement>('[data-cancel-delete]')?.addEventListener(
      'click',
      () => {
        if (deleteConfirmation) deleteConfirmation.hidden = true;
      }
    );
    element<HTMLButtonElement>('[data-confirm-delete]')?.addEventListener(
      'click',
      async () => {
        const selectedCredentialId = credentialSelectElement.value;
        if (!selectedCredentialId) {
          if (deleteConfirmation) deleteConfirmation.hidden = true;
          return;
        }
        if (deleteConfirmation) deleteConfirmation.hidden = true;
        try {
          await send({
            type: 'credential-delete-selected',
            credentialId: selectedCredentialId,
          });
          await reloadConfiguration();
          renderAll(controller.state);
          await refreshSelectedConfigurationValidation();
          showMessage('[data-configuration-message]', 'API key deleted.');
        } catch (error) {
          showMessage(
            '[data-configuration-message]',
            error instanceof Error ? error.message : 'API key could not be deleted.'
          );
        }
      }
    );
  }
  primary.addEventListener('click', () => {
    if (!canGenerateCurrentSelection()) return;
    overridePresentation = null;
    const generation = controller.generate(renderAll);
    localGenerationSnapshotPending = controller.state.name === 'GENERATING';
    void generation.then((state) => renderAll(state));
  });
  forceClear.addEventListener('click', async () => {
    forceClear.disabled = true;
    overridePresentation = null;
    resetOverrideFlow();
    renderAll(await controller.forceClear());
    resetOverrideFlow();
    forceClear.disabled = false;
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'p7-state-updated' && message.snapshot) {
      const snapshot = message.snapshot as WorkflowSnapshot & {
        generationOperationId?: string | null;
      };
      const terminalGenerationSnapshot =
        snapshot.generationOperationId == null &&
        (snapshot.uiState === 'REVIEW' || snapshot.uiState === 'ERROR');
      if (
        invalidatedGenerationOperationToken !== null &&
        terminalGenerationSnapshot
      ) {
        invalidatedGenerationOperationToken = null;
        localGenerationSnapshotPending = false;
        return;
      }
      if (terminalGenerationSnapshot && localGenerationSnapshotPending) {
        localGenerationSnapshotPending = false;
      }
      const state = controller.restore(message.snapshot as WorkflowSnapshot);
      overridePresentation = null;
      options.onState?.(state);
      renderAll(state);
    }
  });

  async function refresh(): Promise<void> {
    overridePresentation = null;
    resetOverrideFlow();
    await Promise.all([
      reloadConfiguration(false),
      controller.discover().then((state) => {
      options.onState?.(state);
      }),
    ]);
    renderAll(controller.state);
  }

  const ready = refresh();

  return { refresh, ready };
}
