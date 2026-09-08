import type { NormalizedActivePage, ProcessingCycle } from '../Models/Logical';
import { computePageFingerprint, normalizeDiscoveredActivePage } from '../Forms/Normalization';
import type { FinalizedPageHandoff } from '../Fill/Handoff';
import {
  capturePendingPageAtSettlement,
  commitPendingPageAfterSuccessfulTransition,
  createPendingPageStateFromHandoff,
  type PendingPageState,
} from '../Generation/Pending';
import { buildSettledContext, type SettledPageState } from '../Generation/Context';
import { GenerationCoordinator } from '../Generation/Pipeline';
import {
  beginNextNavigation,
  confirmPageTransition,
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
  visits: readonly PageVisit[];
  navigation: PendingNavigation | null;
  revisitStatus?: PageRevisitStatus;
}

export class PageLifecycle {
  private activePage: NormalizedActivePage;
  private activeCycle: ProcessingCycle;
  private pending: PendingPageState | null = null;
  private navigation: PendingNavigation | null = null;
  private oldPageDocument: Document | null = null;
  private revisitStatus: PageRevisitStatus = 'NEW';
  private readonly settledPages: SettledPageState[] = [];
  private readonly visits: PageVisit[] = [];

  constructor(
    initialPage: NormalizedActivePage,
    private readonly generation: GenerationCoordinator,
    snapshot?: LifecycleSnapshot,
  ) {
    if (snapshot) {
      this.activePage = initialPage;
      this.activeCycle = snapshot.activeCycle;
      this.pending = snapshot.pending;
      this.settledPages.push(...snapshot.settledPages);
      this.visits.push(...snapshot.visits);
      this.navigation = snapshot.navigation;
      this.revisitStatus = snapshot.revisitStatus ?? 'NEW';
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
    const existing = this.settledPages.find((candidate) => candidate.pageId === page.form.activePageId);
    if (!existing) {
      return 'NEW';
    }
    const candidateFingerprint = page.form.pageFingerprint ?? computePageFingerprint(page.form);
    return existing.pageFingerprint === candidateFingerprint
      ? 'UNCHANGED_REVISIT'
      : 'CHANGED_REVISIT';
  }

  getSnapshot(): LifecycleSnapshot {
    return {
      activePage: this.activePage,
      activeCycle: this.activeCycle,
      pending: this.pending,
      settledPages: this.settledPages,
      visits: this.visits,
      navigation: this.navigation,
      revisitStatus: this.revisitStatus,
    };
  }

  acceptFinalizedHandoff(handoff: FinalizedPageHandoff): PendingPageState {
    if (
      handoff.pageId !== this.activePage.form.activePageId ||
      handoff.cycleId !== this.activeCycle.cycleId
    ) {
      throw new Error('Finalized handoff does not belong to the active page visit.');
    }
    this.pending = createPendingPageStateFromHandoff(handoff);
    return this.pending;
  }

  beginNext(document?: Document): void {
    this.oldPageDocument = document ?? (typeof globalThis.document === 'object' ? globalThis.document : null);
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

    if (this.pending) {
      const settledPending = capturePendingPageAtSettlement(
        this.oldPageDocument ?? document,
        this.activePage.form,
        this.pending,
      );
      const settledPage = commitPendingPageAfterSuccessfulTransition(
        settledPending,
        {
          nextAcceptedAndTransitioned: true,
        },
      );
      const existingIndex = this.settledPages.findIndex(
        (page) => page.pageId === settledPage.pageId,
      );
      if (existingIndex >= 0) {
        this.settledPages[existingIndex] = settledPage;
      } else {
        this.settledPages.push(settledPage);
      }
    }
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.visits[this.visits.length - 1].status = 'settled';
    this.activeCycle = this.generation.beginCycle();
    this.activePage = normalizeDiscoveredActivePage(discovered, this.activeCycle.cycleId);
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    this.visits.push({
      pageId: discovered.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
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

  retryGeneration(): ProcessingCycle {
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    this.activePage = { ...this.activePage, processingCycle: this.activeCycle };
    const activeVisit = this.visits[this.visits.length - 1];
    if (activeVisit) {
      activeVisit.cycleId = this.activeCycle.cycleId;
    }
    return this.activeCycle;
  }

  handlePreviousOrBack(document: Document): NormalizedActivePage | null {
    const activePage = confirmPageTransition(document, {
      oldPageId: this.activePage.form.activePageId,
    });
    if (!activePage) {
      return null;
    }
    this.pending = null;
    this.navigation = null;
    this.oldPageDocument = null;
    this.generation.invalidate();
    this.activeCycle = this.generation.beginCycle();
    this.activePage = normalizeDiscoveredActivePage(activePage, this.activeCycle.cycleId);
    this.revisitStatus = this.classifyPageRevisit(this.activePage);
    this.visits[this.visits.length - 1].status = 'abandoned';
    this.visits.push({
      pageId: activePage.pageId,
      cycleId: this.activeCycle.cycleId,
      status: 'active',
    });
    return this.activePage;
  }
}
