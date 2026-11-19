import { describe, expect, it } from 'vitest';
import {
  calculateProgressPercent,
  generationProgressText,
  isGenerationProgress,
  isGenerationProgressUpdate,
  mergeGenerationProgress,
  type GenerationProgress,
} from '../src/Generation/Progress';

function progress(
  overrides: Partial<GenerationProgress> = {}
): GenerationProgress {
  return {
    generationOperationId: 'operation-1',
    sequence: 1,
    candidateQuestionCount: 10,
    phase: 'GENERATING',
    determinate: true,
    completedUnits: 0,
    totalUnits: 10,
    ...overrides,
  };
}

describe('generation progress', () => {
  it('validates complete progress and rejects legacy candidate-only progress', () => {
    expect(isGenerationProgress(progress())).toBe(true);
    expect(isGenerationProgress({ candidateQuestionCount: 3 })).toBe(false);
    expect(
      isGenerationProgressUpdate({
        phase: 'FILLING',
        determinate: true,
        completedUnits: 1,
        totalUnits: 2,
      })
    ).toBe(true);
  });

  it('never reports 100% while the operation is active', () => {
    expect(
      calculateProgressPercent(
        progress({ phase: 'GENERATING', completedUnits: 10, totalUnits: 10 })
      )
    ).toBe(55);
    expect(
      calculateProgressPercent(
        progress({ phase: 'FINALIZING', completedUnits: 1, totalUnits: 1 })
      )
    ).toBe(99);
    expect(
      calculateProgressPercent(
        progress({ phase: 'FILLING', completedUnits: 200, totalUnits: 10 })
      )
    ).toBe(85);
  });

  it('reports the phase start for indeterminate work', () => {
    expect(
      calculateProgressPercent(
        progress({
          phase: 'GENERATING',
          determinate: false,
          completedUnits: 0,
          totalUnits: 10,
        })
      )
    ).toBe(5);
  });

  it('describes determinate and indeterminate phases', () => {
    expect(
      generationProgressText(progress({ completedUnits: 3, totalUnits: 10 }))
    ).toBe('Generating answers… 3 of 10');
    expect(
      generationProgressText(
        progress({
          phase: 'PREPARING',
          determinate: false,
          totalUnits: 0,
        })
      )
    ).toBe('Preparing page…');
  });

  it('keeps phases, completed units, and candidate counts monotonic', () => {
    const first = mergeGenerationProgress(
      null,
      {
        phase: 'GENERATING',
        determinate: false,
        completedUnits: 0,
        totalUnits: 10,
        candidateQuestionCount: 10,
      },
      'operation-1',
      1
    );
    expect(first.determinate).toBe(false);

    const determinate = mergeGenerationProgress(
      first,
      {
        phase: 'GENERATING',
        determinate: true,
        completedUnits: 4,
        totalUnits: 10,
      },
      'operation-1',
      2
    );
    expect(determinate.determinate).toBe(true);
    expect(determinate.completedUnits).toBe(4);

    const regressed = mergeGenerationProgress(
      determinate,
      {
        phase: 'PREPARING',
        determinate: false,
        completedUnits: 0,
        totalUnits: 0,
      },
      'operation-1',
      3
    );
    expect(regressed.phase).toBe('GENERATING');
    expect(regressed.determinate).toBe(true);
    expect(regressed.completedUnits).toBe(4);
    expect(regressed.candidateQuestionCount).toBe(10);

    const advanced = mergeGenerationProgress(
      regressed,
      {
        phase: 'FILLING',
        determinate: true,
        completedUnits: 1,
        totalUnits: 3,
      },
      'operation-1',
      4
    );
    expect(advanced.phase).toBe('FILLING');
    expect(advanced.completedUnits).toBe(1);
    expect(advanced.totalUnits).toBe(3);
    expect(advanced.sequence).toBe(4);
  });
});
