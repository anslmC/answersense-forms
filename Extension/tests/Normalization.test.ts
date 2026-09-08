import { describe, expect, it } from 'vitest';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';

function createDocument(): Document {
  const parser = new DOMParser();
  return parser.parseFromString(
    `<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-id="name" data-question-text="What is your name?" aria-required="true">
          <input type="text" value="Ada Lovelace">
        </div>
        <div role="listitem" data-question-id="language" data-question-text="Which language?">
          <div role="radio" aria-label="TypeScript" aria-checked="true"></div>
          <div role="radio" aria-label="JavaScript" aria-checked="false"></div>
        </div>
        <div role="listitem" data-question-id="unknown" data-question-text="Unsupported prompt">
          <div role="slider"></div>
        </div>
      </section>
    </main>`,
    'text/html'
  );
}

describe('Active page normalization', () => {
  it('normalizes supported discovery data into logical data', () => {
    const discovered = discoverActiveGoogleFormsPage(createDocument());
    expect(discovered).not.toBeNull();

    const normalized = normalizeDiscoveredActivePage(discovered!, 'cycle-7');
    expect(normalized.form).toEqual({
      formId: null,
      activePageId: 'page-1',
      pageFingerprint: expect.any(String),
      questions: [
        {
          id: 'name',
          text: 'What is your name?',
          type: 'short-text',
          required: true,
          options: [],
          existingInput: { value: 'Ada Lovelace', hasValue: true },
          supported: true,
          unsupportedReason: null,
        },
        {
          id: 'language',
          text: 'Which language?',
          type: 'single-choice',
          required: false,
          options: [
            { label: 'TypeScript', selected: true },
            { label: 'JavaScript', selected: false },
          ],
          existingInput: { value: 'TypeScript', hasValue: true },
          supported: true,
          unsupportedReason: null,
        },
        {
          id: 'unknown',
          text: 'Unsupported prompt',
          type: null,
          required: false,
          options: [],
          existingInput: null,
          supported: false,
          unsupportedReason: 'Question type is unsupported.',
        },
      ],
    });
    expect(normalized.processingCycle).toEqual({ cycleId: 'cycle-7' });
    expect(normalized.questionResults.map((result) => result.status)).toEqual([
      'ready',
      'ready',
      'unsupported',
    ]);
  });

  it('normalizes an empty active page deterministically', () => {
    const normalized = normalizeDiscoveredActivePage({
      pageId: 'empty',
      questions: [],
    });
    expect(normalized.form.questions).toEqual([]);
    expect(normalized.questionResults).toEqual([]);
    expect(normalized.processingCycle).toEqual({ cycleId: 'discovery' });
  });

  it('does not retain DOM references', () => {
    const discovered = discoverActiveGoogleFormsPage(createDocument());
    const normalized = normalizeDiscoveredActivePage(discovered!);

    expect(JSON.stringify(normalized)).not.toContain('HTMLElement');
    expect(
      Object.values(normalized).some((value) => value instanceof Node)
    ).toBe(false);
  });

  it('normalizes all four MVP types and preserves paragraph input state', () => {
    const normalized = normalizeDiscoveredActivePage({
      pageId: 'page-1',
      questions: [
        {
          kind: 'supported',
          id: 'short',
          text: 'Short',
          type: 'short-text',
          required: true,
          options: [],
          existingValue: '',
        },
        {
          kind: 'supported',
          id: 'paragraph',
          text: 'Paragraph',
          type: 'paragraph',
          required: true,
          options: [],
          existingValue: 'Details',
        },
        {
          kind: 'supported',
          id: 'choice',
          text: 'Choice',
          type: 'single-choice',
          required: true,
          options: [{ label: 'A', selected: false }],
          existingValue: null,
        },
        {
          kind: 'supported',
          id: 'checks',
          text: 'Checks',
          type: 'multiple-choice',
          required: true,
          options: [{ label: 'A', selected: true }],
          existingValue: ['A'],
        },
      ],
    });

    expect(normalized.form.questions.map((question) => question.type)).toEqual([
      'short-text',
      'paragraph',
      'single-choice',
      'multiple-choice',
    ]);
    expect(
      normalized.form.questions.map((question) => question.required)
    ).toEqual([true, true, true, true]);
    expect(normalized.form.questions[1].existingInput).toEqual({
      value: 'Details',
      hasValue: true,
    });
  });
});
