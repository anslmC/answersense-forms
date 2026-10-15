<div align="center">
	<img src="assets/answersense-readme-header.png" alt="AnswerSense: Forms — Generate, AutoFill — Smarter Forms, Less Work" width="960" />
</div>

<br />

AnswerSense: Forms is a Chromium browser extension that helps answer supported Google Forms pages with AI. It works one page at a time: discover the active page, generate answers, fill supported controls, and let you review and submit the form yourself.

## Providers

AnswerSense currently supports Google Gemini and NVIDIA. Gemini is the easiest recommended starting point. The available models are Gemini 3.5 Flash-Lite, Gemini 3.1 Flash-Lite, NVIDIA Nemotron 3 Super, and OpenAI GPT-OSS 20B through NVIDIA's API.

## Get Started

Install AnswerSense: Forms from the [Chrome Web Store](https://chromewebstore.google.com/detail/ghcpcngmjpamhghcjablpamdncolblbn?utm_source=item-share-cb).

## Recommended Provider: Google Gemini

Gemini is the easiest way to get started with AnswerSense. Create a Gemini API key through [Google AI Studio](https://aistudio.google.com/). NVIDIA is also supported; its API keys are managed through [NVIDIA Build](https://build.nvidia.com/settings/api-keys).

Google's current API-key guidance is available in the official [Gemini API key documentation](https://ai.google.dev/gemini-api/docs/api-key). To create a key, open Google AI Studio, sign in if required, and use the API-key creation flow described there. Google may require selecting or creating a Google Cloud project and may show additional setup or billing choices depending on the account and current service policies.

API availability, free usage, quotas, rate limits, and pricing are controlled by each provider and may change. Check the provider's current API documentation and terms before use.

## Configure a Provider

1. Open a Google Forms respondent page ending in `/viewform`.
2. Open AnswerSense with the floating launcher near the top-right, or use the extension's browser toolbar action.
3. Expand **Configuration** and select Gemini or NVIDIA.
4. Choose **Add API key**, enter an optional label, and enter that provider's key in the native browser prompt.
5. Select a model and stored key, then choose **Save & Validate**.

## Basic Usage

1. Open a supported Google Forms respondent page and open the AnswerSense overlay from the launcher or browser toolbar.
2. Configure and validate a credential for the provider and model you want to use.
3. Choose **Generate & Auto-Fill** for the current page.
4. Review and edit the generated answers.
5. Use the form's own navigation controls to continue. A page enters settled context only after Google Forms accepts Next and a page transition is observed.
6. Submit the form manually when you are satisfied with the answers.

## Troubleshooting

If validation fails, check that the key belongs to the selected provider and that the provider account can access the selected model. For availability, quota, or rate-limit errors, check that provider's current service status and usage terms.

## Privacy

For details about AnswerSense's data handling, privacy practices, and security considerations, see the [Privacy Policy](PRIVACY.md).

## Architecture

See the canonical production architecture in [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

## License

This repository is offered under the AnswerSense Source-Available License 1.0. It permits public source access and noncommercial, noncompeting source sharing under its conditions. It also permits commercial or noncommercial tutorials, reviews, articles, documentation, explanations, and technical discussions about AnswerSense, including limited excerpts of unmodified source reasonably necessary for those purposes, but not substantial portions or a substitute for accessing the source. This limited commentary permission does not grant other commercial rights, authorize promotion of a Competing Product, or permit publication of modified source outside the license's conditions. Other commercial use and competing-product source publication require prior written authorization; distributing installable or executable versions requires prior written authorization whether free or paid. See [LICENSE](LICENSE) for the full terms.

## Support AnswerSense

Enjoying AnswerSense? Your support helps make new features and improvements possible.

[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/anslmdevgo)
