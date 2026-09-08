import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_STATE_STORAGE_KEY,
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

function sessionStorage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key: string) {
      return { [key]: values[key] };
    },
    async set(update: Record<string, unknown>) {
      Object.assign(values, update);
    },
  };
}

describe('P7 worker integration state', () => {
  it('restores valid state after the in-memory store is recreated', async () => {
    const storage = sessionStorage();
    const firstWorker = new IntegrationStateStore(storage);
    await firstWorker.update(10, {
      lifecycle: lifecycle('page-2', 'cycle-2'),
      uiState: 'READY',
      page: { pageId: 'page-2', questionCount: 2 },
      result: null,
      error: null,
    });

    const restartedWorker = new IntegrationStateStore(storage);
    await expect(restartedWorker.get(10)).resolves.toMatchObject({
      page: { pageId: 'page-2', questionCount: 2 },
      lifecycle: { activeCycle: { cycleId: 'cycle-2' } },
    });
  });

  it('ignores malformed stored entries without blocking valid state', async () => {
    const storage = sessionStorage({
      [INTEGRATION_STATE_STORAGE_KEY]: {
        '10': { uiState: 'INVALID' },
        '11': {
          lifecycle: lifecycle('page-1', 'cycle-1'),
          uiState: 'READY',
          page: { pageId: 'page-1', questionCount: 1 },
          result: null,
          error: null,
        },
      },
    });

    const store = new IntegrationStateStore(storage);
    await expect(store.get(10)).resolves.toBeNull();
    await expect(store.get(11)).resolves.toMatchObject({
      page: { pageId: 'page-1' },
    });
  });

  it('removes one closed tab without affecting another tab', async () => {
    const storage = sessionStorage();
    const store = new IntegrationStateStore(storage);
    await store.set(10, {
      lifecycle: lifecycle('page-1', 'cycle-1'),
      uiState: 'READY',
      page: { pageId: 'page-1', questionCount: 1 },
      result: null,
      error: null,
    });
    await store.set(11, {
      lifecycle: lifecycle('page-2', 'cycle-2'),
      uiState: 'READY',
      page: { pageId: 'page-2', questionCount: 2 },
      result: null,
      error: null,
    });

    await store.remove(10);

    await expect(store.get(10)).resolves.toBeNull();
    await expect(store.get(11)).resolves.toMatchObject({
      page: { pageId: 'page-2' },
    });
    expect(storage.values[INTEGRATION_STATE_STORAGE_KEY]).toEqual({
      '11': await store.get(11),
    });
  });

  it('does not carry Form A state into a recycled tab displaying Form B', async () => {
    const storage = sessionStorage();
    const firstWorker = new IntegrationStateStore(storage);
    await firstWorker.set(10, {
      lifecycle: lifecycle('page-2', 'cycle-a', '/viewform', 'form-a'),
      uiState: 'READY',
      page: { pageId: 'page-2', questionCount: 2 },
      result: null,
      error: null,
    });
    await firstWorker.remove(10);

    const recycledWorker = new IntegrationStateStore(storage);
    await expect(recycledWorker.get(10)).resolves.toBeNull();
    await recycledWorker.set(10, {
      lifecycle: lifecycle('page-1', 'cycle-b', '/viewform', 'form-b'),
      uiState: 'READY',
      page: { pageId: 'page-1', questionCount: 1 },
      result: null,
      error: null,
    });

    await expect(recycledWorker.get(10)).resolves.toMatchObject({
      lifecycle: { activePage: { form: { formId: 'form-b' } } },
      page: { pageId: 'page-1' },
    });
  });

  it('retains lifecycle and popup recovery state per tab without owning domain decisions', async () => {
    const store = new IntegrationStateStore();
    const snapshot = await store.update(7, {
      uiState: 'READY_FOR_NEXT',
      page: { pageId: 'page-1', questionCount: 2 },
      result: null,
      error: null,
    });

    await expect(store.get(7)).resolves.toEqual(snapshot);
    await expect(store.get(8)).resolves.toBeNull();
    await expect(store.update(7, { uiState: 'GENERATING' })).resolves.toMatchObject({
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

  it('keeps same-form states isolated by the worker tab store', async () => {
    const store = new IntegrationStateStore();
    await store.set(1, {
      lifecycle: lifecycle('entry:0-3', 'cycle-a'),
      uiState: 'READY',
      page: { pageId: 'entry:0-3', questionCount: 3 },
      result: null,
      error: null,
    });
    await store.set(2, {
      lifecycle: lifecycle('entry:3-6', 'cycle-b'),
      uiState: 'READY',
      page: { pageId: 'entry:3-6', questionCount: 2 },
      result: null,
      error: null,
    });

    expect((await store.get(1))?.page?.pageId).toBe('entry:0-3');
    expect((await store.get(2))?.page?.pageId).toBe('entry:3-6');
  });
});
