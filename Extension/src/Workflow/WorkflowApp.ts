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
import { discoverActiveGoogleFormsPage } from '../Forms/Discovery';
import type { QuestionResult } from '../Models/Logical';
import type { FillOutcome } from '../Fill/Filler';
import {
  createAllOverrideIntent,
  createSpecificOverrideIntent,
  filledOverrideCandidates,
  overrideQuestionLabel,
  type GeneratedUiResult,
  type PageSummary,
  type UiState,
  type WorkflowSnapshot,
  type WorkflowQuestion,
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

class ServiceWorkerResponseError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ServiceWorkerResponseError';
  }
}

interface ConfigurationSelection {
  providerId: string;
  modelId: string;
  credentialId: string;
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
  let credentialAddedMessageTimeout: ReturnType<typeof setTimeout> | null = null;
  let validationOperationSequence = 0;
  let validatingSelection: {
    selection: ConfigurationSelection;
    revision: number;
    operationId: number;
  } | null = null;
  let preserveConfigurationDraft = false;
  let requiresExplicitConfigurationSave = false;
  const providerCredentialSelections = new Map<string, string>();
  let renderedProviderId: string | null = null;
  let selectionLookupSequence = 0;
  let configurationSelectionRevision = 0;
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
  let refreshedOverridePage: {
    sourcePage: PageSummary;
    page: PageSummary;
  } | null = null;

  const controller = new WorkflowController(createBrowserWorkflow());
  let primaryAction: HTMLButtonElement | null = null;
  let primaryActionContainer: HTMLElement | null = null;
  let overridePresentation: {
    normalResult: GeneratedUiResult;
    overrideResult: GeneratedUiResult;
  } | null = null;

  function currentConfigurationSelection(): ConfigurationSelection {
    return {
      providerId: element<HTMLSelectElement>('[data-provider-select]')?.value ?? '',
      modelId: element<HTMLSelectElement>('[data-model-select]')?.value ?? '',
      credentialId:
        element<HTMLSelectElement>('[data-credential-select]')?.value ?? '',
    };
  }

  function currentSelectionMatches(
    selection: ConfigurationSelection
  ): boolean {
    const current = currentConfigurationSelection();
    return (
      current.providerId === selection.providerId &&
      current.modelId === selection.modelId &&
      current.credentialId === selection.credentialId
    );
  }

  function captureConfigurationOwnership(): {
    selection: ConfigurationSelection;
    revision: number;
  } {
    return {
      selection: currentConfigurationSelection(),
      revision: configurationSelectionRevision,
    };
  }

  function ownsConfigurationSelection(owner: {
    selection: ConfigurationSelection;
    revision: number;
  }): boolean {
    return (
      configurationSelectionRevision === owner.revision &&
      currentSelectionMatches(owner.selection)
    );
  }

  function ownsProviderRevision(owner: {
    selection: ConfigurationSelection;
    revision: number;
  }): boolean {
    return (
      configurationSelectionRevision === owner.revision &&
      element<HTMLSelectElement>('[data-provider-select]')?.value ===
        owner.selection.providerId
    );
  }

  function isValidatingCurrentSelection(): boolean {
    return Boolean(
      validatingSelection &&
      validatingSelection.revision === configurationSelectionRevision &&
      currentSelectionMatches(validatingSelection.selection)
    );
  }

  function selectedConfigurationMatchesActive(): boolean {
    const active = configurationState.activeConfiguration;
    return Boolean(
      !requiresExplicitConfigurationSave &&
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
      !isValidatingCurrentSelection() &&
      selectedConfigurationMatchesActive() &&
      isCurrentValidationValid(configurationState)
    );
  }

  function overridePageForState(state: UiState): PageSummary | null {
    if (state.name === 'UNSUPPORTED') return null;
    return refreshedOverridePage?.sourcePage === state.page
      ? refreshedOverridePage.page
      : state.page;
  }

  function configurationStateForSelection(): ConfigurationState {
    if (requiresExplicitConfigurationSave) {
      return {
        ...configurationState,
        activeConfiguration: null,
        configurationDigest: null,
        validation: null,
      };
    }
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

  function createRefreshAction(
    label = 'Refresh',
    onClick: () => void | Promise<void> = () => options.onRefresh?.()
  ): HTMLButtonElement {
    const refresh = createElement('button') as HTMLButtonElement;
    refresh.type = 'button';
    refresh.className = 'override-failure-refresh';
    refresh.textContent = '↻';
    refresh.title = label;
    refresh.setAttribute('aria-label', label);
    refresh.addEventListener('click', () => {
      void onClick();
    });
    return refresh;
  }

  function appendRefreshAction(container: HTMLElement): void {
    const refresh = createRefreshAction();
    container.append(refresh);
  }

  function positionOverlayTooltip(anchor: HTMLElement): void {
    const bounds = anchor.getBoundingClientRect();
    const tooltipText = anchor.dataset.tooltip ?? '';
    const maxWidth = Math.min(360, Math.max(0, window.innerWidth - 24));
    const estimatedHeight = Math.min(
      280,
      Math.max(32, tooltipText.split('\n').length * 16 + 12)
    );
    const below = bounds.bottom + 6;
    const top =
      below + estimatedHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, bounds.top - estimatedHeight - 6);
    const left = Math.min(
      Math.max(12, bounds.left),
      Math.max(12, window.innerWidth - maxWidth - 12)
    );
    anchor.style.setProperty('--overlay-tooltip-top', `${top}px`);
    anchor.style.setProperty('--overlay-tooltip-left', `${left}px`);
  }

  function enableOverlayTooltip(anchor: HTMLElement): void {
    if (anchor.dataset.tooltipPositioning === 'enabled') return;
    anchor.dataset.tooltipPositioning = 'enabled';
    const position = () => positionOverlayTooltip(anchor);
    anchor.addEventListener('pointerenter', position);
    anchor.addEventListener('focus', position);
  }

  function createValidationFailureInfoTooltip(
    tooltipText = 'Key was invalid. Please check if you entered the correct key.'
  ): HTMLElement {
    const infoTooltip = createElement('span');
    infoTooltip.className =
      'overlay-tooltip validation-failure-info-tooltip';
    infoTooltip.dataset.tooltip = tooltipText;
    infoTooltip.setAttribute('role', 'img');
    infoTooltip.setAttribute('aria-label', tooltipText);
    infoTooltip.tabIndex = 0;
    enableOverlayTooltip(infoTooltip);

    infoTooltip.append(createValidationFailureInfoIcon());
    return infoTooltip;
  }

  function createValidationFailureInfoIcon(): SVGSVGElement {
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
    return infoIcon;
  }

  function createResourceLink(
    label: string,
    href: string,
    viewBox: string,
    paths: readonly string[],
    iconFill = 'currentColor'
  ): HTMLAnchorElement {
    const link = createElement('a') as HTMLAnchorElement;
    link.className = 'resources-link';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    const svgDocument = ownerDocument ?? document;
    const icon = svgDocument.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    icon.setAttribute('viewBox', viewBox);
    icon.setAttribute('fill', 'currentColor');
    if (iconFill !== 'currentColor') icon.style.fill = iconFill;
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    for (const pathData of paths) {
      const path = svgDocument.createElementNS(
        'http://www.w3.org/2000/svg',
        'path'
      );
      path.setAttribute('d', pathData);
      icon.append(path);
    }

    const text = createElement('span');
    text.textContent = label;
    link.append(icon, text);
    return link;
  }

  function renderResourceLinks(): void {
    const resources = element<HTMLElement>('[data-resource-links]');
    if (!resources || resources.childElementCount > 0) return;
    resources.append(
      createResourceLink(
        'Get Gemini API key',
        'https://aistudio.google.com/app/apikey',
        '0 0 24 24',
        [
          'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
        ]
      ),
      createResourceLink(
        'Get NVIDIA API key',
        'https://build.nvidia.com/settings/api-keys',
        '0 86.6 512 338.8',
        [
          'M52.3 232.5s46.3-68.3 138.7-75.4v-24.8C88.7 140.5 0 227.2 0 227.2s50.2 145.2 191 158.4v-26.3C87.7 346.3 52.3 232.5 52.3 232.5M191 307v24.1C112.9 317.2 91.3 236 91.3 236s37.5-41.5 99.8-48.3v26.5h-.1c-32.7-3.9-58.2 26.6-58.2 26.6S147 292.2 191 307m0-220.4v45.7c3-.2 6-.4 9-.5 116.4-3.9 192.2 95.5 192.2 95.5s-87.1 105.9-177.8 105.9c-8.3 0-16.1-.8-23.4-2.1v28.3c6.3.8 12.7 1.3 19.5 1.3 84.4 0 145.5-43.1 204.6-94.2 9.8 7.9 49.9 27 58.2 35.3-56.2 47.1-187.3 85-261.5 85-7.2 0-14-.4-20.8-1.1v39.7h321V86.6zm0 101.1v-30.6c3-.2 6-.4 9-.5 83.7-2.6 138.6 71.9 138.6 71.9s-59.3 82.4-122.9 82.4c-9.2 0-17.4-1.5-24.7-4v-92.8c32.6 3.9 39.1 18.3 58.7 51l43.6-36.7s-31.8-41.7-85.4-41.7c-5.8 0-11.4.4-16.9 1',
        ],
        '#000000'
      )
    );
  }

  function skippedReason(
    result: QuestionResult | undefined,
    fillReason: string | null
  ): string {
    if (result?.status === 'GENERATION_FAILED') {
      return 'Answer generation failed.';
    }
    if (result?.status === 'VALIDATION_FAILED') {
      return 'The generated answer did not match the question.';
    }
    const recordedReason = result?.reason?.trim() || fillReason?.trim();
    if (!recordedReason) return 'Reason unavailable.';
    if (
      recordedReason === 'Question text is unavailable.' ||
      recordedReason ===
        'Question title must contain at least two letters or numbers.'
    ) {
      return 'Question text is unavailable or empty. The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.';
    }
    if (recordedReason === 'Question type is unsupported.') {
      return `${recordedReason} The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.`;
    }
    if (recordedReason === 'LOW_CONFIDENCE') {
      return 'No confident answer was available. The question or its answer may be embedded in an image that AnswerSense cannot directly interpret.';
    }
    if (recordedReason === 'UNABLE_TO_DETERMINE') {
      return 'An answer could not be determined.';
    }
    if (recordedReason === 'NOT_APPLICABLE') {
      return 'The question did not have an applicable answer.';
    }
    if (recordedReason === 'The reviewed answer was skipped.') {
      return 'Skipped during review.';
    }
    const conciseReason = recordedReason.replace(/\s+/g, ' ');
    return conciseReason.length > 180
      ? `${conciseReason.slice(0, 177).trimEnd()}...`
      : conciseReason;
  }

  function appendSkippedQuestionDetails(
    summaryRow: HTMLElement,
    outcomes: readonly FillOutcome[],
    generationResults: ReadonlyMap<string | null, QuestionResult>,
    questions: readonly WorkflowQuestion[]
  ): void {
    const skippedOutcomes = outcomes.filter(
      (outcome) => outcome.status === 'SKIPPED'
    );
    if (skippedOutcomes.length === 0) return;

    const details = createElement('span');
    details.className = 'skipped-details';
    const trigger = createElement('button') as HTMLButtonElement;
    trigger.type = 'button';
    trigger.className = 'skipped-details-trigger';
    trigger.setAttribute(
      'aria-label',
      `Show details for ${skippedOutcomes.length} skipped question${skippedOutcomes.length === 1 ? '' : 's'}`
    );
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'skipped-question-details');

    const icon = createValidationFailureInfoIcon();
    icon.classList.add('skipped-details-icon');
    icon.removeAttribute('id');
    icon.querySelectorAll('[id]').forEach((element) =>
      element.removeAttribute('id')
    );
    trigger.append(icon);

    const panel = createElement('div');
    panel.id = 'skipped-question-details';
    panel.className = 'skipped-details-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Skipped questions and reasons');
    panel.setAttribute('aria-hidden', 'true');
    panel.tabIndex = 0;
    const list = createElement('ul');
    list.className = 'skipped-details-list';

    for (const outcome of skippedOutcomes) {
      const questionId = outcome.questionId;
      const question = questions.find(
        (candidate) => candidate.id === questionId
      );
      const generationResult = generationResults.get(questionId);
      const item = createElement('li');
      item.className = 'skipped-details-item';

      const identity = createElement('strong');
      identity.textContent =
        typeof questionId === 'string'
          ? `Question ID ${questionId}`
          : 'Question ID unavailable';
      item.append(identity);

      const title = question?.text?.trim();
      if (title) {
        const titleText = createElement('span');
        titleText.className = 'skipped-details-title';
        titleText.textContent = title;
        item.append(titleText);
      }

      const reason = createElement('span');
      reason.className = 'skipped-details-reason';
      reason.textContent = skippedReason(generationResult, outcome.reason);
      item.append(reason);
      list.append(item);
    }

    panel.append(list);
    details.append(trigger, panel);

    let hovered = false;
    let focused = false;
    let pinned = false;
    let lastPointerType: string | null = null;
    let hoverCloseTimeout: number | null = null;
    let hoveringDetails = false;
    const cancelHoverClose = (): void => {
      if (hoverCloseTimeout !== null) {
        window.clearTimeout(hoverCloseTimeout);
        hoverCloseTimeout = null;
      }
    };
    const scheduleHoverClose = (): void => {
      cancelHoverClose();
      hoverCloseTimeout = window.setTimeout(() => {
        hoverCloseTimeout = null;
        hoveringDetails = false;
        if (!trigger.matches(':focus-visible')) focused = false;
        updateVisibility();
      }, 160);
    };
    const updateVisibility = (): void => {
      const visible = hovered || hoveringDetails || focused || pinned;
      details.dataset.visible = String(visible);
      trigger.setAttribute('aria-expanded', String(visible));
      panel.setAttribute('aria-hidden', String(!visible));
      if (!visible) return;

      const triggerRect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const panelWidth = Math.min(panel.offsetWidth || 320, viewportWidth - 24);
      const panelHeight = Math.min(panel.offsetHeight || 220, viewportHeight - 24);
      const left = Math.min(
        Math.max(12, triggerRect.left),
        Math.max(12, viewportWidth - panelWidth - 12)
      );
      const below = triggerRect.bottom + 6;
      const top =
        below + panelHeight <= viewportHeight - 12
          ? below
          : Math.max(12, triggerRect.top - panelHeight - 6);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    details.addEventListener('pointerenter', (event) => {
      cancelHoverClose();
      lastPointerType = event.pointerType;
      hovered = true;
      updateVisibility();
    });
    details.addEventListener('pointerleave', (event) => {
      const pointerType = event.pointerType || lastPointerType;
      lastPointerType = null;
      hovered = false;
      if (pointerType !== 'touch') {
        pinned = false;
        if (!trigger.matches(':focus-visible')) focused = false;
      }
      if (hoveringDetails) {
        updateVisibility();
      } else {
        scheduleHoverClose();
      }
    });
    panel.addEventListener('pointerenter', (event) => {
      cancelHoverClose();
      lastPointerType = event.pointerType;
      hoveringDetails = true;
      updateVisibility();
    });
    panel.addEventListener('pointerleave', (event) => {
      lastPointerType = null;
      hoveringDetails = false;
      if (event.relatedTarget instanceof Node && details.contains(event.relatedTarget)) {
        hovered = true;
        updateVisibility();
      } else {
        scheduleHoverClose();
      }
    });
    details.addEventListener('focusin', () => {
      focused = true;
      updateVisibility();
    });
    details.addEventListener('focusout', (event) => {
      if (
        event.relatedTarget instanceof Node &&
        details.contains(event.relatedTarget)
      ) {
        return;
      }
      focused = false;
      updateVisibility();
    });
    trigger.addEventListener('pointerdown', (event) => {
      lastPointerType = event.pointerType;
    });
    trigger.addEventListener('click', () => {
      if (lastPointerType === 'touch') {
        pinned = !pinned;
      } else {
        pinned = false;
      }
      updateVisibility();
    });

    summaryRow.append(details);
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

    const hideOverride =
      state.name !== 'REVIEW' || 'status' in state.result;
    if (overrideAction) {
      overrideAction.toggleAttribute('hidden', hideOverride);
      overrideAction.disabled = state.name === 'GENERATING';
    }
    overrideRefresh?.toggleAttribute('hidden', hideOverride);
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
      const newlyFilledQuestionIds = new Set(
        summaryOutcomes
          .filter(
            ({ status }) => status === 'FILLED' || status === 'PARTIAL_FILL'
          )
          .flatMap((outcome) =>
            typeof outcome.questionId === 'string' ? [outcome.questionId] : []
          )
      );
      const alreadyFilledQuestionIds = new Set(
        summaryOutcomes
          .filter(({ status }) => status === 'PRESERVED_EXISTING')
          .flatMap((outcome) =>
            typeof outcome.questionId === 'string' ? [outcome.questionId] : []
          )
      );
      for (const question of filledOverrideCandidates(state.page)) {
        if (
          question.id !== null &&
          !newlyFilledQuestionIds.has(question.id)
        ) {
          alreadyFilledQuestionIds.add(question.id);
        }
      }
      const alreadyFilledCount = alreadyFilledQuestionIds.size;
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
      summary.append(
        `${filledCount} filled · ${alreadyFilledCount} already filled · ${failedCount} failed · `
      );
      const skippedLabel = createElement('span');
      skippedLabel.className = 'result-summary-skipped';
      skippedLabel.textContent = `${skippedCount} skipped`;
      summary.append(skippedLabel);
      if (overridedCount > 0 && skippedCount === 0) {
        summary.append(` · ${overridedCount} overrided`);
      }
      const summaryRow = createElement('div');
      summaryRow.className = 'result-summary-row';
      summaryRow.append(summary);
      const generationResults = new Map<string | null, QuestionResult>();
      if (activeOverridePresentation) {
        for (const result of activeOverridePresentation.normalResult.report.results) {
          generationResults.set(result.questionId, result);
        }
        for (const result of activeOverridePresentation.overrideResult.report.results) {
          generationResults.set(result.questionId, result);
        }
      } else {
        for (const result of state.result.report.results) {
          generationResults.set(result.questionId, result);
        }
      }
      appendSkippedQuestionDetails(
        summaryRow,
        summaryOutcomes,
        generationResults,
        state.page.questions ?? []
      );
      if (overridedCount > 0 && skippedCount > 0) {
        const overrideLabel = createElement('span');
        overrideLabel.className = 'result-summary';
        overrideLabel.textContent = ` · ${overridedCount} overrided`;
        summaryRow.append(overrideLabel);
      }
      results.append(summaryRow);
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
      isValidatingCurrentSelection() ||
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

  function updateAddCredentialButtonLabel(
    providerSelect: HTMLSelectElement
  ): void {
    const addCredentialButton = element<HTMLButtonElement>(
      '[data-add-credential]'
    );
    const providerName = providerSelect.selectedOptions[0]?.textContent?.trim();
    if (addCredentialButton && providerName) {
      addCredentialButton.textContent = `Add ${providerName} API key`;
    }
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

    renderResourceLinks();
    const resourcesHeading = element<HTMLElement>('[data-resources-heading]');
    if (
      resourcesHeading &&
      !resourcesHeading.querySelector('.validation-failure-info-tooltip')
    ) {
      resourcesHeading.append(
        ' ',
        createValidationFailureInfoTooltip(
          'Signing in may be required to create an API key.'
        )
      );
    }

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
    updateAddCredentialButtonLabel(providerSelect);
        renderedProviderId = providerSelect.value;
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
    credentialSelect.disabled = providerCredentials.length === 0;
    if (!providerCredentials.length) {
      const placeholder = new Option('No API keys added yet', '');
      placeholder.disabled = true;
      placeholder.hidden = true;
      credentialSelect.add(placeholder);
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
      : 'No keys stored';
    const credentialCountsByProvider = new Map<string, number>();
    for (const credential of configurationState.credentials) {
      credentialCountsByProvider.set(
        credential.providerId,
        (credentialCountsByProvider.get(credential.providerId) ?? 0) + 1
      );
    }
    credentialStatus.classList.add('overlay-tooltip', 'credential-count-tooltip');
    credentialStatus.dataset.tooltip = [
      ...configurationState.providers.map(
        (provider) =>
          `${provider.displayName} keys: ${credentialCountsByProvider.get(provider.providerId) ?? 0}`
      ),
    ].join('\n');
    credentialStatus.removeAttribute('title');
    credentialStatus.tabIndex = 0;
    enableOverlayTooltip(credentialStatus);
    if (configurationGuidance) {
      configurationGuidance.textContent =
        (selectedConfigurationMatchesActive()
          ? validGenerationMessage(configurationState)
          : null) ??
        'Configure the extension before generating.';
    }
    const selectionConfigurationState = configurationStateForSelection();
    const configurationStatusText = authorizationStatus(
      selectionConfigurationState,
      isValidatingCurrentSelection(),
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
    const isInvalidCredential =
      isValidationFailure &&
      selectionConfigurationState.validation?.failureCode ===
        'AUTHENTICATION_FAILED';
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
        document.createTextNode(
          isInvalidCredential ? ' — Credential invalid. ' : ' '
        ),
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
    if (response?.error) {
      throw new ServiceWorkerResponseError(
        typeof response.code === 'string' ? response.code : '',
        String(response.error)
      );
    }
    return response ?? {};
  }

  async function reloadConfiguration(
    shouldRender = true,
    expectedSelection?: ConfigurationSelection,
    expectedSelectionRevision?: number
  ): Promise<boolean> {
    const lookupSequence = ++selectionLookupSequence;
    const nextState = (await send({
      type: 'configuration-state',
    })) as unknown as ConfigurationState;
    if (
      expectedSelection &&
      (lookupSequence !== selectionLookupSequence ||
        !currentSelectionMatches(expectedSelection) ||
        (expectedSelectionRevision !== undefined &&
          expectedSelectionRevision !== configurationSelectionRevision))
    ) {
      return false;
    }
    configurationState = nextState;
    preserveConfigurationDraft = shouldRender && expectedSelection !== undefined;
    if (shouldRender) {
      renderAll(controller.state);
    }
    return true;
  }

  async function refreshSelectedConfigurationValidation(): Promise<void> {
    const selectedConfiguration = currentConfigurationSelection();
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
      if (
        lookupSequence !== selectionLookupSequence ||
        !currentSelectionMatches(selectedConfiguration)
      ) return;
      configurationState = {
        ...configurationState,
        selectedConfiguration: selectedState.selectedConfiguration ?? null,
        selectedConfigurationDigest:
          selectedState.selectedConfigurationDigest ?? null,
        selectedValidation: selectedState.selectedValidation ?? null,
      };
    } catch {
      if (
        lookupSequence !== selectionLookupSequence ||
        !currentSelectionMatches(selectedConfiguration)
      ) return;
      configurationState = {
        ...configurationState,
        selectedConfiguration: null,
        selectedConfigurationDigest: null,
        selectedValidation: null,
      };
    }
    renderConfiguration();
  }

  function clearCredentialAddedMessageTimeout(): void {
    if (credentialAddedMessageTimeout !== null) {
      clearTimeout(credentialAddedMessageTimeout);
      credentialAddedMessageTimeout = null;
    }
  }

  function clearConfigurationMessage(): void {
    const message = element<HTMLElement>('[data-configuration-message]');
    if (message) {
      message.textContent = '';
      message.hidden = true;
    }
  }

  function clearCredentialMessage(): void {
    clearCredentialAddedMessageTimeout();
    const message = element<HTMLElement>('[data-credential-message]');
    if (message) {
      message.textContent = '';
      message.hidden = true;
    }
  }

  function showMessage(selector: string, text: string): void {
    if (selector === '[data-credential-message]') {
      clearCredentialAddedMessageTimeout();
    }
    const message = element<HTMLElement>(selector);
    if (message) {
      message.textContent = text;
      message.hidden = false;
    }
  }

  function showCredentialAddedMessage(): void {
    const messageText = 'API key added.';
    showMessage('[data-credential-message]', messageText);
    credentialAddedMessageTimeout = setTimeout(() => {
      const message = element<HTMLElement>('[data-credential-message]');
      if (message?.textContent === messageText) {
        message.textContent = '';
        message.hidden = true;
      }
      credentialAddedMessageTimeout = null;
    }, 1500);
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
  const overrideRefresh = overrideAction
    ? createRefreshAction(
        'Refresh filled-answer detection',
        refreshOverrideCandidates
      )
    : null;
  if (overrideRefresh) {
    overrideRefresh.dataset.overrideRefresh = '';
    overrideAction?.after(overrideRefresh);
  }
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
    question: Parameters<typeof overrideQuestionLabel>[0]
  ): void {
    const text = overrideQuestionLabel(question);
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
    const page = overridePageForState(state);
    if (!list || !page) return;
    const filledQuestions = filledOverrideCandidates(page);
    list.replaceChildren();
    for (const question of filledQuestions) {
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
      appendOverrideQuestionLabel(label, question);
      list.append(label);
    }
    list.removeAttribute('hidden');
  }

  function openOverrideSection(): void {
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
  }

  async function refreshOverrideCandidates(): Promise<void> {
    const state = controller.state;
    if (state.name !== 'REVIEW' || 'status' in state.result) return;
    try {
      const discovered = discoverActiveGoogleFormsPage(
        ownerDocument ?? document
      );
      if (
        !discovered ||
        discovered.pageId !== state.page.pageId ||
        discovered.questions.length === 0
      ) {
        return;
      }
      const previousSupportedIds = new Set(
        (state.page.questions ?? [])
          .filter(
            (question) =>
              question.supported && question.id !== null && question.id.trim()
          )
          .map((question) => question.id as string)
      );
      const hasReadableQuestion = discovered.questions.some(
        (question) =>
          question.kind === 'supported' &&
          question.id !== null &&
          (previousSupportedIds.size === 0 ||
            previousSupportedIds.has(question.id))
      );
      if (!hasReadableQuestion) return;

      const questions: WorkflowQuestion[] = discovered.questions.map(
        (question) =>
          question.kind === 'supported'
            ? {
                id: question.id,
                text: question.text,
                type: question.type,
                supported: true,
                existingInput: { hasValue: question.existingValue !== null },
              }
            : {
                id: question.id,
                text: question.text,
                type: null,
                supported: false,
                existingInput: null,
              }
      );
      const refreshedPage: PageSummary = {
        ...state.page,
        questionCount: questions.length,
        questions,
      };
      const candidates = filledOverrideCandidates(refreshedPage);
      const candidateIds = new Set(
        candidates.map((question) => question.id as string)
      );
      const wasAllSelection = pendingAllQuestionIds !== null;
      selectedSpecificQuestionIds = selectedSpecificQuestionIds.filter((id) =>
        candidateIds.has(id)
      );
      refreshedOverridePage = {
        sourcePage: state.page,
        page: refreshedPage,
      };

      const flow = element<HTMLElement>('[data-override-flow]');
      if (flow?.hidden) {
        openOverrideSection();
        return;
      }

      if (selectedSpecificQuestionIds.length === 0) {
        pendingAllQuestionIds = null;
        pendingOverrideIntent = null;
        overrideConfirmation?.setAttribute('hidden', '');
      } else {
        const updatedIntent = createSpecificOverrideIntent(
          selectedSpecificQuestionIds
        );
        pendingOverrideIntent = updatedIntent;
        pendingAllQuestionIds = wasAllSelection
          ? [...selectedSpecificQuestionIds]
          : null;
        options.onOverrideIntent?.(updatedIntent);
        if (overrideConfirmationText) {
          overrideConfirmationText.textContent =
            `Override ${selectedSpecificQuestionIds.length} filled answer${selectedSpecificQuestionIds.length === 1 ? '' : 's'}?`;
        }
        overrideConfirmation?.removeAttribute('hidden');
      }

      if (flow && !flow.hidden) {
        renderSpecificQuestions();
      }
    } catch {
      return;
    }
  }

  overrideAction?.addEventListener('click', openOverrideSection);
  overrideAll?.addEventListener('click', () => {
    const page = overridePageForState(controller.state);
    if (!page) return;
    const intent = createAllOverrideIntent(page);
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
      updateAddCredentialButtonLabel(providerSelect);
      const previousProviderId = renderedProviderId;
      if (previousProviderId) {
        providerCredentialSelections.set(
          previousProviderId,
          credentialSelect.value
        );
      }
      selectionLookupSequence += 1;
      configurationSelectionRevision += 1;
      clearConfigurationMessage();
      clearCredentialMessage();
      hideCredentialForms();
      requiresExplicitConfigurationSave = true;
      preserveConfigurationDraft = true;
      const models = modelsForProvider(configurationState, providerSelect.value);
      modelSelect.replaceChildren(
        ...models.map((model) => new Option(model.displayName, model.modelId))
      );
      modelSelect.value =
        (models.some((model) => model.modelId === GEMINI_MODEL)
          ? GEMINI_MODEL
          : models[0]?.modelId) ?? '';
      const credentials = configurationState.credentials.filter(
        (item) => item.providerId === providerSelect.value
      );
      credentialSelect.disabled = credentials.length === 0;
      const credentialOptions = credentials.map(
        (credential) =>
          new Option(
            credential.label || 'Unnamed API key',
            credential.credentialId
          )
      );
      if (!credentialOptions.length) {
        const placeholder = new Option('No API keys added yet', '');
        placeholder.disabled = true;
        placeholder.hidden = true;
        credentialOptions.push(placeholder);
      }
      credentialSelect.replaceChildren(...credentialOptions);
      const rememberedCredentialId = providerCredentialSelections.get(
        providerSelect.value
      );
      const activeCredentialId =
        configurationState.activeConfiguration?.providerId === providerSelect.value
          ? configurationState.activeConfiguration.credentialId
          : null;
      credentialSelect.value =
        credentials.some(
          (credential) =>
            credential.credentialId === rememberedCredentialId
        )
          ? rememberedCredentialId ?? ''
          : credentials.some(
                (credential) => credential.credentialId === activeCredentialId
            )
            ? activeCredentialId ?? ''
            : credentials[0]?.credentialId ?? '';
      renderedProviderId = providerSelect.value;
      configurationState = {
        ...configurationState,
        selectedConfiguration: null,
        selectedConfigurationDigest: null,
        selectedValidation: null,
      };
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
    });
    modelSelect.addEventListener('change', () => {
      selectionLookupSequence += 1;
      configurationSelectionRevision += 1;
      clearConfigurationMessage();
      preserveConfigurationDraft = true;
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
      if (requiresExplicitConfigurationSave) {
        configurationState = {
          ...configurationState,
          selectedConfiguration: null,
          selectedConfigurationDigest: null,
          selectedValidation: null,
        };
        renderConfiguration();
      } else {
        void refreshSelectedConfigurationValidation();
      }
    });
    credentialSelect.addEventListener('change', () => {
      selectionLookupSequence += 1;
      configurationSelectionRevision += 1;
      providerCredentialSelections.set(providerSelect.value, credentialSelect.value);
      clearConfigurationMessage();
      preserveConfigurationDraft = true;
      updateDeleteConfirmationCopy();
      resetGenerationForConfigurationChange();
      if (requiresExplicitConfigurationSave) {
        configurationState = {
          ...configurationState,
          selectedConfiguration: null,
          selectedConfigurationDigest: null,
          selectedValidation: null,
        };
        renderConfiguration();
      } else {
        void refreshSelectedConfigurationValidation();
      }
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
        const owner = captureConfigurationOwnership();
        try {
          const secret = promptForCredentialSecret('add');
          if (secret === null) {
            return;
          }
          await send({
            type: 'credential-create',
            providerId: owner.selection.providerId,
            label: credentialLabel.value,
            secret,
          });
          if (!ownsConfigurationSelection(owner)) return;
          credentialLabel.value = '';
          hideCredentialForms();
          const reloaded = await reloadConfiguration(
            true,
            owner.selection,
            owner.revision
          );
          if (!reloaded || !ownsProviderRevision(owner)) return;
          showCredentialAddedMessage();
        } catch (error) {
          if (!ownsConfigurationSelection(owner)) return;
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
        const owner = captureConfigurationOwnership();
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
          const replacingActiveConfiguration =
            configurationState.activeConfiguration?.providerId ===
              owner.selection.providerId &&
            configurationState.activeConfiguration?.modelId ===
              owner.selection.modelId &&
            configurationState.activeConfiguration?.credentialId ===
              selectedCredentialId;
          const secret = promptForCredentialSecret('replace');
          if (secret === null) {
            return;
          }
          const replacement = await send({
            type: 'credential-replace',
            credentialId: selectedCredentialId,
            providerId: owner.selection.providerId,
            label: selectedCredential?.label || 'Unnamed API key',
            secret,
          });
          if (!ownsConfigurationSelection(owner)) return;
          credentialLabel.value = '';
          hideCredentialForms();
          const reloaded = await reloadConfiguration(
            false,
            owner.selection,
            owner.revision
          );
          if (!reloaded || !ownsConfigurationSelection(owner)) return;
          const replacementCredentialId =
            typeof replacement.credentialId === 'string'
              ? replacement.credentialId
              : null;
          if (replacingActiveConfiguration && replacementCredentialId) {
            const replacementState = configurationState;
            const replacementIsActive =
              replacementState.activeConfiguration?.providerId ===
                owner.selection.providerId &&
              replacementState.activeConfiguration?.modelId ===
                owner.selection.modelId &&
              replacementState.activeConfiguration?.credentialId ===
                replacementCredentialId &&
              replacementState.credentials.some(
                (credential) =>
                  credential.credentialId === replacementCredentialId &&
                  credential.providerId === owner.selection.providerId
            );
            if (replacementIsActive) {
              preserveConfigurationDraft = false;
              renderAll(controller.state);
            }
          } else {
            const replacementIsSelected =
              replacementCredentialId !== null &&
              owner.selection.credentialId === selectedCredentialId &&
              configurationState.credentials.some(
                (credential) =>
                  credential.credentialId === replacementCredentialId &&
                  credential.providerId === owner.selection.providerId
              );
            if (replacementIsSelected && replacementCredentialId) {
              credentialSelectElement.value = replacementCredentialId;
              providerCredentialSelections.set(
                owner.selection.providerId,
                replacementCredentialId
              );
            }
            preserveConfigurationDraft = true;
            renderAll(controller.state);
          }
          if (!ownsProviderRevision(owner)) return;
          showMessage('[data-credential-message]', 'API key replaced.');
          if (
            replacingActiveConfiguration &&
            replacementCredentialId &&
            currentConfigurationSelection().providerId === owner.selection.providerId &&
            currentConfigurationSelection().modelId === owner.selection.modelId &&
            currentConfigurationSelection().credentialId === replacementCredentialId
          ) {
            await saveAndValidateConfiguration();
          }
        } catch (error) {
          if (!ownsConfigurationSelection(owner)) return;
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
      const selectedConfiguration = currentConfigurationSelection();
      const selectionRevision = configurationSelectionRevision;
      if (
        validatingSelection &&
        validatingSelection.revision === selectionRevision &&
        currentSelectionMatches(validatingSelection.selection)
      ) return;
      const isCurrentSave = (): boolean =>
        selectionRevision === configurationSelectionRevision &&
        currentSelectionMatches(selectedConfiguration);
      const operationId = ++validationOperationSequence;
      const validateAfterProviderChange = requiresExplicitConfigurationSave;
      const configurationMessage = element<HTMLElement>(
        '[data-configuration-message]'
      );
      if (configurationMessage) {
        configurationMessage.textContent = '';
        configurationMessage.hidden = true;
      }
      selectionLookupSequence += 1;
      validatingSelection = {
        selection: selectedConfiguration,
        revision: selectionRevision,
        operationId,
      };
      renderConfiguration();
      renderGeneration(controller.state);
      try {
        const savedState = (await send({
          type: 'configuration-set',
          providerId: selectedConfiguration.providerId,
          modelId: selectedConfiguration.modelId,
          credentialId: selectedConfiguration.credentialId,
        })) as unknown as ConfigurationState;
        if (!isCurrentSave()) return;
        configurationState = savedState;
        renderAll(controller.state);
        if (
          validateAfterProviderChange ||
          !isCurrentValidationValid(configurationState)
        ) {
          await send({
            type: 'configuration-validate',
            configurationDigest: savedState.configurationDigest ?? undefined,
          });
          if (!isCurrentSave()) return;
          const reloaded = await reloadConfiguration(
            false,
            selectedConfiguration,
            selectionRevision
          );
          if (!reloaded) return;
        }
        if (!isCurrentSave()) return;
        preserveConfigurationDraft = false;
        if (validateAfterProviderChange) {
          requiresExplicitConfigurationSave = false;
        }
        renderAll(controller.state);
      } catch (error) {
        if (!isCurrentSave()) return;
        const reloaded = await reloadConfiguration(
          false,
          selectedConfiguration,
          selectionRevision
        ).catch(() => false);
        if (!isCurrentSave()) return;
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Configuration could not be validated.';
        if (reloaded && errorMessage === 'Credential invalid.') {
          requiresExplicitConfigurationSave = false;
        }
        if (
          errorMessage !== 'Provider request failed.' &&
          errorMessage !== 'Credential invalid.'
        ) {
          showMessage('[data-configuration-message]', errorMessage);
        }
      } finally {
        if (validatingSelection?.operationId === operationId) {
          validatingSelection = null;
        }
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
        const owner = captureConfigurationOwnership();
        try {
          await send({
            type: 'credential-delete-selected',
            credentialId: selectedCredentialId,
          });
          if (!ownsConfigurationSelection(owner)) return;
          const reloaded = await reloadConfiguration(
            true,
            owner.selection,
            owner.revision
          );
          if (!reloaded || !ownsProviderRevision(owner)) return;
          await refreshSelectedConfigurationValidation();
          if (!ownsProviderRevision(owner)) return;
          showMessage('[data-configuration-message]', 'API key deleted.');
        } catch (error) {
          if (!ownsConfigurationSelection(owner)) return;
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
