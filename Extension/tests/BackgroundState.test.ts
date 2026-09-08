import { describe, expect, it } from 'vitest';
import {
  IntegrationStateStore,
  reconcileContentState,
} from '../src/Background/State';
import type { LifecycleSnapshot } from '../src/Lifecycle/PageLifecycle';

function lifecycle(
  pageId: string,
  cycleId: string,
  pathname = '/formResponse',
  formId = 'form-1'
): LifecycleSnapshot {
  return {
    activePage: {
      form: {
        formId,
        activePageId: pageId,
        questions: [],
        pageFingerprint: `${pageId}-fingerprint`,
      },
      questionResults: [],
      processingCycle: { cycleId },
    },
    activeCycle: { cycleId },
    pending: null,
    settledPages: [],
    visits: [{ pageId, cycleId, status: 'active' }],
    navigation: null,
    revisitStatus: 'NEW',
    documentPathname: pathname,
  };
}

describe('P7 worker integration state', () => {
  it('retains lifecycle and popup recovery state per tab without owning domain decisions', () => {
    const store = new IntegrationStateStore();
    const snapshot = store.update(7, {
      uiState: 'READY_FOR_NEXT',
      page: { pageId: 'page-1', questionCount: 2 },
      result: null,
      error: null,
    });

    expect(store.get(7)).toEqual(snapshot);
    expect(store.get(8)).toBeNull();
    expect(store.update(7, { uiState: 'GENERATING' })).toMatchObject({
      uiState: 'GENERATING',
      page: { pageId: 'page-1', questionCount: 2 },
    });
  });

  it('prefers a current content page over a stale worker page', () => {
    const stale = {
      lifecycle: lifecycle('entry:0-3', 'cycle-1', '/viewform'),
      uiState: 'REVIEW' as const,
      page: { pageId: 'entry:0-3', questionCount: 3 },
      result: { status: 'reused' as const, pageId: 'entry:0-3' },
      error: null,
    };
    const current = reconcileContentState(stale, {
      lifecycle: lifecycle('entry:3-6', 'cycle-2'),
      page: { pageId: 'entry:3-6', questionCount: 2 },
    });

    expect(current.page).toEqual({ pageId: 'entry:3-6', questionCount: 2 });
    expect(current.uiState).toBe('READY');
    expect(current.result).toBeNull();
  });

  it('preserves the UI projection when worker and content are current', () => {
    const currentLifecycle = lifecycle('entry:3-6', 'cycle-2');
    const current = reconcileContentState(
      {
        lifecycle: currentLifecycle,
        uiState: 'REVIEW',
        page: { pageId: 'entry:3-6', questionCount: 2 },
        result: { status: 'reused', pageId: 'entry:3-6' },
        error: null,
      },
      {
        lifecycle: currentLifecycle,
        page: { pageId: 'entry:3-6', questionCount: 2 },
      }
    );

    expect(current.uiState).toBe('REVIEW');
    expect(current.result).toEqual({
      status: 'reused',
      pageId: 'entry:3-6',
    });
  });

  it('updates when settled page state changes on the same page and cycle', () => {
    const currentLifecycle = lifecycle('entry:3-6', 'cycle-2');
    const worker = {
      lifecycle: currentLifecycle,
      uiState: 'READY' as const,
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    };
    const contentLifecycle = {
      ...currentLifecycle,
      settledPages: [
        {
          pageId: 'entry:0-3',
          pageFingerprint: 'fingerprint',
          answers: [],
        },
      ],
    };

    expect(
      reconcileContentState(worker, {
        lifecycle: contentLifecycle,
        page: worker.page,
      })
    ).not.toBe(worker);
  });

  it('updates when pending state changes on the same page and cycle', () => {
    const currentLifecycle = lifecycle('entry:3-6', 'cycle-2');
    const worker = {
      lifecycle: currentLifecycle,
      uiState: 'READY' as const,
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    };
    const contentLifecycle = {
      ...currentLifecycle,
      pending: {
        cycleId: 'cycle-2',
        pageId: 'entry:3-6',
        answers: [],
        outcomes: [],
      },
    };

    expect(
      reconcileContentState(worker, {
        lifecycle: contentLifecycle,
        page: worker.page,
      })
    ).not.toBe(worker);
  });

  it('updates when visit history changes on the same page and cycle', () => {
    const currentLifecycle = lifecycle('entry:3-6', 'cycle-2');
    const worker = {
      lifecycle: currentLifecycle,
      uiState: 'READY' as const,
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    };
    const contentLifecycle = {
      ...currentLifecycle,
      visits: [
        ...currentLifecycle.visits,
        { pageId: 'entry:0-3', cycleId: 'cycle-1', status: 'settled' as const },
      ],
    };

    expect(
      reconcileContentState(worker, {
        lifecycle: contentLifecycle,
        page: worker.page,
      })
    ).not.toBe(worker);
  });

  it('does not treat a different form, page, or cycle as equivalent', () => {
    const worker = {
      lifecycle: lifecycle('entry:3-6', 'cycle-2'),
      uiState: 'READY' as const,
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    };

    for (const next of [
      lifecycle('entry:4-7', 'cycle-2'),
      lifecycle('entry:3-6', 'cycle-3'),
      lifecycle('entry:3-6', 'cycle-2', '/formResponse', 'form-2'),
    ]) {
      expect(
        reconcileContentState(worker, {
          lifecycle: next,
          page: { pageId: next.activePage.form.activePageId, questionCount: 2 },
        })
      ).not.toBe(worker);
    }
  });

  it('falls back to an existing worker snapshot when content state is unavailable', () => {
    const stale = {
      lifecycle: lifecycle('entry:0-3', 'cycle-1'),
      uiState: 'READY' as const,
      page: { pageId: 'entry:0-3', questionCount: 3 },
      result: null,
      error: null,
    };

    expect(reconcileContentState(stale, { lifecycle: null, page: null })).toBe(
      stale
    );
    expect(
      reconcileContentState(null, { lifecycle: null, page: null })
    ).toMatchObject({ uiState: 'UNSUPPORTED', page: null });
  });

  it('keeps same-form states isolated by the worker tab store', () => {
    const store = new IntegrationStateStore();
    store.set(1, {
      lifecycle: lifecycle('entry:0-3', 'cycle-a'),
      uiState: 'READY',
      page: { pageId: 'entry:0-3', questionCount: 3 },
      result: null,
      error: null,
    });
    store.set(2, {
      lifecycle: lifecycle('entry:3-6', 'cycle-b'),
      uiState: 'READY',
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    });

    expect(store.get(1)?.page?.pageId).toBe('entry:0-3');
    expect(store.get(2)?.page?.pageId).toBe('entry:3-6');
  });
});
