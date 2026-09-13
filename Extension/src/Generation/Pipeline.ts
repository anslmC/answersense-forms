import type {
  NormalizedActivePage,
  Question,
  QuestionResult,
} from '../Models/Logical';
import type { GenerationInterface, GenerationRequest } from './Contract';
import { buildSettledContext, type SettledPageState } from './Context';
import { createProcessingCycle, isCurrentCycle } from './Cycle';
import {
  GENERATE_UNANSWERED,
  type GenerationIntent,
} from './Intent';
import { createGenerationReport, type GenerationReport } from './Report';
import { validateGenerationResponse } from './Validation';

function isOperableQuestion(question: Question): boolean {
  return (
    question.supported &&
    question.id !== null &&
    question.text !== null &&
    question.type !== null
  );
}

export function selectGenerationCandidates(
  page: NormalizedActivePage,
  intent: GenerationIntent = GENERATE_UNANSWERED
): Question[] {
  const selectedQuestionIds =
    intent.type === 'OVERRIDE_FILLED'
      ? new Set(intent.selectedQuestionIds)
      : null;
  return page.form.questions.filter((question) => {
    if (!isOperableQuestion(question)) return false;
    if (selectedQuestionIds === null) {
      return question.existingInput?.hasValue !== true;
    }
    const questionId = question.id;
    if (questionId === null) return false;
    return (
      selectedQuestionIds.has(questionId) &&
      question.existingInput?.hasValue === true
    );
  });
}

function createRequest(
  page: NormalizedActivePage,
  cycleId: string,
  candidates: readonly Question[],
  settledPages: readonly SettledPageState[]
): GenerationRequest {
  const questions = candidates.map((question) => ({
    questionId: question.id as string,
    text: question.text as string,
    type: question.type as NonNullable<Question['type']>,
    required: question.required,
    options: question.options.map((option) => option.label),
  }));
  return {
    cycleId,
    pageId: page.form.activePageId,
    questions,
    settledContext: buildSettledContext(settledPages),
  };
}

function createLocalGenerationResults(
  page: NormalizedActivePage
): QuestionResult[] {
  return page.form.questions.flatMap((question) =>
    question.supported
      ? []
      : [{
          questionId: question.id,
          status: 'unsupported' as const,
          answer: null,
          reason: question.unsupportedReason,
        }]
  );
}

export class GenerationCoordinator {
  private currentCycleId: string | null = null;
  private generationToken = 0;

  constructor(private readonly cycleIdFactory: () => string) {}

  get activeCycleId(): string | null {
    return this.currentCycleId;
  }

  beginCycle(): { cycleId: string } {
    const cycle = createProcessingCycle(this.cycleIdFactory);
    this.generationToken += 1;
    this.currentCycleId = cycle.cycleId;
    return cycle;
  }

  adoptCycle(cycleId: string): void {
    if (!cycleId.trim()) {
      throw new Error('A processing cycle requires a non-empty cycleId.');
    }
    this.generationToken += 1;
    this.currentCycleId = cycleId;
  }

  invalidate(): void {
    this.generationToken += 1;
    this.currentCycleId = null;
  }

  async generate(
    page: NormalizedActivePage,
    settledPages: readonly SettledPageState[],
    generator: GenerationInterface,
    preparedCycle?: { cycleId: string },
    intent: GenerationIntent = GENERATE_UNANSWERED
  ): Promise<GenerationReport | null> {
    const cycle = preparedCycle ?? this.beginCycle();
    if (this.currentCycleId !== cycle.cycleId) {
      return null;
    }
    const generationToken = this.generationToken;
    const frozenIntent: GenerationIntent =
      intent.type === 'OVERRIDE_FILLED'
        ? {
            type: 'OVERRIDE_FILLED',
            selectedQuestionIds: Object.freeze([
              ...intent.selectedQuestionIds,
            ]),
          }
        : intent;
    const candidates = selectGenerationCandidates(page, frozenIntent);
    if (candidates.length === 0) {
      return createGenerationReport(
        cycle.cycleId,
        createLocalGenerationResults(page)
      );
    }
    const response = await generator.generate(
      createRequest(page, cycle.cycleId, candidates, settledPages)
    );

    if (
      generationToken !== this.generationToken ||
      this.currentCycleId !== cycle.cycleId ||
      !isCurrentCycle(response.cycleId, cycle)
    ) {
      return null;
    }

    const results = validateGenerationResponse(
      response,
      page.form,
      cycle.cycleId,
      candidates
    );
    // The page workflow creates pending state from this report after generation; it commits only after a confirmed transition.
    return createGenerationReport(cycle.cycleId, results);
  }
}

export function createGenerationCoordinator(
  cycleIdFactory: () => string = () => crypto.randomUUID()
): GenerationCoordinator {
  return new GenerationCoordinator(cycleIdFactory);
}
