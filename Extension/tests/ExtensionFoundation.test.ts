import { describe, expect, it } from 'vitest';
import { isSupportedGoogleFormsPage } from '../src/Forms/Detection';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { questionTitleRejectionReason } from '../../Shared/QuestionTypes';
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

function createRespondentQuestionDocument(questionMarkup: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><main>
      <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform">
        <div role="list">
          ${questionMarkup}
        </div>
      </form>
    </main>`,
    'text/html'
  );
}

describe('Question title qualification', () => {
  it.each([
    ['empty', '', false],
    ['whitespace', '   ', false],
    ['newline and tab', '\n\t\r', false],
    ['nonbreaking space', '\u00a0', false],
    ['zero-width formatting characters', '\u200b\u200d\ufeff', false],
    ['punctuation only', '?!...', false],
    ['one letter', 'a', false],
    ['one number', '7', false],
    ['one non-English letter', '漢', false],
    ['one Unicode number', '٧', false],
    ['short question', 'Why?', true],
    ['two-letter acronym', 'AI?', true],
    ['instruction', 'Please explain your reasoning.', true],
    ['non-English text', '名前を入力してください', true],
    ['two non-English letters', '漢字', true],
    ['two Arabic-Indic numbers', '١٢', true],
    ['mathematical prompt', '2 + 2 = ?', true],
    ['one-letter title with a question-number prefix', '4.j *', false],
    ['one-letter title with spaced question-number prefix', '4. j *', false],
  ])('qualifies %s title independently', (_label, title, expected) => {
    expect(questionTitleRejectionReason(title)).toBe(
      expected ? null : 'Question title must contain at least two letters or numbers.'
    );
  });

  it('does not use accessibility labels, descriptions, required markers, or options as a title', () => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="no-title" aria-label="A valid accessible label" aria-required="true">
        <div data-description="true">A sufficiently long description that is not the title.</div>
        <div role="radio" aria-label="A sufficiently long option label" aria-checked="false"></div>
        <div role="radio" aria-label="Another sufficiently long option label" aria-checked="false"></div>
      </div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toMatchObject({
      kind: 'unsupported',
      id: 'no-title',
      text: null,
      reason: 'Question text is unavailable.',
    });
  });

  it('keeps a numbered required one-letter title unsupported without rewriting its title', () => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="q4" data-question-text="4.j *" aria-required="true">
        <input type="text" value="">
      </div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toEqual({
      kind: 'unsupported',
      id: 'q4',
      text: '4.j *',
      reason: 'Question title must contain at least two letters or numbers.',
    });
  });

  it('extracts the inner question title when a rendered heading wraps numbering and required text', () => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="q4">
        <div role="heading" aria-label="4.j * Required">
          <span>4.</span>
          <span class="M7eMe">j</span>
          <span>*</span>
          <span class="required-label">Required</span>
        </div>
        <input type="text" value="">
      </div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toMatchObject({
      kind: 'unsupported',
      id: 'q4',
      text: 'j',
      reason: 'Question title must contain at least two letters or numbers.',
    });
  });

  it.each([
    ['short answer', 'short-text', '<input type="text">'],
    ['paragraph', 'paragraph', '<textarea></textarea>'],
    ['multiple choice', 'multiple-choice', '<div role="checkbox"></div>'],
    ['single choice', 'single-choice', '<div role="radio"></div>'],
  ])('rejects the one-letter title j for %s questions', (_label, type, control) => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="one-letter" data-question-type="${type}" data-question-text="j">${control}</div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toMatchObject({
      kind: 'unsupported',
      id: 'one-letter',
      text: 'j',
      reason: 'Question title must contain at least two letters or numbers.',
    });
  });

  it.each([
    ['multiple choice', '<div role="radio" aria-label="Long option one"></div><div role="radio" aria-label="Long option two"></div>'],
    ['checkboxes', '<div role="checkbox" aria-label="Long option one"></div><div role="checkbox" aria-label="Long option two"></div>'],
  ])('does not let populated %s options qualify an empty title', (_label, options) => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="empty-title" data-question-text="">${options}</div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toMatchObject({
      kind: 'unsupported',
      id: 'empty-title',
      text: null,
      reason: 'Question text is unavailable.',
    });
  });
});

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
  it('uses a valid data-params question ID and preserves supported status through normalization', () => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem">
        <div data-params='%.@.[401]'></div>
        <h3 role="heading">Dummy question from metadata</h3>
        <input type="text" value="">
      </div>`
    );

    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions[0]).toMatchObject({
      kind: 'supported',
      id: '401',
      text: 'Dummy question from metadata',
      type: 'short-text',
    });
    const normalized = normalizeDiscoveredActivePage(discovered!);
    expect(normalized.form.questions[0]).toMatchObject({
      id: '401',
      supported: true,
      unsupportedReason: null,
    });
  });

  it('excludes a section header while discovering following paragraph questions', () => {
    const document = createRespondentQuestionDocument(
      `<div class="Qr7Oae" role="listitem">
        <h3 class="M7eMe" role="heading">Paragraph test header</h3>
      </div>
      <div class="Qr7Oae" role="listitem">
        <div data-params="%.@.[501]"></div>
        <h3 class="M7eMe" role="heading">Complete the sentence using both blanks: The first city is ____ and the second city is ____.</h3>
        <textarea></textarea>
      </div>
      <div class="Qr7Oae" role="listitem">
        <div data-params="%.@.[502]"></div>
        <h3 class="M7eMe" role="heading">Explain how the two answers relate to one another.</h3>
        <textarea></textarea>
      </div>`
    );

    const discovered = discoverActiveGoogleFormsPage(document)!;
    expect(discovered.questions).toEqual([
      expect.objectContaining({
        kind: 'supported',
        id: '501',
        text: 'Complete the sentence using both blanks: The first city is ____ and the second city is ____.',
        type: 'paragraph',
      }),
      expect.objectContaining({
        kind: 'supported',
        id: '502',
        text: 'Explain how the two answers relate to one another.',
        type: 'paragraph',
      }),
    ]);

    const normalized = normalizeDiscoveredActivePage(discovered);
    expect(normalized.questionResults.map((result) => result.status)).toEqual([
      'ready',
      'ready',
    ]);
  });

  it('falls back to container data-question-id and id for question identity', () => {
    const identityCases = [
      { attribute: 'data-question-id="dummy-data-id"', expectedId: 'dummy-data-id' },
      { attribute: 'id="dummy-element-id"', expectedId: 'dummy-element-id' },
    ];

    for (const identityCase of identityCases) {
      const document = createRespondentQuestionDocument(
        `<div role="listitem" ${identityCase.attribute}>
          <h3 role="heading">Dummy fallback question</h3>
          <input type="text" value="">
        </div>`
      );
      const discovered = discoverActiveGoogleFormsPage(document);

      expect(discovered?.questions[0]).toMatchObject({
        kind: 'supported',
        id: identityCase.expectedId,
        text: 'Dummy fallback question',
        type: 'short-text',
      });
      const normalized = normalizeDiscoveredActivePage(discovered!);
      expect(normalized.form.questions[0]).toMatchObject({
        id: identityCase.expectedId,
        supported: true,
        unsupportedReason: null,
      });
    }
  });

  it('uses a stable container ID when multiple data-params values are ambiguous', () => {
    const document = createRespondentQuestionDocument(
      `<div role="listitem" data-question-id="stable-question-id">
        <div data-params="malformed primary metadata"></div>
        <div data-params="malformed nested metadata"></div>
        <h3 role="heading">True or False</h3>
        <div role="radio" aria-label="True" aria-checked="true"></div>
        <div role="radio" aria-label="False" aria-checked="false"></div>
      </div>`
    );

    expect(discoverActiveGoogleFormsPage(document)?.questions[0]).toMatchObject({
      kind: 'supported',
      id: 'stable-question-id',
      text: 'True or False',
      type: 'single-choice',
      existingValue: 'True',
    });
  });

  it('marks a visible short-answer question without an identity source unsupported', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
        <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform"
            data-first-entry="7" data-last-entry="7">
          <div role="list">
            <div class="Qr7Oae" role="listitem">
              <h3 role="heading">Dummy question without identity</h3>
              <input type="text" value="">
            </div>
          </div>
        </form>
      </main>`,
      'text/html'
    );

    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions[0]).toMatchObject({
      kind: 'unsupported',
      id: null,
      text: 'Dummy question without identity',
      reason: 'Question ID is unavailable.',
    });
    const normalized = normalizeDiscoveredActivePage(discovered!);
    expect(normalized.form.questions[0]).toMatchObject({
      id: null,
      supported: false,
      unsupportedReason: 'Question ID is unavailable.',
    });
  });

  it('uses partially unmatched aria-labelledby references after blank identity candidates', () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><main>
        <form data-clean-viewform-url="https://docs.google.com/forms/d/e/example/viewform"
            data-first-entry="8" data-last-entry="8">
          <div role="list">
            <div class="Qr7Oae" role="listitem"
                aria-labelledby="dummy-title missing-description">
              <h3 id="dummy-title" role="heading">Dummy question with partial references</h3>
              <input type="text" value="">
            </div>
          </div>
        </form>
      </main>`,
      'text/html'
    );

    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions[0]).toMatchObject({
      kind: 'supported',
      id: 'dummy-title missing-description',
      text: 'Dummy question with partial references',
      type: 'short-text',
    });
    const normalized = normalizeDiscoveredActivePage(discovered!);
    expect(normalized.form.questions[0]).toMatchObject({
      id: 'dummy-title missing-description',
      supported: true,
      unsupportedReason: null,
    });
  });

  it('discovers a Qr7Oae respondent short-answer container with an id-less input', () => {
    const document = createRespondentQuestionDocument(
      `<div class="Qr7Oae" role="listitem" data-question-id="dummy-short">
        <h3 role="heading">Dummy short prompt</h3>
        <input type="text" value="">
      </div>`
    );

    const result = discoverActiveGoogleFormsPage(document);

    expect(result?.questions).toHaveLength(1);
    expect(result?.questions[0]).toMatchObject({
      kind: 'supported',
      id: 'dummy-short',
      text: 'Dummy short prompt',
      type: 'short-text',
    });
    const input = document.querySelector('input[type="text"]');
    expect(input?.hasAttribute('id')).toBe(false);
    expect(input?.hasAttribute('name')).toBe(false);
  });

  it('discovers radios inside a radiogroup without treating its hidden sentinel as a control', () => {
    const document = createRespondentQuestionDocument(
      `<div class="Qr7Oae" role="listitem" data-question-id="dummy-choice">
        <h3 role="heading">Dummy single-choice prompt</h3>
        <div role="radiogroup">
          <input type="hidden" value="">
          <div role="radio" aria-label="Dummy option A" aria-checked="false"></div>
          <div role="radio" aria-label="Dummy option B" aria-checked="true"></div>
        </div>
      </div>`
    );

    const result = discoverActiveGoogleFormsPage(document);

    expect(result?.questions).toHaveLength(1);
    expect(result?.questions[0]).toMatchObject({
      kind: 'supported',
      id: 'dummy-choice',
      text: 'Dummy single-choice prompt',
      type: 'single-choice',
      options: [
        { label: 'Dummy option A', selected: false },
        { label: 'Dummy option B', selected: true },
      ],
    });
  });

  it('uses visible question text when aria-labelledby is only partially matched', () => {
    const document = createRespondentQuestionDocument(
      `<div class="Qr7Oae" role="listitem" data-question-id="dummy-aria"
          aria-labelledby="dummy-title missing-description">
        <h3 id="dummy-title" role="heading">Dummy prompt with partial ARIA reference</h3>
        <input type="text" value="">
      </div>`
    );

    const result = discoverActiveGoogleFormsPage(document);

    expect(result?.questions[0]).toMatchObject({
      kind: 'supported',
      id: 'dummy-aria',
      text: 'Dummy prompt with partial ARIA reference',
      type: 'short-text',
    });
  });

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
