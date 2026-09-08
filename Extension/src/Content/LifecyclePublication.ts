export interface LifecyclePublicationMessage {
  type: 'lifecycle-snapshot' | 'lifecycle-transition-confirmed';
  reset?: boolean;
  [key: string]: unknown;
}

export interface LifecyclePublicationOptions {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
}

type SendPublication = (
  message: LifecyclePublicationMessage
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectedStatus(type: LifecyclePublicationMessage['type']): string {
  return type === 'lifecycle-snapshot'
    ? 'snapshot-stored'
    : 'transition-stored';
}

function assertAcknowledged(
  message: LifecyclePublicationMessage,
  response: unknown
): void {
  if (
    !isRecord(response) ||
    response.status !== expectedStatus(message.type)
  ) {
    const error = isRecord(response) && typeof response.error === 'string'
      ? response.error
      : 'Lifecycle publication was not acknowledged after persistence.';
    throw new Error(error);
  }
}

export class LifecyclePublicationQueue {
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private tail = Promise.resolve();

  constructor(
    private readonly send: SendPublication,
    options: LifecyclePublicationOptions = {}
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelaysMs = options.retryDelaysMs ?? [50, 250];
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  publish(message: LifecyclePublicationMessage): Promise<void> {
    const publication = this.tail.then(() => this.deliver(message));
    this.tail = publication.then(
      () => undefined,
      () => undefined
    );
    return publication;
  }

  private async deliver(message: LifecyclePublicationMessage): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(
          this.retryDelaysMs[attempt - 1] ??
            this.retryDelaysMs[this.retryDelaysMs.length - 1] ??
            0
        );
      }
      try {
        assertAcknowledged(message, await this.send(message));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Lifecycle publication failed after bounded retries.');
  }
}