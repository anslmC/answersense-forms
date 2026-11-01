import { describe, expect, it } from 'vitest';
import { extractQuestionId } from '../src/Forms/QuestionIdentity';
import { discoverActiveGoogleFormsPage } from '../src/Forms/Discovery';
import { normalizeDiscoveredActivePage } from '../src/Forms/Normalization';
import { resolveCurrentQuestionTarget } from '../src/Fill/Resolver';

function element(html: string): HTMLElement {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.body.firstElementChild as HTMLElement;
}

function respondentDocument(value = ''): Document {
  return new DOMParser().parseFromString(
    `<!doctype html>
    <form data-clean-viewform-url="https://docs.google.com/forms/d/e/form-1/viewform">
      <section data-page-id="page-1" data-answersense-active-page="true">
        <div role="list">
          <div role="listitem" id="fallback-dom-id" aria-labelledby="fallback-label">
            <div data-params="%.@.[987654321,0]"></div>
            <div class="M7eMe">What is your name?</div>
            <input type="text" value="${value}">
          </div>
        </div>
      </section>
    </form>`,
    'text/html'
  );
}

describe('question identity resolution', () => {
  it('prefers the numeric data-params payload identifier', () => {
    const question = element(
      '<div role="listitem" id="dom-id" data-question-id="fixture-id" aria-labelledby="label-id">' +
        '<div data-params="%.@.[123456789,0]"></div></div>'
    );

    expect(extractQuestionId(question)).toBe('123456789');
  });

  it('ignores malformed, non-numeric, and non-positive payload identifiers', () => {
    for (const payload of [
      'not-a-payload',
      '%.@.[0]',
      '%.@.[-4]',
      '%.@.["987654321"]',
      '%.@.[1.5]',
      '%.@.[123456789',
    ]) {
      const question = element(
        `<div data-question-id="fixture-id"><div data-params="${payload}"></div></div>`
      );
      expect(extractQuestionId(question)).toBe('fixture-id');
    }
  });

  it('falls back through container attributes in a fixed order', () => {
    expect(
      extractQuestionId(
        element(
          '<div data-question-id="q-1" id="dom-id" aria-labelledby="label-id"></div>'
        )
      )
    ).toBe('q-1');
    expect(
      extractQuestionId(
        element('<div id="dom-id" aria-labelledby="label-id"></div>')
      )
    ).toBe('dom-id');
    expect(
      extractQuestionId(element('<div aria-labelledby="label-id"></div>'))
    ).toBe('label-id');
  });

  it('returns null when the container carries no identity', () => {
    expect(extractQuestionId(element('<div></div>'))).toBeNull();
  });

  it('resolves the same identity for discovery and filling', () => {
    const document = respondentDocument();
    const discovered = discoverActiveGoogleFormsPage(document);

    expect(discovered?.questions[0]).toMatchObject({
      kind: 'supported',
      id: '987654321',
    });

    const normalized = normalizeDiscoveredActivePage(discovered!);
    const resolved = resolveCurrentQuestionTarget(
      document,
      normalized.form.questions[0]
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.questionId).toBe('987654321');
    }
  });
});
