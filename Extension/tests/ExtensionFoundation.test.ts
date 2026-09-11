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
    'text/html'
  );
}

function createRealisticRespondentDocument(): Document {
  const parser = new DOMParser();
  return parser.parseFromString(
    `<!doctype html><main>
    <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
      <div role="list">
        <div role="listitem">
          <div data-params='%.@.[101,"Capital city?",null,0,[[201,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"Capital city?"]],"q1","q2",false,"q3"]'></div>
          <h3 role="heading">Capital city?</h3>
          <input type="text" value="">
        </div>
        <div role="listitem">
          <div data-params='%.@.[102,"Web languages",null,4,[[202,[["HTML",null,null,null,false],["JavaScript",null,null,null,false]],false,null,null,null,null,null,false,null,[]]],null,null,null,null,null,null,[null,"Web languages"]],"q4","q5",false,"q6"]'></div>
          <h3 role="heading">Web languages</h3>
          <div role="list">
            <div role="listitem"><div role="checkbox" aria-label="HTML" aria-checked="false"></div></div>
            <div role="listitem"><div role="checkbox" aria-label="JavaScript" aria-checked="false"></div></div>
          </div>
        </div>
        <div role="listitem">
          <div data-params='%.@.[103,"Plant color",null,1,[[203,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"Plant color"]],"q7","q8",false,"q9"]'></div>
          <h3 role="heading">Plant color</h3>
          <textarea></textarea>
        </div>
        <div role="listitem">
          <div data-params='%.@.[104,"Bond singer",null,2,[[204,[["Adele",null,null,null,false],["Sam Smith",null,null,null,false]],false,null,null,null,null,null,false,null,[]]],null,null,null,null,null,null,[null,"Bond singer"]],"q10","q11",false,"q12"]'></div>
          <h3 role="heading">Bond singer</h3>
          <div role="radio" aria-label="Adele" aria-checked="false"></div>
          <div role="radio" aria-label="Sam Smith" aria-checked="false"></div>
        </div>
        <div role="listitem">
          <div data-params='%.@.[105,"Other languages",null,4,[[205,[["CSS",null,null,null,false],["HTML",null,null,null,false]],false,null,null,null,null,null,false,null,[]]],null,null,null,null,null,null,[null,"Other languages"]],"q13","q14",false,"q15"]'></div>
          <h3 role="heading">Other languages</h3>
          <div role="list">
            <div role="listitem"><div role="checkbox" aria-label="CSS" aria-checked="false"></div></div>
            <div role="listitem"><div role="checkbox" aria-label="HTML" aria-checked="false"></div></div>
          </div>
        </div>
      </div>
    </form>
  </main>`,
    'text/html'
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
    expect(
      isSupportedGoogleFormsPage('https://docs.google.com/forms/d/e/abc/view')
    ).toBe(true);
  });

  it('rejects non-Google-Forms URLs', () => {
    expect(
      isSupportedGoogleFormsPage('https://example.com/forms/d/e/abc/view')
    ).toBe(false);
    expect(
      isSupportedGoogleFormsPage('https://docs.google.com/document/d/abc')
    ).toBe(false);
  });
});

describe('Active Google Forms page discovery', () => {
  it('models nested option listitems without treating them as questions', () => {
    const document = createRealisticRespondentDocument();

    expect(
      document.querySelectorAll('[role="listitem"], [data-question-id]')
    ).toHaveLength(9);

    const result = discoverActiveGoogleFormsPage(document);

    expect(result?.questions).toHaveLength(5);
    expect(
      result?.questions.map((question) => [
        question.id,
        question.text,
        question.kind,
      ])
    ).toEqual([
      ['101', 'Capital city?', 'supported'],
      ['102', 'Web languages', 'supported'],
      ['103', 'Plant color', 'supported'],
      ['104', 'Bond singer', 'supported'],
      ['105', 'Other languages', 'supported'],
    ]);
    expect(
      result?.questions.map((question) =>
        question.kind === 'supported' ? question.type : null
      )
    ).toEqual([
      'short-text',
      'multiple-choice',
      'paragraph',
      'single-choice',
      'multiple-choice',
    ]);
  });

  it('falls back to existing respondent-form question IDs when data-params is absent', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div role="list">
          <div role="listitem" data-question-id="301" data-question-text="What is your name?">
            <h3 role="heading">What is your name?</h3>
            <input type="text" value="Ada Lovelace">
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toEqual({
      pageId: 'questions:301',
      formId: 'example',
      questions: [
        expect.objectContaining({ id: '301', kind: 'supported', text: 'What is your name?' }),
      ],
    });
  });

  it('fails closed when respondent question identity metadata is missing or malformed', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div role="list">
          <div role="listitem"><h3 role="heading">Missing identity</h3><input type="text"></div>
          <div role="listitem">
            <div data-params='not-google-forms-data'></div>
            <h3 role="heading">Malformed identity</h3>
            <input type="text">
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toBeNull();
  });

  it('discovers the current respondent form structure using its clean view-form URL', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div class="o3Dpx" role="list">
          <div role="listitem">
            <div data-params='%.@.[301,"What is your name?",null,0,[[401,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"What is your name?"]],"i1","i2",false,"i3"]'></div>
            <h3 role="heading">What is your name?</h3>
            <div data-question-type="short-text">
              <input type="text" value="Ada Lovelace">
            </div>
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toEqual({
      pageId: 'questions:301',
      formId: 'example',
      questions: [expect.objectContaining({ id: '301', kind: 'supported' })],
    });
  });

  it('fails closed when the visible respondent form has no page identity', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/hidden/viewform" hidden>
        <div class="o3Dpx" role="list"></div>
      </form>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/visible/viewform">
        <div class="o3Dpx" role="list"></div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toBeNull();
  });

  it('uses the respondent form entry range as page identity', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform"
        data-first-entry="3" data-last-entry="6">
        <div class="o3Dpx" role="list">
          <div role="listitem">
            <div data-params='%.@.[301,"Question",null,0,[[401,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"Question"]]'></div>
            <h3 role="heading">Question</h3>
            <input type="text">
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toMatchObject({
      pageId: 'entry:3-6',
      formId: 'example',
      pageEntryRange: { first: 3, last: 6 },
    });
  });

  it('falls back to the ordered question IDs when entry metadata is absent', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div class="o3Dpx" role="list">
          <div role="listitem">
            <div data-params='%.@.[301,"First",null,0,[[401,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"First"]]'></div>
            <h3 role="heading">First</h3><input type="text">
          </div>
          <div role="listitem">
            <div data-params='%.@.[302,"Second",null,0,[[402,null,false,null,null,null,null,null,null,[]]],null,null,null,null,null,null,[null,"Second"]]'></div>
            <h3 role="heading">Second</h3><input type="text">
          </div>
        </div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)?.pageId).toBe(
      'questions:301,302'
    );
  });

  it('fails closed when neither entry metadata nor complete question IDs exist', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div class="o3Dpx" role="list"><div role="listitem"><h3 role="heading">Unknown</h3></div></div>
      </form>
    </main>`,
      'text/html'
    );

    expect(discoverActiveGoogleFormsPage(document)).toBeNull();
  });

  it('discovers only the active page and its questions', () => {
    const result = discoverActiveGoogleFormsPage(createDocument());

    expect(result?.pageId).toBe('page-1');
    expect(result?.questions).toHaveLength(4);
    expect(result?.questions.map((question) => question.id)).not.toContain(
      'future'
    );
  });

  it('extracts supported types, required state, options, and existing values', () => {
    const result = discoverActiveGoogleFormsPage(createDocument());
    const questions = result?.questions.filter(
      (question) => question.kind === 'supported'
    );

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
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-id="paragraph" data-question-text="Details" data-question-type="paragraph" aria-required="true">
          <textarea>Existing details</textarea>
        </div>
        <div role="listitem" data-question-id="dropdown" data-question-text="Pick one" data-question-type="dropdown">
          <div role="listbox"></div>
        </div>
      </section>
    </main>`,
      'text/html'
    );

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
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-text="Missing ID"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="First"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="Second"><input type="text"></div>
      </section>
    </main>`,
      'text/html'
    );

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
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="listitem" data-question-id="  trimmed-id  " data-question-text="Trimmed"><input type="text"></div>
        <div role="listitem" data-question-id="   " data-question-text="Whitespace"><input type="text"></div>
        <div role="listitem" data-question-id="" data-question-text="Empty"><input type="text"></div>
        <div role="listitem" data-question-text="Missing"><input type="text"></div>
        <div role="listitem" data-question-id=" duplicate " data-question-text="First"><input type="text"></div>
        <div role="listitem" data-question-id="duplicate" data-question-text="Second"><input type="text"></div>
      </section>
    </main>`,
      'text/html'
    );

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
