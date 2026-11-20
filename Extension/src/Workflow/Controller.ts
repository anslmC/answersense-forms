import type { UiState, WorkflowSnapshot } from './State';
import { WorkflowStateMachine } from './State';
import type { Workflow } from './Workflow';
import type { GenerationIntent } from '../Generation/Intent';
import { isProviderSafeMessageCode } from '../Generation/Contract';
import { isRecognizedProviderId } from '../Generation/ProviderIdentity';
import { readPerformanceReport } from '../Shared/Performance';

function failureMetadata(error: unknown): {
  safeMessageCode?: 'SERVER_BUSY' | 'CONTEXT_OVERFLOW';
  providerId?: 'gemini' | 'nvidia';
} {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const candidate = error as {
    safeMessageCode?: unknown;
    providerId?: unknown;
  };
  return {
    ...(isProviderSafeMessageCode(candidate.safeMessageCode)
      ? { safeMessageCode: candidate.safeMessageCode }
      : {}),
    ...(isRecognizedProviderId(candidate.providerId)
      ? { providerId: candidate.providerId }
      : {}),
  };
}

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
      const state = this.stateMachine.completeGeneration(token, result);
      const performance = readPerformanceReport(result);
      return performance && state.name === 'READY'
        ? { ...state, performance }
        : state;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not generate answers.';
      const state = this.stateMachine.failGeneration(
        token,
        message,
        failureMetadata(error)
      );
      const performance = readPerformanceReport(error);
      return performance && state.name === 'ERROR'
        ? { ...state, performance }
        : state;
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
