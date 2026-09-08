import { describe, expect, it } from 'vitest';
import { createBackendServer } from '../src/Api/Server';
import { createMockGenerator } from '../src/Ai/Service';

function requestBody(
  port: number,
  body: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    void request
      .then(async (response) =>
        resolve({ status: response.status, body: await response.json() })
      )
      .catch(reject);
  });
}

const validRequest = {
  cycleId: 'extension-cycle',
  pageId: 'page-1',
  questions: [
    {
      questionId: 'name',
      text: 'Name',
      type: 'short-text',
      required: true,
      options: [],
    },
  ],
  settledContext: [],
};

describe('Backend HTTP generation boundary', () => {
  it('rejects invalid requests and echoes the Extension cycleId', async () => {
    const server = createBackendServer(createMockGenerator()).listen(
      0,
      '127.0.0.1'
    );
    await new Promise<void>((resolve) =>
      server.once('listening', () => resolve())
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const invalid = await requestBody(port, { cycleId: '' });
    const valid = await requestBody(port, validRequest);
    server.close();

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(valid.body.cycleId).toBe('extension-cycle');
  });

  it('does not return malformed provider output as a successful response', async () => {
    const server = createBackendServer({
      generate: async () =>
        ({
          cycleId: 'extension-cycle',
          results: [{ questionId: 'unknown', status: 'UNKNOWN' }],
        }) as never,
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) =>
      server.once('listening', () => resolve())
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await requestBody(port, validRequest);
    server.close();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Generation failed.' });
  });
});
