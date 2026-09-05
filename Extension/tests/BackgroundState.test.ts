import { describe, expect, it } from 'vitest';
import { IntegrationStateStore } from '../src/Background/State';

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
});
