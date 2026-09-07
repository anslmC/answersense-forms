import { createGeminiConfig } from './Ai/Config.js';
import { createGeminiProvider } from './Ai/GeminiProvider.js';
import type { GenerationRequest } from './Models/Generation.js';

const request: GenerationRequest = {
  cycleId: `manual-smoke-${Date.now()}`,
  pageId: 'manual-smoke-page',
  questions: [
    {
      questionId: 'smoke-question',
      text: 'In one short sentence, what is a useful software testing practice?',
      type: 'short-text',
      required: true,
      options: [],
    },
  ],
  settledContext: [],
};

const response = await createGeminiProvider(createGeminiConfig()).generate(request);
console.log(JSON.stringify(response, null, 2));
