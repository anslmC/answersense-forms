export type GenerationPhase =
  | 'PREPARING'
  | 'GENERATING'
  | 'VALIDATING'
  | 'FILLING'
  | 'VERIFYING'
  | 'FINALIZING';

export const GENERATION_PHASES: readonly GenerationPhase[] = Object.freeze([
  'PREPARING',
  'GENERATING',
  'VALIDATING',
  'FILLING',
  'VERIFYING',
  'FINALIZING',
]);

export interface GenerationProgress {
  readonly generationOperationId: string;
  readonly sequence: number;
  readonly candidateQuestionCount: number;
  readonly phase: GenerationPhase;
  readonly determinate: boolean;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface GenerationProgressUpdate {
  readonly candidateQuestionCount?: number;
  readonly phase: GenerationPhase;
  readonly determinate: boolean;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

const PHASE_RANK: Readonly<Record<GenerationPhase, number>> = Object.freeze({
  PREPARING: 0,
  GENERATING: 1,
  VALIDATING: 2,
  FILLING: 3,
  VERIFYING: 4,
  FINALIZING: 5,
});

const PHASE_BANDS: Readonly<
  Record<GenerationPhase, readonly [number, number]>
> = Object.freeze({
  PREPARING: [0, 5],
  GENERATING: [5, 55],
  VALIDATING: [55, 65],
  FILLING: [65, 85],
  VERIFYING: [85, 95],
  FINALIZING: [95, 99],
});

const PHASE_TEXT: Readonly<Record<GenerationPhase, string>> = Object.freeze({
  PREPARING: 'Preparing page…',
  GENERATING: 'Generating answers…',
  VALIDATING: 'Validating answers…',
  FILLING: 'Filling answers…',
  VERIFYING: 'Verifying answers…',
  FINALIZING: 'Finishing up…',
});

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isGenerationPhase(value: unknown): value is GenerationPhase {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PHASE_RANK, value)
  );
}

export function isGenerationProgress(
  value: unknown
): value is GenerationProgress {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.generationOperationId === 'string' &&
    candidate.generationOperationId.length > 0 &&
    isNonNegativeSafeInteger(candidate.sequence) &&
    isNonNegativeSafeInteger(candidate.candidateQuestionCount) &&
    isGenerationPhase(candidate.phase) &&
    typeof candidate.determinate === 'boolean' &&
    isNonNegativeSafeInteger(candidate.completedUnits) &&
    isNonNegativeSafeInteger(candidate.totalUnits)
  );
}

export function isGenerationProgressUpdate(
  value: unknown
): value is GenerationProgressUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.candidateQuestionCount === undefined ||
      isNonNegativeSafeInteger(candidate.candidateQuestionCount)) &&
    isGenerationPhase(candidate.phase) &&
    typeof candidate.determinate === 'boolean' &&
    isNonNegativeSafeInteger(candidate.completedUnits) &&
    isNonNegativeSafeInteger(candidate.totalUnits)
  );
}

export function generationPhaseRank(phase: GenerationPhase): number {
  return PHASE_RANK[phase];
}

export function calculateProgressPercent(progress: GenerationProgress): number {
  const [start, end] = PHASE_BANDS[progress.phase];
  if (!progress.determinate || progress.totalUnits <= 0) {
    return start;
  }
  const ratio = Math.min(
    1,
    Math.max(0, progress.completedUnits / progress.totalUnits)
  );
  return Math.min(99, Math.max(0, Math.round(start + (end - start) * ratio)));
}

export function generationProgressText(progress: GenerationProgress): string {
  const base = PHASE_TEXT[progress.phase];
  if (!progress.determinate || progress.totalUnits <= 0) {
    return base;
  }
  const completed = Math.min(progress.completedUnits, progress.totalUnits);
  return `${base} ${completed} of ${progress.totalUnits}`;
}

export function mergeGenerationProgress(
  previous: GenerationProgress | null | undefined,
  update: GenerationProgressUpdate,
  generationOperationId: string,
  sequence: number
): GenerationProgress {
  const current =
    previous && previous.generationOperationId === generationOperationId
      ? previous
      : null;
  const phase =
    current && PHASE_RANK[current.phase] > PHASE_RANK[update.phase]
      ? current.phase
      : update.phase;
  const samePhase = current !== null && current.phase === phase;
  const candidateQuestionCount = Math.max(
    current?.candidateQuestionCount ?? 0,
    update.candidateQuestionCount ?? 0
  );
  if (!samePhase) {
    const totalUnits = update.totalUnits;
    const completedUnits = Math.min(update.completedUnits, totalUnits);
    return {
      generationOperationId,
      sequence,
      candidateQuestionCount,
      phase,
      determinate: update.determinate,
      completedUnits,
      totalUnits,
    };
  }
  const determinate = current.determinate || update.determinate;
  const totalUnits = Math.max(current.totalUnits, update.totalUnits);
  const completedUnits = Math.min(
    Math.max(current.completedUnits, update.completedUnits),
    totalUnits
  );
  return {
    generationOperationId,
    sequence,
    candidateQuestionCount,
    phase,
    determinate,
    completedUnits,
    totalUnits,
  };
}
