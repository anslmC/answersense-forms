# AnswerSense: Forms

AnswerSense: Forms is a Chromium browser extension that helps answer supported Google Forms pages with AI. It works one page at a time: discover the active page, generate answers, fill supported controls, and let you review and submit the form yourself.

## Providers

AnswerSense uses an AI provider abstraction that allows additional providers to be integrated in the future. Gemini is the currently supported and recommended provider.

## Get Started

## Recommended Provider: Google Gemini

Gemini is currently the easiest way to get started with AnswerSense because the project directly supports Gemini and users can create and manage their own key through [Google AI Studio](https://aistudio.google.com/).

Google's current API-key guidance is available in the official [Gemini API key documentation](https://ai.google.dev/gemini-api/docs/api-key). To create a key, open Google AI Studio, sign in if required, and use the API-key creation flow described there. Google may require selecting or creating a Google Cloud project and may show additional setup or billing choices depending on the account and current service policies.

Treat the key as a secret. Do not publish it, commit it to a repository, put it in screenshots, or share it in issue reports. Gemini availability, limits, quotas, and pricing are controlled by Google and may change. Google AI Studio and the [official Gemini API documentation](https://ai.google.dev/gemini-api/docs/api-key) are authoritative for current terms and usage options.

## Configure an API Key

1. Open a supported Google Form in respondent view.
2. Open the AnswerSense overlay.
3. Expand **Configuration** and choose **Add API key**.
4. Enter a label if requested, then enter the Gemini key in the native browser prompt. The key is not rendered into the Google Forms page or overlay DOM.
5. Select Gemini, select its available model, choose the stored key, save the configuration, and validate it.

The extension uses the key for direct requests to Google's Gemini API. It does not send the key to an AnswerSense server.

## Basic Usage

1. Navigate to a supported Google Form page.
2. Open the AnswerSense overlay and configure a validated provider credential.
3. Choose **Generate & Auto-Fill** for the current page.
4. Review and edit the generated answers.
5. Use the form's own navigation controls to continue. A page enters settled context only after Google Forms accepts Next and a page transition is observed.
6. Submit the form manually when you are satisfied with the answers.

## Privacy and Security

- Generation follows the direct path `Google Forms -> content script -> Shadow DOM overlay -> service worker -> AI provider -> provider API`.
- The service worker owns provider credential access and sends Gemini requests directly to Google's Gemini API, using the API key for provider authentication. AnswerSense has no backend or proxy.
- Configuration state is stored in `chrome.storage.local` and encrypted with AES-GCM.
- The non-extractable AES-GCM CryptoKey is stored in IndexedDB database `answersense-credential-security`, object store `keys`.
- UI credential records are redacted; raw API keys are not exposed through UI configuration state or runtime messages.
- API-key entry uses a native browser prompt rather than an API-key input rendered in the page or overlay DOM.
- Form content is treated as untrusted data and sent as normalized logical data rather than raw HTML or DOM references.

Browser-local encryption reduces exposure of persisted state but does not make a browser-held API key a server-side secret. Keep your browser profile and API key secure.

## Architecture

See the canonical production architecture in [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

## License

This repository is offered under the PolyForm Shield License 1.0.0. See [LICENSE](LICENSE) for the license text.