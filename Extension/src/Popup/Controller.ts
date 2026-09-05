import type { UiState } from './State';
import { PopupStateMachine } from './State';
import type { PopupWorkflow } from './Workflow';

export class PopupController {
  readonly stateMachine = new PopupStateMachine();

  constructor(private readonly workflow: PopupWorkflow) {}

  get state(): UiState {
    return this.stateMachine.state;
  }

  async discover(): Promise<UiState> {
    const page = await this.workflow.discover();
    return this.stateMachine.setPage(page);
  }

  async generate(): Promise<UiState> {
    const generating = this.stateMachine.beginGeneration();
    if (generating.name !== 'GENERATING') {
      return generating;
    }
    const token = this.stateMachine.activeOperationToken;
    try {
      const result = await this.workflow.generate();
      return this.stateMachine.completeGeneration(token, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not generate answers.';
      return this.stateMachine.failGeneration(token, message);
    }
  }

  finishReview(): UiState {
    return this.stateMachine.finishReview();
  }

  retry(): Promise<UiState> {
    return this.generate();
  }
}
