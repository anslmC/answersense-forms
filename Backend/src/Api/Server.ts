import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GenerationRequestSchema } from '../Models/Schemas';
import { createMockGenerator } from '../Ai/Service';
import type { GenerationRequest } from '../Models/Generation';

export const BACKEND_HOST = '127.0.0.1';
export const BACKEND_PORT = 3000;

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createBackendServer() {
  const generator = createMockGenerator();
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.end();
      return;
    }

    if (request.method !== 'POST' || request.url !== '/generate') {
      writeJson(response, 404, { error: 'Not found' });
      return;
    }

    try {
      const parsed = GenerationRequestSchema.safeParse(await readBody(request));
      if (!parsed.success) {
        writeJson(response, 400, { error: 'Invalid generation request' });
        return;
      }
      const generationResponse = await generator.generate(parsed.data as GenerationRequest);
      writeJson(response, 200, generationResponse);
    } catch {
      writeJson(response, 400, { error: 'Invalid generation request' });
    }
  });
}

export function startBackendServer(): ReturnType<typeof createBackendServer> {
  const server = createBackendServer();
  server.listen(BACKEND_PORT, BACKEND_HOST);
  return server;
}