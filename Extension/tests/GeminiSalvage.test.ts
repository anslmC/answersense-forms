import { describe, expect, it } from 'vitest';
import type {
  GenerationQuestion,
  GenerationRequest,
  GenerationResult,
} from '../src/Generation/Contract';
import { salvageGeminiResponse } from '../src/Generation/GeminiSalvage';

function makeQuestion(
  index: number,
  overrides: Partial<GenerationQuestion> = {}
): GenerationQuestion {
  return {
    questionId: `q-${index}`,
    text: `Question ${index}`,
    type: 'short-text',
    required: false,
    options: [],
    ...overrides,
  };
}

function makeRequest(): GenerationRequest {
  return {
    cycleId: 'cycle-salvage',
    pageId: 'page-salvage',
    questions: [
      makeQuestion(1),
      makeQuestion(2, { type: 'single-choice', options: ['A', 'B'] }),
      makeQuestion(3, { type: 'paragraph', answerParts: 2 }),
      makeQuestion(4),
    ],
    settledContext: [],
  };
}

function generatedResult(questionId: string, value: string): GenerationResult {
  return {
    questionId,
    status: 'GENERATED',
    answer: { questionId, value },
  };
}

function abstainedResult(questionId: string): GenerationResult {
  return {
    questionId,
    status: 'ABSTAINED',
    answer: null,
    reason: 'LOW_CONFIDENCE',
  };
}

describe('Gemini response salvage', () => {
  it('keeps independently valid results and reports duplicate, invalid, and unknown IDs', () => {
    const request = makeRequest();
    const salvage = salvageGeminiResponse(
      JSON.stringify({
        cycleId: request.cycleId,
        results: [
          generatedResult('q-1', 'First'),
          generatedResult('q-1', 'Duplicate'),
          generatedResult('q-2', 'Z'),
          generatedResult('q-3', 'Only one part'),
          abstainedResult('q-4'),
          generatedResult('unknown', 'Ignored'),
        ],
      }),
      request,
      'test-key'
    );

    expect(salvage.rejected).toBeNull();
    expect(salvage.hasUsableResult).toBe(true);
    expect(salvage.results).toEqual([
      generatedResult('q-1', 'First'),
      abstainedResult('q-4'),
    ]);
    expect(salvage.invalidQuestionIds).toEqual(['q-2', 'q-3']);
    expect(salvage.duplicateQuestionIds).toEqual(['q-1']);
    expect(salvage.unknownQuestionIds).toEqual(['unknown']);
    expect(salvage.missingQuestionIds).toEqual([]);
    expect(salvage.ignoredResultCount).toBe(4);
  });

  it('recovers valid result objects from truncated JSON', () => {
    const request = makeRequest();
    const text =
      `{"cycleId":"${request.cycleId}","results":[` +
      `${JSON.stringify(generatedResult('q-1', 'First'))},` +
      `${JSON.stringify(generatedResult('q-4', 'Fourth'))}`;
    const salvage = salvageGeminiResponse(text, request, 'test-key');

    expect(salvage.rejected).toBeNull();
    expect(salvage.extractionOutcome).toBe('EMBEDDED');
    expect(salvage.results).toEqual([
      generatedResult('q-1', 'First'),
      generatedResult('q-4', 'Fourth'),
    ]);
    expect(salvage.missingQuestionIds).toEqual(['q-2', 'q-3']);
    expect(salvage.hasUsableResult).toBe(true);
  });

  it('rejects the response before salvage when the cycle ID is wrong', () => {
    const request = makeRequest();
    const salvage = salvageGeminiResponse(
      JSON.stringify({
        cycleId: 'wrong-cycle',
        results: [generatedResult('q-1', 'First')],
      }),
      request,
      'test-key'
    );

    expect(salvage.rejected).toMatchObject({ code: 'WRONG_CYCLE' });
    expect(salvage.results).toEqual([]);
    expect(salvage.hasUsableResult).toBe(false);
  });

  it('rejects the response when the API key is echoed', () => {
    const request = makeRequest();
    const salvage = salvageGeminiResponse(
      JSON.stringify({
        cycleId: request.cycleId,
        results: [
          {
            questionId: 'q-1',
            status: 'GENERATION_FAILED',
            answer: null,
            failure: { code: 'ECHO', message: 'test-key' },
          },
        ],
      }),
      request,
      'test-key'
    );

    expect(salvage.rejected).toMatchObject({ code: 'API_KEY_ECHO' });
    expect(salvage.results).toEqual([]);
    expect(salvage.hasUsableResult).toBe(false);
  });
});
