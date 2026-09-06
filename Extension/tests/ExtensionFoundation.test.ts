import { describe, expect, it } from 'vitest';
import { isSupportedGoogleFormsPage } from '../src/Forms/Detection';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { EXTENSION_NAME, GOOGLE_FORMS_MATCHES } from '../src/Shared/Utils';

function createDocument(): Document {
  const parser = new DOMParser();
  return parser.parseFromString(
    `<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true" aria-label="Section 1">
        <div role="listitem" data-question-id="name" data-question-text="What is your name?" aria-required="true">
          <input type="text" value="Ada Lovelace">
        </div>
        <div role="listitem" data-question-id="language" data-question-text="Which language do you prefer?">
          <div role="radio" aria-label="TypeScript" aria-checked="true"></div>
          <div role="radio" aria-label="JavaScript" aria-checked="false"></div>
        </div>
        <div role="listitem" data-question-id="topics" data-question-text="Which topics interest you?">
          <div role="checkbox" aria-label="Testing" aria-checked="true"></div>
          <div role="checkbox" aria-label="Accessibility" aria-checked="true"></div>
        </div>
        <div role="listitem" data-question-id="unknown" data-question-text="Unsupported prompt">
          <div role="slider" aria-valuenow="3"></div>
        </div>
      </section>
      <section data-page-id="page-2" aria-hidden="true">
        <div role="listitem" data-question-id="future" data-question-text="Future question">
          <input type="text" value="must not be discovered">
        </div>
      </section>
    </main>`,
    'text/html',
  );
}

describe('Extension foundation', () => {
  it('exposes the expected extension identity', () => {
    expect(EXTENSION_NAME).toBe('AnswerSense: Forms');
  });

  it('declares the supported Google Forms host scope', () => {
    expect(GOOGLE_FORMS_MATCHES).toContain('https://docs.google.com/forms/*');
  });
});

describe('Google Forms detection', () => {
  it('detects supported Google Forms URLs', () => {
    expect(isSupportedGoogleFormsPage('https://docs.google.com/forms/d/e/abc/view')).toBe(
      true,
    );
  });

  it('rejects non-Google-Forms URLs', () => {
    expect(isSupportedGoogleFormsPage('https://example.com/forms/d/e/abc/view')).toBe(false);
    expect(isSupportedGoogleFormsPage('https://docs.google.com/document/d/abc')).toBe(false);
  });
});

describe('Active Google Forms page discovery', () => {
  it('discovers only the active page and its questions', () => {
    const result = discoverActiveGoogleFormsPage(createDocument());

    expect(result?.pageId).toBe('page-1');
    expect(result?.questions).toHaveLength(4);
    expect(result?.questions.map((question) => question.id)).not.toContain('future');
  });

  it('extracts supported types, required state, options, and existing values', () => {
    const result = discoverActiveGoogleFormsPage(createDocument());
    const questions = result?.questions.filter((question) => question.kind === 'supported');

    expect(questions).toEqual([
      expect.objectContaining({
        id: 'name',
        text: 'What is your name?',
        type: 'short-text',
        required: true,
        options: [],
        existingValue: 'Ada Lovelace',
      }),
      expect.objectContaining({
        id: 'language',
        type: 'single-choice',
        options: [
          { label: 'TypeScript', selected: true },
          { label: 'JavaScript', selected: false },
        ],
        existingValue: 'TypeScript',
      }),
      expect.objectContaining({
        id: 'topics',
        type: 'multiple-choice',
        existingValue: ['Testing', 'Accessibility'],
      }),
    ]);
  });

  it('reports deterministically unrecognized questions as unsupported', () => {
    const result = discoverActiveGoogleFormsPage(createDocument());
    expect(result?.questions[3]).toEqual({
      kind: 'unsupported',
      id: 'unknown',
      text: 'Unsupported prompt',
      reason: 'Question type is unsupported.',
    });
  });

  it('discovers paragraph controls and excludes dropdowns from supported discovery', () => {
    const document = new DOMParser().parseFromString(`<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-id="paragraph" data-question-text="Details" data-question-type="paragraph" aria-required="true">
          <textarea>Existing details</textarea>
        </div>
        <div role="listitem" data-question-id="dropdown" data-question-text="Pick one" data-question-type="dropdown">
          <div role="listbox"></div>
        </div>
      </section>
    </main>`, 'text/html');

    expect(discoverActiveGoogleFormsPage(document)?.questions).toEqual([
      {
        kind: 'supported',
        id: 'paragraph',
        text: 'Details',
        type: 'paragraph',
        required: true,
        options: [],
        existingValue: 'Existing details',
      },
      {
        kind: 'unsupported',
        id: 'dropdown',
        text: 'Pick one',
        reason: 'Question type is unsupported.',
      },
    ]);
  });

  it('classifies missing and duplicate question IDs as unsupported', () => {
    const document = new DOMParser().parseFromString(`<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-text="Missing ID"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="First"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="Second"><input type="text"></div>
      </section>
    </main>`, 'text/html');

    expect(discoverActiveGoogleFormsPage(document)?.questions).toEqual([
      {
        kind: 'unsupported',
        id: null,
        text: 'Missing ID',
        reason: 'Question ID is unavailable.',
      },
      {
        kind: 'unsupported',
        id: 'duplicate',
        text: 'First',
        reason: 'Question ID is ambiguous because it is duplicated.',
      },
      {
        kind: 'unsupported',
        id: 'duplicate',
        text: 'Second',
        reason: 'Question ID is ambiguous because it is duplicated.',
      },
    ]);
  });

  it('trims valid IDs and rejects empty or whitespace-only IDs', () => {
    const document = new DOMParser().parseFromString(`<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-id="  trimmed-id  " data-question-text="Trimmed"><input type="text"></div>
        <div role="listitem" data-question-id="   " data-question-text="Whitespace"><input type="text"></div>
        <div role="listitem" data-question-id="" data-question-text="Empty"><input type="text"></div>
        <div role="listitem" data-question-text="Missing"><input type="text"></div>
        <div role="listitem" data-question-id=" duplicate " data-question-text="First"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="Second"><input type="text"></div>
      </section>
    </main>`, 'text/html');

    expect(discoverActiveGoogleFormsPage(document)?.questions).toEqual([
      expect.objectContaining({ kind: 'supported', id: 'trimmed-id' }),
      {
        kind: 'unsupported',
        id: null,
        text: 'Whitespace',
        reason: 'Question ID is unavailable.',
      },
      {
        kind: 'unsupported',
        id: null,
        text: 'Empty',
        reason: 'Question ID is unavailable.',
      },
      {
        kind: 'unsupported',
        id: null,
        text: 'Missing',
        reason: 'Question ID is unavailable.',
      },
      {
        kind: 'unsupported',
        id: 'duplicate',
        text: 'First',
        reason: 'Question ID is ambiguous because it is duplicated.',
      },
      {
        kind: 'unsupported',
        id: 'duplicate',
        text: 'Second',
        reason: 'Question ID is ambiguous because it is duplicated.',
      },
    ]);
  });
});