import { describe, expect, it, vi } from 'vitest';
import { PopupController } from '../src/Popup/Controller';
import { PopupStateMachine, type UiGenerationResult } from '../src/Popup/State';
import type { PopupWorkflow } from '../src/Popup/Workflow';

const page = { pageId: 'page-1', questionCount: 2 };
const result: UiGenerationResult = {
  report: { cycleId: 'cycle-1', status: 'partial', results: [] },
  fillReport: {
    cycleId: 'cycle-1',
    outcomes: [
      { questionId: 'name', status: 'FILLED', answer: null, reason: null, code: null },
      { questionId: 'other', status: 'PRESERVED_EXISTING', answer: null, reason: null, code: null },
      { questionId: 'partial', status: 'PARTIAL_FILL', answer: null, reason: 'Missing option', code: 'INVALID_OPTION' },
      { questionId: 'failed', status: 'FILL_FAILED', answer: null, reason: 'Missing', code: 'ELEMENT_NOT_FOUND' },
      { questionId: 'skipped', status: 'SKIPPED', answer: null, reason: 'Skipped', code: null },
    ],
  },
};

describe('P6 popup state machine', () => {
  it('supports all authoritative state transitions', () => {
    const machine = new PopupStateMachine();
    expect(machine.state.name).toBe('UNSUPPORTED');
    machine.setPage(page);
    expect(machine.state.name).toBe('READY');
    machine.beginGeneration();
    expect(machine.state.name).toBe('GENERATING');
    const token = machine.activeOperationToken;
    machine.completeGeneration(token, result);
    expect(machine.state.name).toBe('REVIEW');
    machine.finishReview();
    expect(machine.state.name).toBe('READY_FOR_NEXT');
    machine.beginGeneration();
    expect(machine.state.name).toBe('GENERATING');
    machine.failGeneration(machine.activeOperationToken, 'failed');
    expect(machine.state.name).toBe('ERROR');
    machine.beginGeneration();
    expect(machine.state.name).toBe('GENERATING');
  });

  it('ignores stale generation results and preserves rejected navigation state', () => {
    const machine = new PopupStateMachine();
    machine.setPage(page);
    machine.beginGeneration();
    const staleToken = machine.activeOperationToken;
    machine.setPage(page);
    machine.completeGeneration(staleToken, result);
    expect(machine.state.name).toBe('READY');
    expect(machine.rejectedNext().name).toBe('READY');
  });

  it('moves confirmed supported and unsupported pages to current page states', () => {
    const machine = new PopupStateMachine();
    expect(machine.confirmedPage(page).name).toBe('READY');
    expect(machine.confirmedPage(null).name).toBe('UNSUPPORTED');
  });
});

describe('P6 popup workflow boundary', () => {
  it('delegates discovery and generation without owning cycle IDs', async () => {
    const workflow: PopupWorkflow = {
      discover: vi.fn(async () => page),
      generate: vi.fn(async () => result),
    };
    const controller = new PopupController(workflow);
    await expect(controller.discover()).resolves.toMatchObject({ name: 'READY' });
    await expect(controller.generate()).resolves.toMatchObject({ name: 'REVIEW' });
    expect(workflow.discover).toHaveBeenCalledOnce();
    expect(workflow.generate).toHaveBeenCalledOnce();
  });

  it('enters ERROR on generation failure and retries through the workflow', async () => {
    const workflow: PopupWorkflow = {
      discover: vi.fn(async () => page),
      generate: vi.fn()
        .mockRejectedValueOnce(new Error('Backend unavailable'))
        .mockResolvedValueOnce(result),
    };
    const controller = new PopupController(workflow);
    await controller.discover();
    await expect(controller.generate()).resolves.toMatchObject({ name: 'ERROR' });
    await expect(controller.retry()).resolves.toMatchObject({ name: 'REVIEW' });
    expect(workflow.generate).toHaveBeenCalledTimes(2);
    expect(workflow.generate).toHaveBeenNthCalledWith(1, false);
    expect(workflow.generate).toHaveBeenNthCalledWith(2, true);
  });

  it('does not expose Generate on an unsupported page', async () => {
    const workflow: PopupWorkflow = {
      discover: vi.fn(async () => null),
      generate: vi.fn(async () => result),
    };
    const controller = new PopupController(workflow);
    await controller.discover();
    await controller.generate();
    expect(controller.state.name).toBe('UNSUPPORTED');
    expect(workflow.generate).not.toHaveBeenCalled();
  });
});
