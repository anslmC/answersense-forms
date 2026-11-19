import { describe, expect, it } from 'vitest';
import type {
  DiscoveredPage,
  DiscoveredQuestion,
} from '../src/Forms/Discovery';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import {
  computePageFingerprint,
  normalizeDiscoveredActivePage,
} from '../src/Forms/Normalization';
import type {
  Form,
  NormalizedActivePage,
  Question,
} from '../src/Models/Logical';
import type {
  GenerationInterface,
  GenerationRequest,
  GenerationResponse,
} from '../src/Generation/Contract';
import { GenerationCoordinator } from '../src/Generation/Pipeline';
import { validateGenerationResponse } from '../src/Generation/Validation';
import { createGenerationReport } from '../src/Generation/Report';
import { createAcceptedReviewDecisions } from '../src/Review/Decisions';
import { createSkipDiagnostics, fillReviewedAnswers } from '../src/Fill/Filler';

function createPageDocument(markup: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <section data-page-id="page-visual" data-answersense-active-page="true">
        ${markup}
      </section>
    </main>`,
    'text/html'
  );
}

function discoverPage(markup: string): DiscoveredPage {
  const page = discoverActiveGoogleFormsPage(createPageDocument(markup));
  if (!page) {
    throw new Error('Expected a discovered active page.');
  }
  return page;
}

function discoverSingleQuestion(markup: string): DiscoveredQuestion {
  const question = discoverPage(markup).questions[0];
  if (!question || question.kind !== 'supported') {
    throw new Error('Expected a supported discovered question.');
  }
  return question;
}

function normalizedPage(
  markup: string,
  cycleId = 'cycle-visual'
): NormalizedActivePage {
  return normalizeDiscoveredActivePage(discoverPage(markup), cycleId);
}

function createQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'visual',
    text: 'Question visual',
    type: 'short-text',
    required: false,
    options: [],
    existingInput: { value: null, hasValue: false },
    supported: true,
    unsupportedReason: null,
    ...overrides,
  };
}

function formWith(question: Question): Form {
  return {
    formId: 'form-visual',
    activePageId: 'page-visual',
    questions: [question],
  };
}

function generatedResponse(
  cycleId: string,
  questionId: string,
  value = 'Generated answer'
): GenerationResponse {
  return {
    cycleId,
    results: [
      {
        questionId,
        status: 'GENERATED',
        answer: { questionId, value },
      },
    ],
  };
}

function abstainedResponse(
  cycleId: string,
  questionId: string,
  reason: 'LOW_CONFIDENCE' | 'UNABLE_TO_DETERMINE' | 'NOT_APPLICABLE'
): GenerationResponse {
  return {
    cycleId,
    results: [{ questionId, status: 'ABSTAINED', answer: null, reason }],
  };
}

const truthTableMarkup = `
  <div role="listitem" data-question-id="truth-table"
    data-question-text="Using the truth table shown, which Boolean expression is equivalent?">
    <img src="https://example.com/truth-table.png" alt="Truth table">
    <input type="text" value="">
  </div>`;

describe('visual material extraction', () => {
  it('uses safe defaults for a question without visual material', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="plain" data-question-text="What is the capital of France?">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: false,
      requiresUnavailableVisual: false,
    });
  });

  it('detects visual material inside the current question container', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="illustrated" data-question-text="What is the capital of France?">
        <img src="https://example.com/illustration.png" alt="Illustration">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: false,
    });
  });

  it('does not let visual material in another question affect the current question', () => {
    const page = discoverPage(`
      <div role="listitem" data-question-id="with-image" data-question-text="What is the capital of France?">
        <img src="https://example.com/illustration.png" alt="Illustration">
        <input type="text" value="">
      </div>
      <div role="listitem" data-question-id="without-image" data-question-text="What is the capital of Italy?">
        <input type="text" value="">
      </div>
    `);

    expect(page.questions[0]).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: false,
    });
    expect(page.questions[1]).toMatchObject({
      hasVisualMaterial: false,
      requiresUnavailableVisual: false,
    });
  });

  it('ignores hidden, off-screen, and decorative visual material', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="decorated"
        data-question-text="Based on the diagram below, what is the answer?">
        <div hidden><img src="https://example.com/hidden.png" alt="Hidden"></div>
        <img src="https://example.com/transparent.png" alt="Spacer" width="1" height="1">
        <img src="https://example.com/decorative.png" alt="" style="display: none">
        <svg aria-hidden="true" width="24" height="24"><circle r="10"></circle></svg>
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: false,
      requiresUnavailableVisual: false,
    });
  });

  it('keeps a question with an image and complete independent text answerable', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="independent"
        data-question-text="What is the capital of France?">
        <img src="https://example.com/decorative.png" alt="Decorative illustration">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: false,
    });
  });
});

describe('visual dependency detection', () => {
  it('identifies a truth-table question that references an embedded image', () => {
    const question = discoverSingleQuestion(truthTableMarkup);

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
  });

  it('identifies a diagram-dependent question with unavailable visual content', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="diagram"
        data-question-text="Based on the diagram below, what is the value of x?">
        <img src="https://example.com/diagram.png" alt="Diagram">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
  });

  it('does not mark a question dependent merely because it contains a decorative image', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="decorative"
        data-question-text="What is 2 + 2?">
        <img src="https://example.com/decoration.png" alt="Decoration">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: false,
    });
  });

  it('does not skip ordinary questions because of unrelated visual words', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="words"
        data-question-text="Which table should be used for this report?">
        <input type="text" value="">
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: false,
      requiresUnavailableVisual: false,
    });
  });

  it('identifies image-based answer options as unavailable visual material', () => {
    const question = discoverSingleQuestion(
      `<div role="listitem" data-question-id="image-options"
        data-question-text="Which shape is a circle?">
        <div role="radio" aria-label="Circle">
          <img src="https://example.com/circle.png" alt="Circle">
        </div>
        <div role="radio" aria-label="Square">
          <img src="https://example.com/square.png" alt="Square">
        </div>
      </div>`
    );

    expect(question).toMatchObject({
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
  });
});

describe('visual metadata normalization and fingerprinting', () => {
  it('preserves visual metadata through normalization', () => {
    const page = normalizedPage(truthTableMarkup, 'cycle-normalize');

    expect(page.form.questions[0]).toMatchObject({
      id: 'truth-table',
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
  });

  it('changes the page fingerprint when visual metadata meaningfully changes', () => {
    const fingerprint = (
      hasVisualMaterial: boolean,
      requiresUnavailableVisual: boolean
    ): string => {
      const page = normalizeDiscoveredActivePage({
        pageId: 'page-visual',
        questions: [
          {
            kind: 'supported',
            id: 'visual',
            text: 'Question visual',
            type: 'short-text',
            required: false,
            options: [],
            existingValue: null,
            hasVisualMaterial,
            requiresUnavailableVisual,
          },
        ],
      });
      return page.form.pageFingerprint as string;
    };

    const plain = fingerprint(false, false);
    const illustrated = fingerprint(true, false);
    const dependent = fingerprint(true, true);

    expect(new Set([plain, illustrated, dependent]).size).toBe(3);
  });

  it('stays compatible with existing fixtures that omit visual metadata', () => {
    const page = normalizeDiscoveredActivePage({
      pageId: 'page-visual',
      questions: [
        {
          kind: 'supported',
          id: 'legacy',
          text: 'Legacy question',
          type: 'short-text',
          required: false,
          options: [],
          existingValue: null,
        },
      ],
    });

    expect(page.form.questions[0]).toMatchObject({
      hasVisualMaterial: false,
      requiresUnavailableVisual: false,
    });
    expect(computePageFingerprint(page.form)).toBe(page.form.pageFingerprint);
  });
});

describe('deterministic visual abstention', () => {
  it('converts a generated answer for a visually dependent question to ABSTAINED', () => {
    const question = createQuestion({
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
    const form = formWith(question);

    const results = validateGenerationResponse(
      generatedResponse('cycle-visual', 'visual'),
      form,
      'cycle-visual'
    );

    expect(results).toEqual([
      {
        questionId: 'visual',
        status: 'ABSTAINED',
        answer: null,
        reason: 'UNABLE_TO_DETERMINE',
      },
    ]);
  });

  it('overrides LOW_CONFIDENCE with UNABLE_TO_DETERMINE for a visually dependent question', () => {
    const question = createQuestion({
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
    const form = formWith(question);

    const results = validateGenerationResponse(
      abstainedResponse('cycle-visual', 'visual', 'LOW_CONFIDENCE'),
      form,
      'cycle-visual'
    );

    expect(results[0]).toMatchObject({
      status: 'ABSTAINED',
      answer: null,
      reason: 'UNABLE_TO_DETERMINE',
    });
  });

  it('applies identical enforcement to generated and low-confidence provider results', () => {
    const form = formWith(
      createQuestion({
        hasVisualMaterial: true,
        requiresUnavailableVisual: true,
      })
    );
    const responses = [
      generatedResponse('cycle-gemini-shaped', 'visual'),
      abstainedResponse('cycle-nvidia-shaped', 'visual', 'LOW_CONFIDENCE'),
    ];

    for (const response of responses) {
      expect(
        validateGenerationResponse(response, form, response.cycleId)[0]
      ).toMatchObject({
        status: 'ABSTAINED',
        answer: null,
        reason: 'UNABLE_TO_DETERMINE',
      });
    }
  });

  it('continues accepting normal text-only generated results', () => {
    const form = formWith(createQuestion());

    const results = validateGenerationResponse(
      generatedResponse('cycle-text', 'visual', 'Paris'),
      form,
      'cycle-text'
    );

    expect(results[0]).toMatchObject({
      status: 'GENERATED',
      answer: { questionId: 'visual', value: 'Paris' },
    });
  });

  it('continues accepting an image-containing but independently answerable question', () => {
    const form = formWith(
      createQuestion({
        hasVisualMaterial: true,
        requiresUnavailableVisual: false,
      })
    );

    const results = validateGenerationResponse(
      generatedResponse('cycle-independent', 'visual', 'Paris'),
      form,
      'cycle-independent'
    );

    expect(results[0]).toMatchObject({
      status: 'GENERATED',
      answer: { questionId: 'visual', value: 'Paris' },
    });
  });

  it('preserves existing personal-information abstention behavior', () => {
    const form = formWith(
      createQuestion({
        id: 'email',
        text: 'What is your email address?',
      })
    );

    const results = validateGenerationResponse(
      abstainedResponse('cycle-personal', 'email', 'UNABLE_TO_DETERMINE'),
      form,
      'cycle-personal'
    );

    expect(results[0]).toMatchObject({
      questionId: 'email',
      status: 'ABSTAINED',
      answer: null,
      reason: 'UNABLE_TO_DETERMINE',
    });
  });

  it('passes visual metadata through the shared generation request and rejects provider output', async () => {
    const page = normalizedPage(truthTableMarkup, 'cycle-request');
    let capturedRequest: GenerationRequest | undefined;
    const generator: GenerationInterface = {
      generate: async (request) => {
        capturedRequest = request;
        return generatedResponse(request.cycleId, 'truth-table', 'A and B');
      },
    };

    const report = await new GenerationCoordinator(
      () => 'cycle-request'
    ).generate(page, [], generator);

    expect(capturedRequest?.questions[0]).toMatchObject({
      questionId: 'truth-table',
      hasVisualMaterial: true,
      requiresUnavailableVisual: true,
    });
    expect(report?.results[0]).toMatchObject({
      questionId: 'truth-table',
      status: 'ABSTAINED',
      answer: null,
      reason: 'UNABLE_TO_DETERMINE',
    });
  });
});

describe('visual abstention filling compatibility', () => {
  it('reports the abstained question as skipped and retains its reason in diagnostics', async () => {
    const page = normalizedPage(truthTableMarkup, 'cycle-fill');
    const form = page.form;
    const results = validateGenerationResponse(
      generatedResponse('cycle-fill', 'truth-table', 'A and B'),
      form,
      'cycle-fill'
    );
    const report = createGenerationReport('cycle-fill', results);
    const decisions = createAcceptedReviewDecisions(report);

    expect(decisions).toEqual([
      { questionId: 'truth-table', decision: 'skip', answer: null },
    ]);

    const fillReport = await fillReviewedAnswers(
      createPageDocument(truthTableMarkup),
      form,
      report,
      decisions
    );

    expect(fillReport.outcomes).toMatchObject([
      { questionId: 'truth-table', status: 'SKIPPED', answer: null },
    ]);
    expect(createSkipDiagnostics(report, fillReport)).toMatchObject([
      {
        questionId: 'truth-table',
        generationStatus: 'ABSTAINED',
        generationReason: 'UNABLE_TO_DETERMINE',
        fillStatus: 'SKIPPED',
      },
    ]);
  });
});
