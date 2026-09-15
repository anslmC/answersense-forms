<div align="center">
	<svg width="100%" viewBox="0 0 960 320" role="img" aria-labelledby="answersense-hero-title answersense-hero-description" xmlns="http://www.w3.org/2000/svg">
		<title id="answersense-hero-title">AnswerSense: Forms</title>
		<desc id="answersense-hero-description">Generate, AutoFill — Smarter Forms, Less Work</desc>
		<defs>
			<pattern id="answersense-freckle" width="137" height="113" patternUnits="userSpaceOnUse">
				<circle cx="17" cy="23" r="0.8" fill="#858585" opacity="0.18" />
				<circle cx="91" cy="17" r="0.55" fill="#747474" opacity="0.15" />
				<circle cx="62" cy="76" r="0.7" fill="#929292" opacity="0.12" />
				<circle cx="119" cy="96" r="0.45" fill="#6f6f6f" opacity="0.18" />
				<circle cx="29" cy="101" r="0.5" fill="#888888" opacity="0.14" />
			</pattern>
		</defs>
		<rect width="960" height="320" fill="#050505" />
		<rect width="960" height="320" fill="url(#answersense-freckle)" />
		<g transform="translate(0 32)">
		<g transform="translate(20 0) scale(17)" fill="#f3f0e8" aria-hidden="true">
			<path d="M16,13H8a3,3,0,0,1-3-3V6A3,3,0,0,1,8,3h8a3,3,0,0,1,3,3v4A3,3,0,0,1,16,13ZM8,5A1,1,0,0,0,7,6v4a1,1,0,0,0,1,1h8a1,1,0,0,0,1-1V6a1,1,0,0,0-1-1Z" />
			<path d="M10,9a1.05,1.05,0,0,1-.71-.29A1,1,0,0,1,10.19,7a.6.6,0,0,1,.19.06.56.56,0,0,1,.17.09l.16.12A1,1,0,0,1,10,9Z" />
			<path d="M14,9a1,1,0,0,1-.71-1.71,1,1,0,0,1,1.42,1.42,1,1,0,0,1-.16.12.56.56,0,0,1-.17.09.6.6,0,0,1-.19.06Z" />
			<path d="M12,4a1,1,0,0,1-1-1V2a1,1,0,0,1,2,0V3A1,1,0,0,1,12,4Z" />
		</g>
		<text x="410" y="146" fill="#f3f0e8" font-family="Comic Sans MS, Comic Sans, cursive" font-size="48" font-style="italic" font-weight="700" letter-spacing="0">AnswerSense: Forms</text>
		<text x="414" y="194" fill="#a7a39b" font-family="Comic Sans MS, Comic Sans, cursive" font-size="22" letter-spacing="0">Generate, AutoFill — Smarter Forms, Less Work</text>
		</g>
	</svg>
</div>

<br />

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