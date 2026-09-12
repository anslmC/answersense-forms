import { describe, expect, it } from 'vitest';
import type {
  GenerationInterface,
  GenerationResponse,
} from '../src/Generation/Contract';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { fillReviewedAnswers } from '../src/Fill/Filler';
import { createAcceptedReviewDecisions } from '../src/Review/Decisions';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import type { SupportedQuestionType } from '../src/Models/Logical';

interface IntegrationCase {
  type: SupportedQuestionType;
  questionId: string;
  answer: string | string[];
  expectedValue: string | string[];
}

function createDocument(testCase: IntegrationCase): Document {
  const control =
    testCase.type === 'short-text'
      ? '<input type="text" value="">'
      : testCase.type === 'paragraph'
        ? '<textarea></textarea>'
        : testCase.type === 'single-choice'
          ? '<div role="radio" aria-label="Alpha" aria-checked="false"></div><div role="radio" aria-label="Beta" aria-checked="false"></div>'
          : '<div role="checkbox" aria-label="Existing" aria-checked="false"></div><div role="checkbox" aria-label="Added" aria-checked="false"></div>';
  const document = new DOMParser().parseFromString(
    `<!doctype html><main>
    <section data-page-id="page-${testCase.type}" data-answersense-active-page="true">
      <div role="listitem" data-question-id="${testCase.questionId}" data-question-text="${testCase.type} question" data-question-type="${testCase.type}">
        ${control}
      </div>
    </section>
  </main>`,
    'text/html'
  );

  document.querySelectorAll<HTMLElement>('[role="radio"]').forEach((option) => {
    option.addEventListener('click', () => {
      option
        .closest('[role="listitem"]')
        ?.querySelectorAll<HTMLElement>('[role="radio"]')
        .forEach((candidate) => {
          candidate.setAttribute(
            'aria-checked',
            candidate === option ? 'true' : 'false'
          );
        });
    });
  });
  document
    .querySelectorAll<HTMLElement>('[role="checkbox"]')
    .forEach((option) => {
      option.addEventListener('click', () => {
        option.setAttribute(
          'aria-checked',
          option.getAttribute('aria-checked') === 'true' ? 'false' : 'true'
        );
      });
    });

  return document;
}

async function runIntegrationCase(testCase: IntegrationCase) {
  const document = createDocument(testCase);
  const discovered = discoverActiveGoogleFormsPage(document);
  expect(discovered?.questions).toHaveLength(1);
  expect(discovered?.questions[0]).toMatchObject({
    kind: 'supported',
    id: testCase.questionId,
    type: testCase.type,
  });

  const normalized = normalizeDiscoveredActivePage(
    discovered!,
    `discovery-${testCase.type}`
  );
  expect(normalized.form.questions[0]).toMatchObject({
    id: testCase.questionId,
    type: testCase.type,
    supported: true,
  });

  let receivedRequest:
    Parameters<GenerationInterface['generate']>[0] | undefined;
  const generator: GenerationInterface = {
    generate: async (request): Promise<GenerationResponse> => {
      receivedRequest = request;
      return {
        cycleId: request.cycleId,
        results: [
          {
            questionId: request.questions[0].questionId,
            status: 'GENERATED',
            answer: {
              questionId: request.questions[0].questionId,
              value: testCase.answer,
            },
          },
        ],
      };
    },
  };

  const report = await new GenerationCoordinator(
    () => `cycle-${testCase.type}`
  ).generate(normalized, [], generator);
  expect(report).not.toBeNull();
  expect(receivedRequest).toMatchObject({
    cycleId: 'cycle-' + testCase.type,
    pageId: 'page-' + testCase.type,
    questions: [{ questionId: testCase.questionId, type: testCase.type }],
  });
  expect(report?.results).toEqual([
    {
      questionId: testCase.questionId,
      status: 'GENERATED',
      answer: { questionId: testCase.questionId, value: testCase.answer },
      reason: null,
    },
  ]);

  const fillReport = await fillReviewedAnswers(
    document,
    normalized.form,
    report!,
    createAcceptedReviewDecisions(report!)
  );
  expect(fillReport.outcomes).toEqual([
    {
      questionId: testCase.questionId,
      status: 'FILLED',
      answer: {
        questionId: testCase.questionId,
        value: testCase.expectedValue,
      },
      reason: null,
      code: null,
    },
  ]);

  if (testCase.type === 'short-text') {
    expect((document.querySelector('input') as HTMLInputElement).value).toBe(
      testCase.expectedValue
    );
  } else if (testCase.type === 'paragraph') {
    expect(
      (document.querySelector('textarea') as HTMLTextAreaElement).value
    ).toBe(testCase.expectedValue);
  } else if (testCase.type === 'single-choice') {
    expect(
      document
        .querySelector('[aria-label="Beta"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
  } else {
    expect(
      document
        .querySelector('[aria-label="Existing"]')
        ?.getAttribute('aria-checked')
    ).toBe('false');
    expect(
      document
        .querySelector('[aria-label="Added"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
  }
}

describe('P10 supported control runtime paths', () => {
  it('runs short-text through discovery to verified result', async () => {
    await runIntegrationCase({
      type: 'short-text',
      questionId: 'short-question',
      answer: 'Generated short answer',
      expectedValue: 'Generated short answer',
    });
  });

  it('runs paragraph through discovery to verified result', async () => {
    await runIntegrationCase({
      type: 'paragraph',
      questionId: 'paragraph-question',
      answer: 'Generated paragraph answer',
      expectedValue: 'Generated paragraph answer',
    });
  });

  it('runs single-choice through discovery to verified result', async () => {
    await runIntegrationCase({
      type: 'single-choice',
      questionId: 'single-choice-question',
      answer: 'Beta',
      expectedValue: 'Beta',
    });
  });

  it('runs multiple-choice through discovery to verified result', async () => {
    await runIntegrationCase({
      type: 'multiple-choice',
      questionId: 'multiple-choice-question',
      answer: ['Added'],
      expectedValue: ['Added'],
    });
  });
});
