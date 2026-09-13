import type { UiState, WorkflowSnapshot } from './State';
import { WorkflowStateMachine } from './State';
import type { Workflow } from './Workflow';
import type { GenerationIntent } from '../Generation/Intent';

export class WorkflowController {
  readonly stateMachine = new WorkflowStateMachine();

  constructor(private readonly workflow: Workflow) {}

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
