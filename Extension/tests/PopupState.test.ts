import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopupController } from '../src/Popup/Controller';
import {
  createAllOverrideIntent,
  createSpecificOverrideIntent,
  filledSupportedQuestions,
  overrideQuestionLabel,
  PopupStateMachine,
  type UiGenerationResult,
  type WorkflowSnapshot,
} from '../src/Popup/State';
import { readFileSync as readPopupSource } from 'node:fs';
import type { PopupWorkflow } from '../src/Popup/Workflow';

const page = { pageId: 'page-1', questionCount: 2 };
const result: UiGenerationResult = {
  report: { cycleId: 'cycle-1', status: 'partial', results: [] },
  fillReport: {
    cycleId: 'cycle-1',
    outcomes: [
      {
        questionId: 'name',
        status: 'FILLED',
        answer: null,
        reason: null,
        code: null,
      },
      {
        questionId: 'other',
        status: 'PRESERVED_EXISTING',
        answer: null,
        reason: null,
        code: null,
      },
      {
        questionId: 'partial',
        status: 'PARTIAL_FILL',
        answer: null,
        reason: 'Missing option',
        code: 'INVALID_OPTION',
      },
      {
        questionId: 'failed',
        status: 'FILL_FAILED',
        answer: null,
        reason: 'Missing',
        code: 'ELEMENT_NOT_FOUND',
      },
      {
        questionId: 'skipped',
        status: 'SKIPPED',
        answer: null,
        reason: 'Skipped',
        code: null,
      },
    ],
  },
};

const overridePage = {
  pageId: 'page-override',
  questionCount: 5,
  questions: [
    {
      id: 'first', text: 'First answer', type: 'short-text', supported: true,
      existingInput: { hasValue: true },
    },
    {
      id: 'unanswered', text: 'Unanswered', type: 'short-text', supported: true,
      existingInput: { hasValue: false },
    },
    {
      id: 'third', text: 'Third answer', type: 'paragraph', supported: true,
      existingInput: { hasValue: true },
    },
    {
      id: 'unsupported', text: 'Unsupported', type: null, supported: false,
      existingInput: null,
    },
    {
      id: '', text: 'Invalid identity', type: 'short-text', supported: true,
      existingInput: { hasValue: true },
    },
  ],
};

describe('P6 popup state machine', () => {
  it('filters Override choices to filled supported valid questions', () => {
    expect(filledSupportedQuestions(overridePage).map((question) => question.id)).toEqual([
      'first',
      'third',
    ]);
    expect(overrideQuestionLabel(overridePage.questions[0], 0)).toBe(
      'Q1 — First answer'
    );
    expect(overrideQuestionLabel(overridePage.questions[2], 2)).toBe(
      'Q3 — Third answer'
    );
  });

  it('freezes All and Specific concrete question IDs', () => {
    const all = createAllOverrideIntent(overridePage);
    const specific = createSpecificOverrideIntent(['first', 'third']);

    expect(all).toEqual({
      type: 'OVERRIDE_FILLED',
      selectedQuestionIds: ['first', 'third'],
    });
    expect(specific.selectedQuestionIds).toEqual(['first', 'third']);
    expect(Object.isFrozen(all.selectedQuestionIds)).toBe(true);
    expect(Object.isFrozen(specific.selectedQuestionIds)).toBe(true);
    expect(JSON.stringify(all)).not.toContain('First answer');
  });

  it('exposes Override controls without invoking generation', () => {
    const source = readPopupSource(
      resolve(process.cwd(), 'src/Popup/WorkflowApp.ts'),
      'utf8'
    );
    const markup = readPopupSource(
      resolve(process.cwd(), 'src/Popup/Popup.html'),
      'utf8'
    );

    expect(markup).toContain('Override Filled Answer(s)');
    expect(markup).toContain('All filled answers');
    expect(markup).toContain('Specific question(s)');
    expect(markup).toContain('data-override-cancel');
    expect(markup).toContain('data-override-confirm');
    expect(source).toContain('state.name !== \'REVIEW\' || filledQuestions.length === 0;');
    expect(source).toContain('publishOverrideIntent');
  });

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
    machine.beginGeneration();
    expect(machine.state.name).toBe('REVIEW');
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
      forceClear: vi.fn(async (): Promise<WorkflowSnapshot> => ({
        uiState: 'READY',
        page,
        result: null,
        error: null,
      })),
    };
    const controller = new PopupController(workflow);
    await expect(controller.discover()).resolves.toMatchObject({
      name: 'READY',
    });
    await expect(controller.generate()).resolves.toMatchObject({
      name: 'REVIEW',
    });
    expect(workflow.discover).toHaveBeenCalledOnce();
    expect(workflow.generate).toHaveBeenCalledOnce();
  });

  it('enters ERROR on generation failure without exposing a retry action', async () => {
    const workflow: PopupWorkflow = {
      discover: vi.fn(async () => page),
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('Backend unavailable')),
      forceClear: vi.fn(async (): Promise<WorkflowSnapshot> => ({
        uiState: 'READY',
        page,
        result: null,
        error: null,
      })),
    };
    const controller = new PopupController(workflow);
    await controller.discover();
    await expect(controller.generate()).resolves.toMatchObject({
      name: 'ERROR',
    });
    await expect(controller.generate()).resolves.toMatchObject({
      name: 'ERROR',
    });
    expect(workflow.generate).toHaveBeenCalledOnce();
  });

  it('projects READY after same-page post-fill discovery', async () => {
    const workflow: PopupWorkflow = {
      discover: vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce({
          uiState: 'READY',
          page,
          result: null,
          error: null,
        }),
      generate: vi.fn(async () => result),
      forceClear: vi.fn(async (): Promise<WorkflowSnapshot> => ({
        uiState: 'READY',
        page,
        result: null,
        error: null,
      })),
    };
    const controller = new PopupController(workflow);

    await controller.discover();
    const completed = await controller.generate();
    const rediscovered = await controller.discover();

    expect(completed).toEqual({ name: 'REVIEW', page, result });
    expect(rediscovered).toEqual({ name: 'READY', page });
    expect(controller.state).toEqual(rediscovered);
  });

  it('allows a different page discovery to replace the completed review', async () => {
    const nextPage = { pageId: 'page-2', questionCount: 1 };
    const workflow: PopupWorkflow = {
      discover: vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce({
          uiState: 'READY',
          page: nextPage,
          result: null,
          error: null,
        }),
      generate: vi.fn(async () => result),
      forceClear: vi.fn(async (): Promise<WorkflowSnapshot> => ({
        uiState: 'READY',
        page: nextPage,
        result: null,
        error: null,
      })),
    };
    const controller = new PopupController(workflow);

    await controller.discover();
    await controller.generate();

    await expect(controller.discover()).resolves.toEqual({
      name: 'READY',
      page: nextPage,
    });
  });

  it('keeps the completed bar and omits preserved answers from the summary', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/Popup/WorkflowApp.ts'),
      'utf8'
    );

    expect(source).toContain("progress.classList.add('is-complete');");
    expect(source).toContain("progressFill.style.width = '100%';");
    expect(source).not.toContain('alreadyFilledCount');
    expect(source).not.toContain('already filled');
    expect(result.fillReport.outcomes).toContainEqual(
      expect.objectContaining({ status: 'PRESERVED_EXISTING' })
    );
  });

  it('does not expose Generate on an unsupported page', async () => {
    const workflow: PopupWorkflow = {
      discover: vi.fn(async () => null),
      generate: vi.fn(async () => result),
      forceClear: vi.fn(async (): Promise<WorkflowSnapshot> => ({
        uiState: 'READY',
        page: null,
        result: null,
        error: null,
      })),
    };
    const controller = new PopupController(workflow);
    await controller.discover();
    await controller.generate();
    expect(controller.state.name).toBe('UNSUPPORTED');
    expect(workflow.generate).not.toHaveBeenCalled();
  });

  it('converts an invalid completed result into a visible error state', () => {
    const machine = new PopupStateMachine();
    machine.confirmedPage(page);
    const generating = machine.beginGeneration();

    expect(machine.completeGeneration(machine.activeOperationToken, {} as never)).toMatchObject({
      name: 'ERROR',
      message: 'Generation returned an invalid result.',
    });
    expect(generating.name).toBe('GENERATING');
  });
});
