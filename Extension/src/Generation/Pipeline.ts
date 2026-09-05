import type { NormalizedActivePage } from '../Models/Logical';
import type { GenerationInterface, GenerationRequest } from './Contract';
import { buildSettledContext, type SettledPageState } from './Context';
import { createProcessingCycle, isCurrentCycle } from './Cycle';
import { createGenerationReport, type GenerationReport } from './Report';
import { validateGenerationResponse } from './Validation';

function createRequest(
  page: NormalizedActivePage,
  cycleId: string,
  settledPages: readonly SettledPageState[],
): GenerationRequest {
  const questions = page.form.questions.flatMap((question) => {
    if (!question.supported || question.id === null || question.text === null || question.type === null) {
      return [];
    }
    return [{
      questionId: question.id,
      text: question.text,
      type: question.type,
      required: question.required,
      options: question.options.map((option) => option.label),
    }];
  });
  return {
    cycleId,
    pageId: page.form.activePageId,
    questions,
    settledContext: buildSettledContext(settledPages),
  };
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
  ): Promise<GenerationReport | null> {
    const cycle = preparedCycle ?? this.beginCycle();
    if (this.currentCycleId !== cycle.cycleId) {
      return null;
    }
    const generationToken = this.generationToken;
    const response = await generator.generate(
      createRequest(page, cycle.cycleId, settledPages),
    );

    if (
      generationToken !== this.generationToken ||
      this.currentCycleId !== cycle.cycleId ||
      !isCurrentCycle(response.cycleId, cycle)
    ) {
      return null;
    }

    const results = validateGenerationResponse(response, page.form, cycle.cycleId);
    // The page workflow creates pending state from this report after generation; it commits only after a confirmed transition.
    return createGenerationReport(cycle.cycleId, results);
  }
}

export function createGenerationCoordinator(
  cycleIdFactory: () => string = () => crypto.randomUUID(),
): GenerationCoordinator {
  return new GenerationCoordinator(cycleIdFactory);
}
