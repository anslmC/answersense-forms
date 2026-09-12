import type { UiState, WorkflowSnapshot } from './State';
import { PopupStateMachine } from './State';
import type { PopupWorkflow } from './Workflow';
import type { GenerationIntent } from '../Generation/Intent';

export class PopupController {
  readonly stateMachine = new PopupStateMachine();

  constructor(private readonly workflow: PopupWorkflow) {}

  get state(): UiState {
    return this.stateMachine.state;
  }

  restore(snapshot: WorkflowSnapshot): UiState {
    return this.stateMachine.restore(snapshot);
  }

  async discover(): Promise<UiState> {
    const page = await this.workflow.discover();
    if (page && 'uiState' in page) {
      return this.stateMachine.restore(page as WorkflowSnapshot);
    }
    return this.stateMachine.setPage(page);
  }

  async generate(
    onGenerating?: (state: UiState) => void,
    intent?: GenerationIntent
  ): Promise<UiState> {
    const generating = this.stateMachine.beginGeneration(intent);
    if (generating.name !== 'GENERATING') {
      return generating;
    }
    onGenerating?.(generating);
    const token = this.stateMachine.activeOperationToken;
    try {
      const result = await this.workflow.generate(intent);
      return this.stateMachine.completeGeneration(token, result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not generate answers.';
      return this.stateMachine.failGeneration(token, message);
    }
  }

  async forceClear(): Promise<UiState> {
    try {
      return this.stateMachine.restore(await this.workflow.forceClear());
    } catch (error) {
      return this.stateMachine.failGeneration(
        this.stateMachine.activeOperationToken,
        error instanceof Error ? error.message : 'Force Clear failed.'
      );
    }
  }
}
