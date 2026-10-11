# AnswerSense: Forms Privacy Policy

**Effective Date: October 11, 2026**

## Introduction

AnswerSense: Forms is a Chromium browser extension that helps users process supported Google Forms respondent pages with AI. It operates on the active form page one page at a time, discovers supported questions, generates answers, fills supported fields, and lets the user review and submit the form.

## Information AnswerSense Accesses

To provide these features, the extension may access information needed to process the active Google Form, including:

- Question text, question types, question IDs, and required status.
- Option or choice labels.
- Existing answers in supported controls.
- Answers entered or edited by the user.
- Relevant form and page identifiers.
- Settled question-and-answer context from earlier pages that the user has completed.
- Generated answers, fill outcomes, and related workflow state.

The extension processes normalized logical form data rather than transmitting raw page HTML or DOM references. Its implementation is limited to the active supported Google Forms page. It does not include a feature for collecting unrelated browsing activity or arbitrary website content.

## How Information Is Used

AnswerSense: Forms uses this information to:

- Understand the active form page and its supported questions.
- Generate answers for supplied questions.
- Fill supported form fields.
- Preserve relevant settled context for subsequent generation requests.
- Show generation and fill results so the user can review and edit answers.

## Provider Requests and External Services

AnswerSense currently supports Google Gemini and NVIDIA. For generation, the extension sends the selected provider the normalized questions being processed, their relevant question and page identifiers, and applicable settled question-and-answer context from earlier completed pages. It does not send raw page HTML or DOM references.

Requests go directly from the extension service worker to the selected provider API using the user's key. The production extension has no AnswerSense backend or proxy that receives form data or API keys. The required host permissions cover supported Google Forms pages and the Google Generative Language and NVIDIA Integrate API hosts.

Gemini requests use the `x-goog-api-key` authentication header. Gemini credential validation requests model information from Google's API; it does not submit form questions. NVIDIA requests use bearer-key authentication. NVIDIA credential validation sends a fixed synthetic question about labeling shared garden tools to the selected NVIDIA model as a probe. This validation probe is not taken from the user's form. Generation and validation requests are handled by the selected provider under that provider's policies. Users should consult Google's or NVIDIA's current privacy and API documentation for information about provider-side handling.

## API Keys and Credentials

Users provide their own Gemini or NVIDIA API key through the AnswerSense: Forms overlay. The key is entered in a native browser prompt and passed to the extension service worker. Credential and configuration state is stored in `chrome.storage.local` as AES-GCM-encrypted state. The non-extractable Web Crypto encryption key is stored in IndexedDB.

The UI receives redacted credential records, not raw API keys. The service worker reads a stored key when needed and sends it directly to the configured provider for generation or validation.

Treat provider API keys as secrets. Do not publish or commit them, include them in screenshots, or share them in issue reports.

## Local Storage and Session Data

AnswerSense: Forms uses browser-local storage for different purposes:

- Persistent local configuration storage contains encrypted credentials, provider and model configuration, validation information, and related configuration metadata.
- Session-scoped workflow storage can contain active questions, form and page identifiers, settled question-and-answer context, generated results, fill outcomes, visits, and other lifecycle state needed to continue the current workflow.
- Local UI preferences include the overlay's position and whether it was opened.

The implementation does not provide a separate permanent answer-history database. Session workflow data is not a permanent answer history.

## Tracking, Analytics, and Advertising

The production implementation does not include analytics, advertising, tracking, telemetry, usage reporting, or a crash-reporting service.

## Form Submission and User Control

AnswerSense: Forms does not automatically submit Google Forms. Users review generated answers and may edit them before continuing or submitting the form through Google Forms.

The extension provides controls in its overlay to add, replace, validate, select, and delete stored credentials; select the provider and model; generate and fill answers; review results; override selected or filled answers; and re-enable generation for a settled page.

## Security

Encryption reduces exposure of persisted configuration but is not an absolute security guarantee. It does not protect against a compromised browser profile or extension environment with access to the encryption key. Users remain responsible for protecting their browser profile, device, and provider API keys.

## Open Source and Transparency

The source code for AnswerSense: Forms is publicly available at:

https://github.com/anslmC/answersense-forms

## Changes to This Policy

This policy may be updated when AnswerSense: Forms changes its data access, storage, transmission, or other privacy practices. The effective date above will identify the current version of this policy.

## Contact

For questions or issues about AnswerSense: Forms, users can use the project's public repository and issue tracker:

https://github.com/anslmC/answersense-forms/issues
