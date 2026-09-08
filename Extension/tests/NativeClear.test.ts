import { describe, expect, it } from 'vitest';
import {
  isNativeClearFormButton,
  observeNativeClear,
} from '../src/Content/NativeClear';

describe('Google Forms native Clear form detection', () => {
  it('matches the structural clear button and not localized text alone', () => {
    const document = new DOMParser().parseFromString(
      '<!doctype html><div role="button" class="freebirdFormviewerViewNavigationClearButton"><span>Formular leeren</span></div>',
      'text/html'
    );
    const clearButton = document.querySelector('span');
    const localizedTextOnly = document.createElement('div');
    localizedTextOnly.textContent = 'Clear form';

    expect(isNativeClearFormButton(clearButton)).toBe(true);
    expect(isNativeClearFormButton(localizedTextOnly)).toBe(false);
  });

  it('does not match answer controls or unrelated mutations', () => {
    const document = new DOMParser().parseFromString(
      '<!doctype html><button class="freebirdFormviewerViewNavigationSubmitButton">Clear form</button>',
      'text/html'
    );

    expect(isNativeClearFormButton(document.querySelector('button'))).toBe(false);
    expect(isNativeClearFormButton(null)).toBe(false);
  });

  it('invokes reset once when the same clear event is observed repeatedly', () => {
    const document = new DOMParser().parseFromString(
      '<!doctype html><div role="button" class="freebirdFormviewerViewNavigationClearButton"><span>Effacer le formulaire</span></div>',
      'text/html'
    );
    const button = document.querySelector('div') as HTMLElement;
    let resetCount = 0;
    const disconnect = observeNativeClear(document, () => {
      resetCount += 1;
    });
    const event = new MouseEvent('click', { bubbles: true });

    button.dispatchEvent(event);
    button.dispatchEvent(event);
    disconnect();

    expect(resetCount).toBe(1);
  });
});