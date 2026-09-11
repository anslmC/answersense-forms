import { describe, expect, it } from 'vitest';
import type { DiscoveredPage } from '../src/Forms/Discovery';
import type { LifecycleSnapshot } from '../src/Lifecycle/PageLifecycle';
import { belongsToSameForm } from '../src/Content/Identity';

function snapshot(formId: string | null): LifecycleSnapshot {
  return {
    activePage: {
      form: { formId, activePageId: 'entry:0-3', questions: [] },
      questionResults: [],
      processingCycle: { cycleId: 'cycle-1' },
    },
    activeCycle: { cycleId: 'cycle-1' },
    pending: null,
    settledPages: [],
    visits: [{ pageId: 'entry:0-3', cycleId: 'cycle-1', status: 'active' }],
    navigation: null,
  };
}

function discovered(formId: string | null): DiscoveredPage {
  return {
    formId,
    pageId: 'entry:3-6',
    questions: [],
  };
}

describe('Content form identity hydration guard', () => {
  it('allows hydration when canonical form IDs match', () => {
    expect(belongsToSameForm(snapshot('form-1'), discovered('form-1'))).toBe(
      true
    );
  });

  it('rejects hydration when canonical form IDs differ', () => {
    expect(belongsToSameForm(snapshot('form-1'), discovered('form-2'))).toBe(
      false
    );
  });

  it('rejects hydration when the cached form identity is missing', () => {
    expect(belongsToSameForm(snapshot(null), discovered('form-1'))).toBe(false);
  });

  it('rejects hydration when the discovered form identity is missing', () => {
    expect(belongsToSameForm(snapshot('form-1'), discovered(null))).toBe(false);
  });

  it('allows hydration when form identity is unavailable but the page is unchanged', () => {
    const samePageSnapshot = snapshot(null);
    samePageSnapshot.activePage.form.activePageId = 'entry:3-6';

    expect(belongsToSameForm(samePageSnapshot, discovered(null))).toBe(true);
  });
});
