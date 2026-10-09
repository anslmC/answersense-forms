import type { NormalizedActivePage, ProcessingCycle } from '../Models/Logical';
import type { DiscoveredPage } from '../Forms/Discovery';
import {
  computePageFingerprint,
  normalizeDiscoveredActivePage,
} from '../Forms/Normalization';
import type { FinalizedPageHandoff } from '../Fill/Handoff';
import { captureAnswerSnapshot } from '../Fill/Handoff';
import {
  capturePendingPageAtSettlement,
  commitPendingPageAfterSuccessfulTransition,
  createPendingPageStateFromHandoff,
  type PendingPageState,
} from '../Generation/Pending';
import {
  buildSettledContext,
  type SettledPageState,
} from '../Generation/Context';
import { GenerationCoordinator } from '../Generation/Pipeline';
import {
  beginNextNavigation,
  confirmPageTransition,
  type DocumentPageTransition,
  type PendingNavigation,
} from './Transition';

export type PageRevisitStatus = 'NEW' | 'UNCHANGED_REVISIT' | 'CHANGED_REVISIT';

export interface PageVisit {
  pageId: string;
  cycleId: string;
  status: 'active' | 'settled' | 'abandoned';
}

export interface LifecycleSnapshot {
  activePage: NormalizedActivePage;
  activeCycle: ProcessingCycle;
  pending: PendingPageState | null;
  settledPages: readonly SettledPageState[];
  capturedQuestionIds?: readonly string[];
  visits: readonly PageVisit[];
  navigation: PendingNavigation | null;
  revisitStatus?: PageRevisitStatus;
  documentPathname?: string;
}

export class PageLifecycle {
  private activePage: NormalizedActivePage;
  private activeCycle: ProcessingCycle;
  private pending: PendingPageState | null = null;
  private navigation: PendingNavigation | null = null;
  private oldPageDocument: Document | null = null;
  private readonly capturedQuestionIds = new Set<string>();
  private revisitStatus: PageRevisitStatus = 'NEW';
  private readonly settledPages: SettledPageState[] = [];
  private readonly visits: PageVisit[] = [];
  private documentPathname: string | undefined;

  constructor(
    initialPage: NormalizedActivePage,
    private readonly generation: GenerationCoordinator,
    snapshot?: LifecycleSnapshot
  ) {
    if (snapshot) {
      this.activePage = snapshot.activePage;
      this.activeCycle = snapshot.activeCycle;
      this.pending = snapshot.pending;
      for (const questionId of snapshot.capturedQuestionIds ?? []) {
        this.capturedQuestionIds.add(questionId);
      }
      this.settledPages.push(...snapshot.settledPages);
      this.visits.push(...snapshot.visits);
      this.navigation = snapshot.navigation;
      this.revisitStatus = snapshot.revisitStatus ?? 'NEW';
      this.documentPathname = snapshot.documentPathname;
      this.generation.adoptCycle(this.activeCycle.cycleId);
    } else {
      this.activePage = initialPage;
      this.activeCycle = this.generation.beginCycle();
      this.activePage = { ...initialPage, processingCycle: this.activeCycle };
      this.visits.push({
        pageId: initialPage.form.activePageId,
        cycleId: this.activeCycle.cycleId,
        status: 'active',
      });
    }
  }

  get currentPage(): NormalizedActivePage {
    return this.activePage;
  }

  get currentCycle(): ProcessingCycle {
    return this.activeCycle;
  }

  get pendingPage(): PendingPageState | null {
    return this.pending;
  }

  get pendingNavigation(): PendingNavigation | null {
    return this.navigation;
  }

  get context(): ReturnType<typeof buildSettledContext> {
    return buildSettledContext(this.settledPages);
  }

  get settledPageStates(): readonly SettledPageState[] {
    return this.settledPages;
  }

  get pageVisits(): readonly PageVisit[] {
    return this.visits;
  }

  get currentRevisitStatus(): PageRevisitStatus {
    return this.revisitStatus;
  }

  classifyPageRevisit(page: NormalizedActivePage): PageRevisitStatus {
    const existing = this.settledPages.find(
      (candidate) => candidate.pageId === page.form.activePageId
    );
    if (!existing) {
      return 'NEW';
    }
    const candidateFingerprint =
      page.form.pageFingerprint ?? computePageFingerprint(page.form);
    return existing.pageFingerprint === candidateFingerprint
      ? 'UNCHANGED_REVISIT'
      : 'CHANGED_REVISIT';
  }

  getSnapshot(documentPathname = this.documentPathname): LifecycleSnapshot {
    return {
      activePage: this.activePage,
      activeCycle: this.activeCycle,
      pending: this.pending,
      settledPages: this.settledPages,
      capturedQuestionIds: [...this.capturedQuestionIds],
      visits: this.visits,
      navigation: this.navigation,
      revisitStatus: this.revisitStatus,
      documentPathname,
    };
  }

  setDocumentPathname(documentPathname: string): void {
    this.documentPathname = documentPathname;
  }

  acceptFinalizedHandoff(handoff: FinalizedPageHandoff): PendingPageState {
    if (
      handoff.pageId !== this.activePage.form.activePageId ||
      handoff.cycleId !== this.activeCycle.cycleId
    ) {
      throw new Error(
        'Finalized handoff does not belong to the active page visit.'
      );
    }
    this.pending = createPendingPageStateFromHandoff(handoff);
    return this.pending;
  }

  captureCurrentAnswers(
    document: Document,
    allowEmpty = true
  ): NormalizedActivePage {
    const questions = this.activePage.form.questions.map((question) => {
      if (!question.supported || question.id === null) return question;
      const capture = captureAnswerSnapshot(
        document,
        this.activePage.form,
        question.id
      );
      if (capture.status === 'unavailable') return question;
      if (!capture.answer && !allowEmpty) return question;
      this.capturedQuestionIds.add(question.id);
      const answer = capture.answer;
      const value = answer?.value ?? null;
      const selectedValues = new Set(Array.isArray(value) ? value : value === null ? [] : [value]);
      return {
        ...question,
        existingInput: { value, hasValue: value !== null },
        options: question.options.map((option) => ({
          ...option,
          selected: selectedValues.has(option.label),
        })),
      };
    });
    this.activePage = {
      ...this.activePage,
      form: { ...this.activePage.form, questions },
    };
    return this.activePage;
  }

  beginNext(document?: Document): void {
    const sourceDocument =
      document ??
      (typeof globalThis.document === 'object' ? globalThis.document : null);
    if (sourceDocument) {
      this.captureCurrentAnswers(sourceDocument, false);
    }
    this.oldPageDocument = sourceDocument;
    this.navigation = beginNextNavigation(this.activePage.form.activePageId);
  }

  confirmTransition(document: Document): NormalizedActivePage | null {
    if (!this.navigation) {
      return null;
    }
    const discovered = confirmPageTransition(document, this.navigation);
    if (!discovered) {
      return null;
    }

    return this.commitForwardTransition(discovered, document);
  }

  reconcileDocument(
    discovered: DiscoveredPage,
    document: Document,
    transition: DocumentPageTransition
  ): NormalizedActivePage {
    if (transition === 'forward') {
      return this.commitForwardTransition(discovered, document);
    }
    if (transition === 'backward') {
      return this.activateRevisit(discovered);
    }
    const normalizedPage = normalizeDiscoveredActivePage(discovered);
    if (this.isSamePage(this.activePage, normalizedPage)) {
      this.captureCurrentAnswers(document, false);
    }
    return this.resetForNewDocument(discovered);
  }

  abandon(): void {
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.generation.invalidate();
    this.visits[this.visits.length - 1].status = 'abandoned';
  }

  restart(): ProcessingCycle {
    this.abandon();
    this.activeCycle = this.generation.beginCycle();
    this.visits.push({
      pageId: this.activePage.form.activePageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activeCycle;
  }

  forceClear(): ProcessingCycle {
    const activePageId = this.activePage.form.activePageId;
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.revisitStatus = 'NEW';
    const remainingSettledPages = this.settledPages.filter(
      (settledPage) => settledPage.pageId !== activePageId
    );
    this.settledPages.splice(
      0,
      this.settledPages.length,
      ...remainingSettledPages
    );
    const remainingVisits = this.visits.filter(
      (visit) => visit.pageId !== activePageId
    );
    this.visits.splice(0, this.visits.length, ...remainingVisits);
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    this.activePage = {
      ...this.activePage,
      processingCycle: this.activeCycle,
      questionResults: this.activePage.questionResults.map((result) => ({
        ...result,
        status: result.status === 'unsupported' ? 'unsupported' : 'ready',
        answer: null,
        reason: null,
      })),
    };
    this.visits.push({
      pageId: this.activePage.form.activePageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activeCycle;
  }

  resynchronizeCurrentPage(discovered: DiscoveredPage): NormalizedActivePage {
    const previousPage = this.activePage;
    const normalizedPage = this.preserveKnownAnswers(
      previousPage,
      normalizeDiscoveredActivePage(discovered)
    );
    const samePage = this.isSamePage(previousPage, normalizedPage);
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    this.activePage = {
      ...normalizedPage,
      processingCycle: this.activeCycle,
    };
    if (samePage) {
      this.retainCapturedQuestionIds(this.activePage);
    } else {
      this.capturedQuestionIds.clear();
    }
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    const activeVisit = this.visits[this.visits.length - 1];
    if (activeVisit) {
      activeVisit.status = 'abandoned';
    }
    this.visits.push({
      pageId: discovered.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
  }

  synchronizeCurrentPage(
    discovered: DiscoveredPage
  ): 'unchanged' | 'resynchronized' | 'pending' {
    if (this.navigation) {
      return 'pending';
    }
    const normalizedPage = normalizeDiscoveredActivePage(discovered);
    const currentForm = this.activePage.form;
    const currentFingerprint =
      currentForm.pageFingerprint ?? computePageFingerprint(currentForm);
    const sameIdentity =
      currentForm.formId === normalizedPage.form.formId &&
      currentForm.activePageId === normalizedPage.form.activePageId &&
      currentFingerprint === normalizedPage.form.pageFingerprint;
    if (sameIdentity) {
      this.activePage = {
        ...this.preserveKnownAnswers(this.activePage, normalizedPage),
        processingCycle: this.activeCycle,
      };
      this.retainCapturedQuestionIds(this.activePage);
      return 'unchanged';
    }
    this.resynchronizeCurrentPage(discovered);
    return 'resynchronized';
  }

  handlePreviousOrBack(document: Document): NormalizedActivePage | null {
    const activePage = confirmPageTransition(document, {
      oldPageId: this.activePage.form.activePageId,
    });
    if (!activePage) {
      return null;
    }
    return this.activateRevisit(activePage);
  }

  private commitForwardTransition(
    discovered: DiscoveredPage,
    document: Document
  ): NormalizedActivePage {
    const sourceDocument = this.oldPageDocument ?? document;
    const pendingAtSettlement = this.pending && this.oldPageDocument
      ? capturePendingPageAtSettlement(
          this.oldPageDocument,
          this.activePage.form,
          this.pending
        )
      : this.pending;
    const committedPage = pendingAtSettlement
      ? commitPendingPageAfterSuccessfulTransition(
          pendingAtSettlement,
          { nextAcceptedAndTransitioned: true }
        )
      : null;
    const answersById = new Map<string, SettledPageState['answers'][number]>();
    for (const entry of committedPage?.answers ?? []) {
      if (entry.answer?.questionId) {
        answersById.set(entry.answer.questionId, entry);
      }
    }
    for (const question of this.activePage.form.questions) {
      if (!question.supported || question.id === null) continue;
      const capture = this.oldPageDocument
        ? captureAnswerSnapshot(
            sourceDocument,
            this.activePage.form,
            question.id
          )
        : { status: 'unavailable' as const, answer: null };
      if (capture.answer) {
        this.capturedQuestionIds.add(question.id);
        answersById.set(question.id, {
          answer: capture.answer,
          questionText:
            answersById.get(question.id)?.questionText ?? question.text ?? '',
        });
      } else if (
        this.capturedQuestionIds.has(question.id) &&
        question.existingInput?.hasValue !== true
      ) {
        answersById.delete(question.id);
      } else if (question.existingInput?.hasValue && question.existingInput.value) {
        answersById.set(question.id, {
          answer: {
            questionId: question.id,
            value: Array.isArray(question.existingInput.value)
              ? [...question.existingInput.value]
              : question.existingInput.value,
          },
          questionText:
            answersById.get(question.id)?.questionText ?? question.text ?? '',
        });
      }
    }
    const settledPage: SettledPageState = {
      pageId: this.activePage.form.activePageId,
      pageFingerprint:
        committedPage?.pageFingerprint ??
        this.activePage.form.pageFingerprint ??
        computePageFingerprint(this.activePage.form),
      answers: [...answersById.values()],
    };
    const existingIndex = this.settledPages.findIndex(
      (page) => page.pageId === settledPage.pageId
    );
    if (existingIndex >= 0) {
      this.settledPages[existingIndex] = settledPage;
    } else {
      this.settledPages.push(settledPage);
    }
    this.capturedQuestionIds.clear();
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.visits[this.visits.length - 1].status = 'settled';
    this.activeCycle = this.generation.beginCycle();
    this.activePage = normalizeDiscoveredActivePage(
      discovered,
      this.activeCycle.cycleId
    );
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    this.visits.push({
      pageId: discovered.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
  }

  private activateRevisit(discovered: DiscoveredPage): NormalizedActivePage {
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.capturedQuestionIds.clear();
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    const normalizedPage = normalizeDiscoveredActivePage(
      discovered,
      this.activeCycle.cycleId
    );
    const settledPage = this.settledPages.find(
      (page) => page.pageId === normalizedPage.form.activePageId
    );
    const settledPageMatches =
      settledPage &&
      (settledPage.pageFingerprint == null ||
        settledPage.pageFingerprint === normalizedPage.form.pageFingerprint);
    if (settledPageMatches) {
      const answersById = new Map(
        settledPage.answers.flatMap(({ answer }) =>
          answer ? [[answer.questionId, answer]] : []
        )
      );
      const questions = normalizedPage.form.questions.map((question) => {
        const answer = question.id === null ? undefined : answersById.get(question.id);
        return answer && question.existingInput?.hasValue !== true
          ? {
              ...question,
              existingInput: {
                value: Array.isArray(answer.value)
                  ? [...answer.value]
                  : answer.value,
                hasValue: true,
              },
            }
          : question;
      });
      this.activePage = {
        ...normalizedPage,
        form: { ...normalizedPage.form, questions },
        questionResults: questions.map((question) => ({
          questionId: question.id,
          status: question.supported ? 'ready' : 'unsupported',
          answer: null,
          reason: question.unsupportedReason,
        })),
      };
    } else {
      this.activePage = normalizedPage;
    }
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    this.visits[this.visits.length - 1].status = 'abandoned';
    this.visits.push({
      pageId: discovered.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
  }

  private resetForNewDocument(
    discovered: DiscoveredPage
  ): NormalizedActivePage {
    const previousPage = this.activePage;
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    this.activePage = normalizeDiscoveredActivePage(
      discovered,
      this.activeCycle.cycleId
    );
    this.activePage = this.preserveKnownAnswers(previousPage, this.activePage);
    if (this.isSamePage(previousPage, this.activePage)) {
      this.retainCapturedQuestionIds(this.activePage);
    } else {
      this.capturedQuestionIds.clear();
    }
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    this.visits[this.visits.length - 1].status = 'abandoned';
    this.visits.push({
      pageId: discovered.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
  }

  private isSamePage(
    previous: NormalizedActivePage,
    next: NormalizedActivePage
  ): boolean {
    return (
      previous.form.formId === next.form.formId &&
      previous.form.activePageId === next.form.activePageId
    );
  }

  private preserveKnownAnswers(
    previous: NormalizedActivePage,
    next: NormalizedActivePage
  ): NormalizedActivePage {
    if (!this.isSamePage(previous, next)) {
      return next;
    }
    const previousFingerprint =
      previous.form.pageFingerprint ?? computePageFingerprint(previous.form);
    const nextFingerprint =
      next.form.pageFingerprint ?? computePageFingerprint(next.form);
    if (previousFingerprint !== nextFingerprint) {
      return next;
    }
    const previousById = new Map(
      previous.form.questions
        .filter(
          (question) =>
            question.supported &&
            question.id !== null &&
            question.existingInput?.hasValue === true &&
            question.existingInput.value !== null
        )
        .map((question) => [question.id as string, question])
    );
    const questions = next.form.questions.map((question) => {
      if (
        !question.supported ||
        question.id === null ||
        question.existingInput?.hasValue === true
      ) {
        return question;
      }
      const previousQuestion = previousById.get(question.id);
      const previousInput = previousQuestion?.existingInput;
      if (
        !previousQuestion ||
        previousQuestion.type !== question.type ||
        !previousInput ||
        previousInput.value === null
      ) {
        return question;
      }
      const value = Array.isArray(previousInput.value)
        ? [...previousInput.value]
        : previousInput.value;
      const selectedValues = new Set(Array.isArray(value) ? value : [value]);
      return {
        ...question,
        existingInput: { value, hasValue: true },
        options: question.options.map((option) => ({
          ...option,
          selected: selectedValues.has(option.label),
        })),
      };
    });
    return { ...next, form: { ...next.form, questions } };
  }

  private retainCapturedQuestionIds(page: NormalizedActivePage): void {
    const questionIds = new Set(
      page.form.questions
        .filter((question) => question.supported && question.id !== null)
        .map((question) => question.id as string)
    );
    for (const questionId of this.capturedQuestionIds) {
      if (!questionIds.has(questionId)) {
        this.capturedQuestionIds.delete(questionId);
      }
    }
  }
}
