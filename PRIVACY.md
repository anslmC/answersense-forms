# AnswerSense: Forms Privacy Policy

**Effective Date: September 15, 2026**

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

## Google Gemini and External Requests

Google Gemini is the currently implemented AI provider. Relevant normalized Google Forms question data and applicable settled question-and-answer context may be sent to Google Gemini to generate answers.

Generation requests are made directly from the extension service worker to Google's Gemini API. AnswerSense does not operate an AnswerSense backend or proxy server that receives this form data. Credential and model validation also uses Google's Gemini API directly.

The extension currently uses the Gemini model configured by the implementation and sends the user's Gemini API key to Google in the request authentication header when generation or validation requires it. Google controls its own services and data-handling practices. Users should consult Google's applicable privacy and Gemini API documentation for information about Google's handling of API requests.

## API Keys and Credentials

Users provide their own Gemini API key through the AnswerSense: Forms overlay. Credential and configuration state is stored locally in encrypted configuration state using AES-GCM encryption. The encryption key is stored as a non-extractable Web Crypto key in IndexedDB.

The extension's UI configuration state exposes redacted credential records and does not return the raw API key as UI state. The API key is read by the extension service worker when needed and sent directly to the configured provider. AnswerSense does not send the API key to an AnswerSense server.

Local encryption reduces exposure of persisted configuration but does not guarantee protection against a compromised browser profile, compromised extension environment, or other access to the browser environment.

## Local Storage and Session Data

AnswerSense: Forms uses browser-local storage for different purposes:

- Persistent local configuration storage contains encrypted credentials, provider and model configuration, validation information, and related configuration metadata.
- Browser-session workflow storage can contain active questions, form and page identifiers, settled question-and-answer context, generated results, fill outcomes, visits, and other lifecycle state needed to continue the current workflow.
- Local UI preferences include the overlay's position and whether it was opened.

The implementation does not provide a separate permanent answer-history database. Session workflow data is not described as permanent history.

## Tracking, Analytics, and Advertising

The production implementation does not include analytics, advertising, tracking, telemetry, usage reporting, or a crash-reporting service.

## Form Submission and User Control

AnswerSense: Forms does not automatically submit Google Forms. Users review generated answers and may edit them before continuing or submitting the form through Google Forms.

The extension provides controls in its overlay to add, replace, validate, select, and delete stored credentials; select the provider and model; generate and fill answers; review results; override selected or filled answers; and re-enable generation for a settled page.

## Data Sharing

Form information is processed locally by the extension to discover, normalize, fill, and manage the current workflow. Data needed for generation, including relevant normalized questions and applicable settled answer context, is sent directly to Google Gemini. The API key is sent directly to Google for provider authentication and validation when required.

There is no AnswerSense backend or proxy server receiving this information. The production implementation does not include advertising or analytics.

## Security

AnswerSense: Forms uses local AES-GCM encryption for persisted credential and configuration state. It stores the non-extractable encryption key in IndexedDB and keeps raw credential secrets out of UI configuration state.

These measures are not an absolute security guarantee. Users remain responsible for protecting their browser profile, device, and Gemini API key.

## Open Source and Transparency

The source code for AnswerSense: Forms is publicly available at:

https://github.com/anslmC/answersense-forms

## Changes to This Policy

This policy may be updated when AnswerSense: Forms changes its data access, storage, transmission, or other privacy practices. The effective date above will identify the current version of this policy.

## Contact

For questions or issues about AnswerSense: Forms, users can use the project's public repository and issue tracker:

https://github.com/anslmC/answersense-forms/issues
