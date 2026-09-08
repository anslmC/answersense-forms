# AnswerSense: Forms Architecture

## Scope

This is the canonical architecture reference for AnswerSense: Forms.

It reflects the latest locked decisions and defines the system behavior, data boundaries, and processing flow that implementation must follow.

---

## Core Constraints

* Google Forms only.
* Process only the currently active page.
* Do not crawl the full form upfront.
* Do not automatically navigate ahead.
* Process one page at a time.
* Batch the current page into one generation request.
* Carry all prior settled Q&A into later generation requests.
* Omit unanswered optional/skipped questions from context.
* User-edited values are authoritative once settled.
* A page settles only after **Next + successful page transition is observed**.
* Google Forms controls required-field validation.
* Revisited pages are recognized and re-checked.
* Changed pages are reprocessed; unchanged pages may reuse existing state.
* Do not automatically regenerate downstream settled pages after upstream changes.
* Do not use heuristic dependency detection.
* Multi-provider routing/fallback remains deferred.

---

## General Processing Flow

The system follows this lifecycle:

**Discover → Normalize → Generate → Validate → Fill → Review → Settle → Accumulate Context → Continue**

### 1. Discover

Identify the supported Google Form and inspect only the currently active page.

Extract:

* questions
* question types
* options
* required state
* existing inputs
* page identity/state information

Do not inspect future pages.

### 2. Normalize

Convert discovered DOM information into the normalized logical model.

The logical model must not contain raw DOM references.

Core concepts include:

* `Form`
* `Question`
* `Answer`
* `ExistingInput`
* `QuestionResult`
* `ProcessingCycle`
* `GenerationReport`

DOM nodes and page-specific mappings remain in the DOM layer.

### 3. Generate

Send the current page as one batched generation request.

The request contains:

* current page questions
* all prior settled Q&A

Context is logical only:

* question text
* settled answer

Do not send raw HTML, DOM references, or unnecessary browser state.

Unanswered optional/skipped questions are omitted.

### 4. Validate

Validate the generation response against the expected structured contract.

Answer-to-question matching is deterministic.

Do not use:

* fuzzy matching
* semantic matching
* heuristic question matching

Generation results are represented by a materialized, frozen `GenerationReport`.

### 5. Fill

Resolve normalized questions to their current DOM inputs and apply valid answers.

The normalized model remains independent of the DOM.

Existing user answers may be preserved according to the processing rules.

### 6. Review

The user reviews and may edit generated answers.

The extension does not submit the form automatically.

The current value in the form becomes authoritative when the page settles, regardless of whether it originated from AI or the user.

### 7. Settle

Generation or filling success does not settle a page.

Settlement requires:

1. User clicks Next.
2. Google Forms accepts the page.
3. An actual page transition is observed.

Until then:

* the page remains editable
* its answers are not added to accumulated context

Required-field validation remains entirely controlled by Google Forms.

### 8. Accumulate Context

After successful settlement, the page's settled Q&A becomes part of the logical form context.

Later pages receive all accumulated settled context.

Context is read-only input to later generation and does not modify earlier settled results.

### 9. Continue / Revisit

After settlement, the next active page is discovered and processed.

If the user navigates back to a previously settled page:

* recognize it as the same page/state
* re-check/re-extract it
* reuse existing state if unchanged
* reprocess if changed

Changes to an earlier settled page do not automatically regenerate downstream settled pages.

---

## Processing Cycle & Stale Responses

Each processing operation belongs to a `ProcessingCycle` identified by a `cycleId`.

A response belonging to an obsolete cycle must be rejected or ignored so stale generation results cannot modify current state.

---

## Implementation Boundaries

### Extension Layer

Responsible for:

* extension runtime
* Google Forms detection
* page discovery
* DOM extraction
* DOM resolution/filling
* page/form interaction lifecycle
* generation coordination
* response validation
* user interaction and review flow
* requesting provider work through the service worker
* never receiving the raw provider credential

### Service Worker Layer

Responsible for:

* provider credential access
* provider transport
* selecting and using the configured provider adapter
* sending provider requests directly to Gemini
* never exposing the raw credential through runtime messages

### Provider Adapter Layer

Responsible for:

* Gemini-specific API interaction
* normalizing provider behavior into the established provider interface
* validating provider response structure before returning it
* preserving the application-level `GenerationResponse` contract

### Backend Layer

Responsible for:

* developer/local `.env` configuration
* local API/provider testing
* request and response validation for backend tests
* mock generation and deliberate smoke tests

The backend is not part of the end-user BYOK runtime generation path.

### Shared Logical Layer

Responsible for:

* normalized models
* logical page/context state
* processing-cycle coordination
* extension/backend data contracts

---

## Architectural Boundary

Keep these concerns separate:

**DOM state**
→ discovery, extraction, resolution, filling

**Logical state**
→ questions, answers, settled context, processing state

**Generation**
→ structured request/response

**User state**
→ review, edits, and manual submission

The logical model must remain independent of browser DOM objects.

---

## Non-Goals

The current architecture does not include:

* full-form upfront crawling
* automatic future-page discovery
* automatic submission
* fuzzy/semantic matching
* heuristic dependency detection
* automatic downstream regeneration
* automatic retries
* multi-provider fallback/routing
* persistent answer storage
* analytics
* UI frameworks
