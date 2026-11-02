import { describe, expect, it } from 'vitest';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import {
  createQuestionTargetIndex,
  resolveCurrentQuestionTarget,
} from '../src/Fill/Resolver';
import { fillReviewedAnswers } from '../src/Fill/Filler';
import { createGenerationReport } from '../src/Generation/Report';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { PageLifecycle } from '../src/Lifecycle/PageLifecycle';
import { acceptGeneratedAnswer } from '../src/Review/Decisions';

const QUESTION_COUNT = 12;
const ITERATIONS = 100;

function createDocument(count = QUESTION_COUNT): Document {
  const questions = Array.from(
    { length: count },
    (_, index) => `
      <div role="listitem" data-question-type="short-text">
        <div data-params="%.@.[${1000 + index}]"></div>
        <h3 class="M7eMe" role="heading">Question ${index + 1}</h3>
        <input type="text" value="">
      </div>`
  ).join('');

  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/form-1/viewform">
        <div role="list">${questions}</div>
      </form>
    </main>`,
    'text/html'
  );
}

function instrument(form: HTMLFormElement) {
  let scans = 0;
  const original = form.querySelectorAll.bind(form);
  form.querySelectorAll = ((selectors: string) => {
    scans += 1;
    return original(selectors);
  }) as typeof form.querySelectorAll;
  return {
    scans: () => scans,
    reset: () => {
      scans = 0;
    },
  };
}

function measure(run: () => void, iterations = ITERATIONS): number {
  run();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    run();
  }
  return performance.now() - start;
}

describe('question target resolution cost', () => {
  it('replaces per-question container rescans with one indexed scan', () => {
    const document = createDocument();
    const form = document.querySelector('form') as HTMLFormElement;
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    const counter = instrument(form);

    const unindexedMs = measure(() => {
      for (const question of page.form.questions) {
        resolveCurrentQuestionTarget(document, question);
      }
    });
    const unindexedScans = counter.scans();

    counter.reset();
    const indexedMs = measure(() => {
      const index = createQuestionTargetIndex(document);
      for (const question of page.form.questions) {
        resolveCurrentQuestionTarget(document, question, index);
      }
    });
    const indexedScans = counter.scans();

    expect(unindexedScans).toBe(QUESTION_COUNT * (ITERATIONS + 1));
    expect(indexedScans).toBe(ITERATIONS + 1);
    expect(indexedScans).toBeLessThan(unindexedScans);
    expect(indexedMs).toBeLessThan(unindexedMs);

    console.log(
      `target resolution (${QUESTION_COUNT} questions x 100 runs): indexed ${indexedMs.toFixed(1)}ms / ${indexedScans} scans, per-question ${unindexedMs.toFixed(1)}ms / ${unindexedScans} scans`
    );
  });

  it('resolves a whole page capture with a single container scan', () => {
    const document = createDocument();
    const form = document.querySelector('form') as HTMLFormElement;
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    const lifecycle = new PageLifecycle(
      page,
      new GenerationCoordinator(() => 'cycle-capture')
    );
    const counter = instrument(form);

    lifecycle.captureCurrentAnswers(document);

    expect(counter.scans()).toBe(1);
  });

  it('fills every question with a single container scan', async () => {
    const document = createDocument();
    const form = document.querySelector('form') as HTMLFormElement;
    const page = normalizeDiscoveredActivePage(
      discoverActiveGoogleFormsPage(document)!
    );
    const report = createGenerationReport(
      'cycle-fill',
      page.form.questions.map((question) => ({
        questionId: question.id as string,
        status: 'GENERATED' as const,
        answer: {
          questionId: question.id as string,
          value: `Answer ${question.id}`,
        },
        reason: null,
      }))
    );
    const counter = instrument(form);

    const fillReport = await fillReviewedAnswers(
      document,
      page.form,
      report,
      report.results.map((result) =>
        acceptGeneratedAnswer(result.questionId as string, result.answer!)
      )
    );

    expect(counter.scans()).toBe(1);
    expect(fillReport.outcomes.map((outcome) => outcome.status)).toEqual(
      Array.from({ length: QUESTION_COUNT }, () => 'FILLED')
    );
    expect(
      Array.from(document.querySelectorAll('input')).map((input) => input.value)
    ).toEqual(page.form.questions.map((question) => `Answer ${question.id}`));
  });
});
