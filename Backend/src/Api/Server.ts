import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { GenerationRequestSchema } from '../Models/Schemas.js';
import { createGeminiConfig } from '../Ai/Config.js';
import {
  createGeminiProvider,
  validateProviderResponse,
} from '../Ai/GeminiProvider.js';
import type {
  GenerationInterface,
  GenerationRequest,
} from '../Models/Generation.js';

export const BACKEND_HOST = '127.0.0.1';
export const BACKEND_PORT = 3000;

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
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

export function createBackendServer(
  generator: GenerationInterface = createGeminiProvider(createGeminiConfig())
) {
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
      const generationResponse = await generator.generate(
        parsed.data as GenerationRequest
      );
      const validatedResponse = validateProviderResponse(
        parsed.data,
        generationResponse
      );
      writeJson(response, 200, validatedResponse);
    } catch (error) {
      if (error instanceof SyntaxError) {
        writeJson(response, 400, { error: 'Invalid generation request' });
        return;
      }
      writeJson(response, 500, { error: 'Generation failed.' });
    }
  });
}

export function startBackendServer(): ReturnType<typeof createBackendServer> {
  const server = createBackendServer();
  server.listen(BACKEND_PORT, BACKEND_HOST);
  return server;
}
