import { describe, expect, it } from 'vitest';
import { MockGenerator, createMockGenerator } from '../src/Ai/Service';
import {
  GenerationRequestSchema,
  GenerationResponseSchema,
} from '../src/Models/Schemas';
import type { GenerationRequest } from '../src/Models/Generation';

const request: GenerationRequest = {
  cycleId: 'cycle-1',
  pageId: 'page-1',
  questions: [
    {
      questionId: 'name',
      text: 'What is your name?',
      type: 'short-text',
      required: true,
      options: [],
    },
    {
      questionId: 'language',
      text: 'Which language?',
      type: 'single-choice',
      required: false,
      options: ['TypeScript', 'JavaScript'],
    },
    {
      questionId: 'topics',
      text: 'Which topics?',
      type: 'multiple-choice',
      required: false,
      options: ['Testing', 'Accessibility'],
    },
    {
      questionId: 'details',
      text: 'Details',
      type: 'paragraph',
      required: true,
      options: [],
    },
  ],
  settledContext: [
    { questionId: 'previous', questionText: 'Previous question', answer: 'Settled answer' },
  ],
};

describe('Generation contract and mock generator', () => {
  it('accepts valid requests and responses', async () => {
    const generator = createMockGenerator();
    const response = await generator.generate(request);

    expect(GenerationRequestSchema.safeParse(request).success).toBe(true);
    expect(GenerationResponseSchema.safeParse(response).success).toBe(true);
    expect(response.cycleId).toBe(request.cycleId);
    expect(response.results).toHaveLength(request.questions.length);
  });

  it('rejects malformed contract data', () => {
    expect(GenerationRequestSchema.safeParse({ ...request, cycleId: '' }).success).toBe(false);
    expect(GenerationResponseSchema.safeParse({ cycleId: '', results: [] }).success).toBe(false);
    expect(GenerationResponseSchema.safeParse({
      cycleId: 'cycle-1',
      results: [{ questionId: 'name', status: 'UNKNOWN' }],
    }).success).toBe(false);
    expect(GenerationRequestSchema.safeParse({
      ...request,
      questions: [{ ...request.questions[0], type: 'dropdown' }],
    }).success).toBe(false);
    expect(GenerationResponseSchema.safeParse({
      cycleId: 'cycle-1',
      results: [
        {
          questionId: 'name',
          status: 'GENERATED',
          answer: { questionId: 'other', value: 'Mismatch' },
        },
      ],
    }).success).toBe(false);
    expect(GenerationResponseSchema.safeParse({
      cycleId: 'cycle-1',
      results: [
        {
          questionId: 'name',
          status: 'GENERATION_FAILED',
          failure: { code: 'FAILED', message: 'First' },
        },
        {
          questionId: 'name',
          status: 'GENERATION_FAILED',
          failure: { code: 'FAILED', message: 'Duplicate' },
        },
      ],
    }).success).toBe(false);
  });

  it('produces deterministic output through the generation interface', async () => {
    const first = await new MockGenerator().generate(request);
    const second = await new MockGenerator().generate(request);

    expect(first).toEqual(second);
    expect(first.results).toEqual([
      {
        questionId: 'name',
        status: 'GENERATED',
        answer: { questionId: 'name', value: 'Mock answer for name' },
      },
      {
        questionId: 'language',
        status: 'GENERATED',
        answer: { questionId: 'language', value: 'TypeScript' },
      },
      {
        questionId: 'topics',
        status: 'GENERATED',
        answer: { questionId: 'topics', value: ['Testing'] },
      },
      {
        questionId: 'details',
        status: 'GENERATED',
        answer: { questionId: 'details', value: 'Mock answer for details' },
      },
    ]);
  });

  it('returns a contract-compatible failure for choice questions without options', async () => {
    const response = await createMockGenerator().generate({
      ...request,
      questions: [{ ...request.questions[1], options: [] }],
    });

    expect(response.results[0]).toMatchObject({
      questionId: 'language',
      status: 'GENERATION_FAILED',
      failure: { code: 'NO_VALID_OPTION' },
    });
  });
});
