# AnswerSense: Forms Architecture

## Scope

This document describes the current production architecture of AnswerSense: Forms.

The production implementation is an extension-only, direct BYOK design for supported Google Forms respondent pages.

AI provider integration is represented as an extension boundary. Gemini is the currently implemented provider; additional providers can be integrated through the same boundary.

Possible Android device support is a future consideration and is not part of the current implementation.

## Production Flow

```text
Google Forms
  -> Content Script
  -> Shadow DOM Overlay
  -> Service Worker
  -> AI Provider
  -> Provider API
```

Current provider path:

```text
AI Provider
  -> GeminiProvider
  -> Google Gemini API
```

Provider requests are sent directly from the service worker to the configured provider API. There is no AnswerSense backend workspace or server in the current production architecture.

## Google Forms Integration

The content script provides the Google Forms integration layer. It:

- detects the active respondent page
- discovers questions on the active page
- normalizes question and control data
- observes navigation and lifecycle transitions
- resolves current form controls
- fills supported answers

The processing lifecycle is:

**Discover -> Normalize -> Generate -> Validate -> Fill -> Review -> Settle -> Accumulate Context -> Continue**

Processing is limited to the active page. The extension does not crawl the full form in advance or automatically navigate between pages.

A page settles only after the user selects Next, Google Forms accepts the page, and an actual page transition is observed. Required-field validation remains controlled by Google Forms.

After settlement, subsequent generation requests may receive the prior settled question/answer context. Unanswered optional or skipped questions are omitted. User-edited values are authoritative when a page settles.

Revisited pages are re-checked. Changed pages are reprocessed; unchanged state may be reused. Downstream settled pages are not automatically regenerated after an upstream edit.

## Shadow DOM Overlay

The production UI is the content-script-mounted overlay implemented in `Extension/src/Overlay/Overlay.ts`.

The overlay:

- creates the overlay host on the Google Forms page
- attaches an open Shadow DOM root
- injects the overlay stylesheet
- mounts the workflow application inside the shadow root

The Shadow DOM Overlay is the production UI and source of truth for:

- configuration
- credential management
- validation
- generation
- review
- fill state

The shadow root isolates overlay markup and styling from the surrounding page. The content script continues to interact with Google Forms controls outside the shadow root.

## Service Worker

The Manifest V3 service worker provides privileged coordination and provider access.

It:

- receives messages from the content script and extension UI
- maintains integration and lifecycle state
- authorizes the active configuration
- validates configuration revisions
- reads credential secrets from encrypted local state
- resolves the configured provider, model, and adapter
- performs provider generation and credential validation
- sanitizes provider failures before returning them
- prevents raw credentials from being returned to page content

Generation requests from the content script pass through the service worker. The service worker resolves the selected provider adapter, supplies the authorized credential, and returns the application-level generation result.

## AI Provider Boundary

Provider metadata and adapter resolution are defined by the provider registry.

A provider definition identifies:

- provider identity
- supported models
- endpoint metadata
- credential requirements
- validation support

The adapter factory receives the authorized credential and provides the shared generation interface.

The provider boundary isolates provider-specific transport and response handling from the Google Forms workflow. Additional providers can implement the existing provider contract without changing the Google Forms processing model.

### Current Gemini Implementation

The registry currently contains Gemini as its implemented provider.

`GeminiProvider`:

- sends structured generation requests directly to the Google Gemini API
- uses the configured Gemini model endpoint
- authenticates with the `x-goog-api-key` request header
- requests JSON output
- validates returned data against the generation contract
- classifies authentication, quota, rate-limit, availability, and malformed-output failures

Credential validation calls the Gemini model information endpoint directly using the same `x-goog-api-key` header.

No AnswerSense API or backend proxy is involved.

## Configuration and Generation

The extension UI obtains provider configuration from the service worker.

The returned configuration contains provider, model, and redacted credential metadata. Credential secrets are not returned as UI state.

Credentials are added or replaced through a native browser `window.prompt`. The entered value is passed through the extension message path without being rendered into the Google Forms page DOM or overlay markup.

The UI saves the credential, selects the provider/model/credential, and validates the configuration before generation.

For generation:

1. The content script discovers and normalizes the active page.
2. The content script sends the logical generation request to the service worker.
3. The service worker resolves the configured provider adapter.
4. The provider generates the structured result.
5. The extension validates the result.
6. Supported controls are filled.
7. The user reviews the generated values before continuing or submitting the form.

The extension does not submit forms automatically.

Each operation carries a processing cycle identifier. Responses associated with obsolete cycles are rejected or ignored to prevent stale provider results from modifying current page state.

## Credential Ownership and Security

Credentials are owned by the extension service worker and extension storage boundary.

Persisted credential state uses:

- `chrome.storage.local` for encrypted configuration state
- AES-GCM for credential-state encryption
- a non-extractable AES-GCM Web Crypto `CryptoKey`
- IndexedDB for the encryption key

IndexedDB details:

```text
Database: answersense-credential-security
Object store: keys
```

Credential records exposed to UI state are redacted and do not contain the secret.

The service worker reads the credential secret when resolving an authorized provider request.

The encryption implementation uses a fresh initialization vector with each encrypted state envelope.

This protects persisted configuration state from plaintext storage. It does not provide the security properties of a server-side secret and does not protect against a compromised browser profile or compromised extension context with access to the encryption key.

Google Forms text, options, existing answers, settled context, and page identifiers are treated as untrusted input.

The extension operates on normalized logical data rather than transmitting raw page HTML or DOM references to the provider.

Generated answers are validated before filling and remain subject to user review.

## Runtime Boundaries

The production repository contains an Extension-only workspace.

The relevant structure is:

- root workspace: npm tooling and shared checks
- `Extension`: TypeScript Manifest V3 extension package
- content entry: `Extension/src/Content/Content.ts`
- service worker entry: `Extension/src/Background/ServiceWorker.ts`
- production UI: runtime-mounted Shadow DOM Overlay

Vite produces the extension artifacts under `Extension/dist`.

The generated content script and service worker are loaded by the extension manifest.

## Current Architectural Constraints

The current production architecture does not include:

- an AnswerSense backend workspace or server
- automatic form submission
- full-form upfront crawling
- automatic future-page discovery
- fuzzy, semantic, or heuristic question matching
- heuristic dependency detection
- automatic downstream regeneration
- automatic retries
- multi-provider routing or fallback
- persistent answer storage
- analytics
- a UI framework