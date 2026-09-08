import { describe, expect, it, vi } from 'vitest';
import { LifecyclePublicationQueue } from '../src/Content/LifecyclePublication';

const snapshotMessage = (pageId: string) => ({
  type: 'lifecycle-snapshot' as const,
  snapshot: { pageId },
});

describe('Lifecycle publication delivery', () => {
  it('resolves only after the worker acknowledges persistence', async () => {
    const send = vi.fn(async () => ({ status: 'snapshot-stored' }));
    const queue = new LifecyclePublicationQueue(send, { sleep: vi.fn() });

    await expect(queue.publish(snapshotMessage('page-1'))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a rejected send with bounded backoff', async () => {
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce({ status: 'snapshot-stored' });
    const sleep = vi.fn(async () => undefined);
    const queue = new LifecyclePublicationQueue(send, {
      maxAttempts: 2,
      retryDelaysMs: [10],
      sleep,
    });

    await expect(queue.publish(snapshotMessage('page-1'))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('rejects after the configured retry limit without looping forever', async () => {
    const send = vi.fn(async () => {
      throw new Error('worker unavailable');
    });
    const queue = new LifecyclePublicationQueue(send, {
      maxAttempts: 3,
      retryDelaysMs: [0],
      sleep: vi.fn(async () => undefined),
    });

    await expect(queue.publish(snapshotMessage('page-1'))).rejects.toThrow(
      'worker unavailable'
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('treats a persistence error response as a failed publication', async () => {
    const send = vi.fn(async () => ({ error: 'session storage failed' }));
    const queue = new LifecyclePublicationQueue(send, {
      maxAttempts: 1,
      sleep: vi.fn(),
    });

    await expect(queue.publish(snapshotMessage('page-1'))).rejects.toThrow(
      'session storage failed'
    );
  });

  it('preserves publication ordering across rapid transitions', async () => {
    const published: string[] = [];
    const send = vi.fn(async (message: { snapshot: { pageId: string } }) => {
      published.push(message.snapshot.pageId);
      return { status: 'snapshot-stored' };
    });
    const queue = new LifecyclePublicationQueue(send, { sleep: vi.fn() });

    await Promise.all([
      queue.publish(snapshotMessage('page-a')),
      queue.publish(snapshotMessage('page-b')),
      queue.publish(snapshotMessage('page-c')),
    ]);

    expect(published).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('continues with newer state after an older publication exhausts retries', async () => {
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce({ status: 'snapshot-stored' });
    const queue = new LifecyclePublicationQueue(send, {
      maxAttempts: 1,
      sleep: vi.fn(),
    });

    const failed = queue.publish(snapshotMessage('page-a'));
    const recovered = queue.publish(snapshotMessage('page-b'));

    await expect(failed).rejects.toThrow('worker unavailable');
    await expect(recovered).resolves.toBeUndefined();
    expect(send).toHaveBeenLastCalledWith(snapshotMessage('page-b'));
  });
});