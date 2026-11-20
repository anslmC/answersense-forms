# AnswerSense: Forms Architecture

## Scope

This document describes the current production architecture of AnswerSense: Forms.

The production implementation is an extension-only, direct BYOK design for Google Forms respondent-page workflows.

The provider registry currently supports Gemini and NVIDIA. The user selects one provider, model, and credential for a configuration.

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

AI Provider
  -> NvidiaProvider
  -> NVIDIA Integrate API
```

Provider requests are sent directly from the service worker to the configured provider API. There is no AnswerSense backend workspace or server in the current production architecture.

## Google Forms Integration

The content script provides the Google Forms integration layer. It:

- is injected on Google Forms routes and discovers supported respondent-page content
- shows a floating launcher only on top-level `/viewform` respondent pages
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

The floating launcher is a separate content-script host with its own open Shadow DOM root. It is fixed near the top-right of a respondent page and invokes the same overlay toggle used by the browser action. It is hidden while the overlay is open and restored when the overlay closes. The browser action uses a broader Google Forms URL check than launcher visibility; launcher visibility itself is restricted to top-level `/viewform` routes.

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

## Permissions

The Manifest V3 manifest declares these required host permissions:

- `https://docs.google.com/forms/*` for supported form workflows
- `https://generativelanguage.googleapis.com/*` for Gemini
- `https://integrate.api.nvidia.com/*` for NVIDIA

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

### Registered Providers and Models

The registry currently exposes these models:

- Gemini: `gemini-3.5-flash-lite` (Gemini 3.5 Flash-Lite) and `gemini-3.1-flash-lite` (Gemini 3.1 Flash-Lite)
- NVIDIA: `nvidia/nemotron-3.5-super-vl-120b-a12b` (Nemotron 3.5 Super VL 120B A12B) and `nvidia/nemotron-3.5-lightning-30b-a3b` (Nemotron 3.5 Lightning 30B A3B, served through NVIDIA's API)

The configured provider/model determines which adapter receives the authorized credential. There is no automatic provider routing or fallback.

`GeminiProvider`:

- sends structured generation requests directly to the Google Gemini API
- uses the selected Gemini model's `generateContent` endpoint
- authenticates with the `x-goog-api-key` request header
- requests JSON output
- validates returned data against the generation contract
- classifies authentication, quota, rate-limit, availability, and malformed-output failures

Gemini credential validation calls the model information endpoint for the selected Gemini model using the same header, so validation reflects the model that generation will actually use.

`NvidiaProvider` sends chat-completion requests directly to `https://integrate.api.nvidia.com/v1/chat/completions` and authenticates with an `Authorization: Bearer` API-key header. It validates the response against the shared generation contract and classifies provider and transport failures.

NVIDIA credential validation sends a fixed synthetic garden-tools question to the selected NVIDIA model as a completion probe. It does not use the user's form data; unlike Gemini validation, it is a generation-style API request that consumes provider tokens.

No AnswerSense API or backend proxy is involved.

## Provider Execution and Recovery

Both providers implement the shared generation interface and return a single `GenerationResponse` containing one result per requested question. Provider-specific batching, retries, splitting, and salvage happen inside that interface, so the rest of the extension still sees one generation result.

### Gemini Execution

Gemini starts with a single structured `generateContent` request for the candidate questions on the active page. The request asks for JSON matching the generation contract and includes settled page context when available.

Gemini responses are salvaged rather than accepted or discarded as a whole. A response may be direct JSON, fenced JSON, or JSON embedded in prose, and may be truncated. The salvage step verifies the generation cycle, rejects API-key echoes, and ignores unknown, duplicate, or individually invalid entries while keeping every valid result. Truncated responses can still contribute the results that completed before truncation.

### Gemini Recovery

Gemini recovery is bounded and question-group oriented:

- transient failures such as rate limits, timeouts, network failures, and provider unavailability are retried with exponential backoff and jitter, honoring provider retry guidance when supplied
- oversized or unsuccessful question groups are split in half and retried as smaller groups
- malformed, truncated, or incomplete responses trigger splitting because resending the same group is likely to fail the same way
- a shared-context overflow is terminal, while an individual-question payload overflow is narrowed by splitting; when the cause is ambiguous and shared context exists, a probe request without questions distinguishes the two
- recovery is limited by per-question-group execution attempts, split depth, concurrency, and an overall deadline

The limits keep latency and provider cost predictable and prevent unbounded retry loops. The deadline guarantees that generation eventually returns or fails instead of continuing indefinitely.

### NVIDIA Execution

NVIDIA plans batches before sending any request. Batch planning enforces a maximum question count, estimated input and output token budgets, and a serialized request-size limit. Each batch carries the settled page context plus explicit same-page question references needed by questions in that batch.

Planned batches are executed with bounded concurrency. NVIDIA's asynchronous jobs are handled by polling the provider status endpoint when a request is accepted for later completion. The provider also falls back to a request payload without a response-format field when the selected model rejects that field.

NVIDIA results are salvaged per batch in the same way as Gemini: direct, fenced, or embedded JSON is accepted, and individually valid results are preserved even when the surrounding response is incomplete or partly invalid.

### NVIDIA Recovery

NVIDIA recovery operates per batch:

- rate-limit, timeout, network, and provider-unavailability failures are retried with backoff and retry guidance
- malformed, truncated, or incomplete responses are split into smaller batches instead of being resent unchanged
- repeated timeouts cause a batch to be split, and rate limits or repeated transient failures reduce execution concurrency
- recovery is limited by per-batch attempts, split depth, concurrency, and an overall deadline sized from the bounded worst-case workload

The overall deadline is calculated from the planned batches and their recovery allowance. Results that finish just before the deadline are kept, and the remaining questions are finalized as failures.

### Partial Results

Successful generation is never discarded because another question failed. Both providers keep completed `GENERATED` and `ABSTAINED` results and continue recovery only for the questions that are still unresolved.

A question that exhausts its recovery budget, encounters a non-recoverable failure, or is still unresolved at the deadline receives an explicit `GENERATION_FAILED` result with a failure code and message. Unresolved questions are not silently dropped. If no usable result was produced at all, the provider returns a provider error instead of a partial response.

## Shared Generation Pipeline

Provider results return to the shared pipeline as an ordinary generation response. The pipeline validates the response against the active page before any answer is used:

1. the cycle identifier must match the current processing cycle
2. every supported candidate question must have exactly one result
3. generated answers must match the question type, available options, and answer-part requirements

Provider recovery does not replace this shared validation. `GENERATION_FAILED` results remain failed, `ABSTAINED` results remain abstained, and generated answers that do not satisfy the question contract become validation failures. The resulting generation report is `complete` only when every supported result was generated; otherwise it is `partial`.

Only successfully generated answers enter pending fill state, and that state is committed only after a confirmed page transition. Failed and abstained questions remain represented in the shared review and fill state, so provider-level recovery never bypasses user review.

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
- automatic dependency inference beyond explicit question references
- automatic downstream regeneration
- unbounded provider retries; provider recovery is bounded by attempt, split, concurrency, and deadline limits
- automatic provider routing or fallback; provider selection is user-configured
- persistent answer storage
- analytics
- a UI framework
