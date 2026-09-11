import type { UiState, WorkflowSnapshot } from './State';
import { PopupStateMachine } from './State';
import type { PopupWorkflow } from './Workflow';

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

  async generate(retry = false): Promise<UiState> {
    const generating = this.stateMachine.beginGeneration();
    if (generating.name !== 'GENERATING') {
      return generating;
    }
    const token = this.stateMachine.activeOperationToken;
    try {
      const result = await this.workflow.generate(retry);
      return this.stateMachine.completeGeneration(token, result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not generate answers.';
      return this.stateMachine.failGeneration(token, message);
    }
  }

  retry(): Promise<UiState> {
    return this.generate(true);
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
