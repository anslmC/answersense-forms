import { GenerationRequestSchema } from '../Models/Schemas';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../Models/Generation';

export class MockGenerator implements GenerationInterface {
  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const validRequest = GenerationRequestSchema.parse(request);
    return {
      cycleId: validRequest.cycleId,
      results: validRequest.questions.map((question) => {
        if (
          (question.type === 'single-choice' ||
            question.type === 'multiple-choice' ||
            question.type === 'dropdown') &&
          question.options.length === 0
        ) {
          return {
            questionId: question.questionId,
            status: 'GENERATION_FAILED' as const,
            failure: {
              code: 'NO_VALID_OPTION',
              message: 'No valid option is available for this question.',
            },
          };
        }

        const value =
          question.type === 'multiple-choice'
            ? [question.options[0]]
            : question.type === 'single-choice' || question.type === 'dropdown'
              ? question.options[0]
              : `Mock answer for ${question.questionId}`;
        return {
          questionId: question.questionId,
          status: 'GENERATED' as const,
          answer: { questionId: question.questionId, value },
        };
      }),
    };
  }
}

export function createMockGenerator(): GenerationInterface {
  return new MockGenerator();
}
