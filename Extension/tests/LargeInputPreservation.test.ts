import { describe, expect, it } from 'vitest';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import type {
  GenerationRequest,
  GenerationResponse,
  SettledContextItem,
} from '../src/Generation/Contract';
import type { SettledPageState } from '../src/Generation/Context';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import {
  GEMINI_35_FLASH_LITE_MODEL,
  GeminiProvider,
} from '../src/Generation/GeminiProvider';

const QUESTION_COUNT = 800;
const CONTEXT_ITEM_COUNT = 1_000;
const LONG_QUESTION_TEXT =
  'Provide a detailed answer that accounts for every requirement in this question. '.repeat(
    16
  );
const LONG_CONTEXT_TEXT =
  'A previously settled question with substantial supporting detail. '.repeat(
    15
  );

function createLargeDocument(count = QUESTION_COUNT): Document {
  const questions = Array.from(
    { length: count },
    (_, index) => `
      <div role="listitem" data-question-type="short-text">
        <div data-params="%.@.[${1000 + index}]"></div>
        <h3 class="M7eMe" role="heading">${LONG_QUESTION_TEXT}${index + 1}</h3>
        <input type="text" value="">
      </div>`
  ).join('');

  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/large-form/viewform">
        <div role="list">${questions}</div>
      </form>
    </main>`,
    'text/html'
  );
}

function createSettledPages(): SettledPageState[] {
  const pages = 200;
  const answersPerPage = CONTEXT_ITEM_COUNT / pages;
  return Array.from({ length: pages }, (_, pageIndex) => ({
    pageId: `page-${pageIndex + 1}`,
    answers: Array.from({ length: answersPerPage }, (_, answerIndex) => {
      const questionId = `${pageIndex + 1}-${answerIndex + 1}`;
      return {
        questionText: `${LONG_CONTEXT_TEXT} ${questionId}`,
        answer: { questionId, value: `Prior answer ${questionId}` },
      };
    }),
  }));
}

function generationResponse(request: GenerationRequest): GenerationResponse {
  return {
    cycleId: request.cycleId,
    results: request.questions.map((question) => ({
      questionId: question.questionId,
      status: 'GENERATED' as const,
      answer: { questionId: question.questionId, value: 'Generated answer' },
    })),
  };
}

function expectContextPreserved(
  context: readonly SettledContextItem[],
  expected: readonly SettledContextItem[]
): void {
  expect(context).toHaveLength(expected.length);
  expect(context.map((item) => item.questionId)).toEqual(
    expected.map((item) => item.questionId)
  );
  expect(context.map((item) => item.questionText)).toEqual(
    expected.map((item) => item.questionText)
  );
}

describe('large input preservation', () => {
  it('discovers and normalizes every question in a large form without truncating text', () => {
    const discovered = discoverActiveGoogleFormsPage(createLargeDocument());
    expect(discovered).not.toBeNull();
    expect(discovered?.questions).toHaveLength(QUESTION_COUNT);
    expect(discovered?.questions[0].text).toBe(`${LONG_QUESTION_TEXT}1`);
    expect(discovered?.questions[QUESTION_COUNT - 1].text).toBe(
      `${LONG_QUESTION_TEXT}${QUESTION_COUNT}`
    );

    const page = normalizeDiscoveredActivePage(discovered!);
    expect(page.form.questions).toHaveLength(QUESTION_COUNT);
    expect(page.form.questions.every((question) => question.supported)).toBe(
      true
    );
    expect(page.form.questions[QUESTION_COUNT - 1].text).toBe(
      `${LONG_QUESTION_TEXT}${QUESTION_COUNT}`
    );
  });

  it('forwards every candidate question and all settled context to the generator', async () => {
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(createLargeDocument())!
    );
    const settledPages = createSettledPages();
    let captured: GenerationRequest | null = null;
    const coordinator = new GenerationCoordinator(() => 'cycle-large');
    const report = await coordinator.generate(page, settledPages, {
      async generate(request) {
        captured = request;
        return generationResponse(request);
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.questions).toHaveLength(QUESTION_COUNT);
    expect(captured!.questions[0].text).toBe(`${LONG_QUESTION_TEXT}1`);
    expect(captured!.questions[QUESTION_COUNT - 1].text).toBe(
      `${LONG_QUESTION_TEXT}${QUESTION_COUNT}`
    );
    expect(captured!.settledContext).toHaveLength(CONTEXT_ITEM_COUNT);
    expect(captured!.settledContext[0].questionText).toContain(
      LONG_CONTEXT_TEXT
    );
    expect(
      captured!.settledContext[CONTEXT_ITEM_COUNT - 1].questionText
    ).toContain(LONG_CONTEXT_TEXT);
    expect(report?.results).toHaveLength(QUESTION_COUNT);
    expect(
      report?.results.every((result) => result.status === 'GENERATED')
    ).toBe(true);
  });

  it('submits the complete large prompt to Gemini 3.5 Flash-Lite with LOW thinking', async () => {
    const request: GenerationRequest = {
      cycleId: 'cycle-gemini-large',
      pageId: 'page-large',
      questions: Array.from({ length: QUESTION_COUNT }, (_, index) => ({
        questionId: `large-question-${index + 1}`,
        text: `${LONG_QUESTION_TEXT}${index + 1}`,
        type: 'short-text' as const,
        required: false,
        options: [],
      })),
      settledContext: createSettledPages().flatMap((page) =>
        page.answers.flatMap((answer) =>
          answer.answer === null
            ? []
            : [
                {
                  questionId: answer.answer.questionId as string,
                  questionText: answer.questionText,
                  answer: answer.answer.value,
                },
              ]
        )
      ),
    };

    let capturedBody: Record<string, unknown> | undefined;
    const provider = new GeminiProvider(
      'test-key',
      {
        async generate({ body }) {
          capturedBody = body as Record<string, unknown>;
          return {
            status: 200,
            body: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: JSON.stringify(generationResponse(request)) },
                    ],
                  },
                },
              ],
            },
          };
        },
      },
      GEMINI_35_FLASH_LITE_MODEL
    );

    await expect(provider.generate(request)).resolves.toMatchObject({
      cycleId: request.cycleId,
    });

    const serialized = JSON.stringify(capturedBody);
    expect(serialized).not.toContain('maxInputTokens');
    expect(serialized).not.toContain('maxOutputTokens');
    const generationConfig = capturedBody?.generationConfig as Record<
      string,
      unknown
    >;
    expect(generationConfig).not.toHaveProperty('maxInputTokens');
    expect(generationConfig).not.toHaveProperty('maxOutputTokens');
    expect(generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    expect(generationConfig).toHaveProperty('responseJsonSchema');
    expect(JSON.stringify(generationConfig)).not.toMatch(/MEDIUM|HIGH/);

    const contents = capturedBody?.contents as Array<{
      parts: Array<{ text: string }>;
    }>;
    const prompt = contents[0].parts[0].text;
    expect(prompt.length).toBeGreaterThan(1_000_000);
    const submitted = JSON.parse(prompt) as {
      questions: GenerationRequest['questions'];
      settledContext: SettledContextItem[];
    };
    expect(submitted.questions).toHaveLength(QUESTION_COUNT);
    expect(submitted.settledContext).toHaveLength(CONTEXT_ITEM_COUNT);
    expect(submitted.questions[0].text).toBe(`${LONG_QUESTION_TEXT}1`);
    expect(submitted.questions[QUESTION_COUNT - 1].text).toBe(
      `${LONG_QUESTION_TEXT}${QUESTION_COUNT}`
    );
    expectContextPreserved(submitted.settledContext, request.settledContext);
  });
});
