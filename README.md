# AnswerSense: Forms

An AI-assisted Chromium browser extension for supported Google Forms.

## Development Status

**Current phase:** Architecture alignment and implementation readiness

The repository is prepared for implementation. The canonical architecture reference is available at [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

The production processing logic is not yet implemented.

## Current Architecture Baseline

* Process only the currently active Google Forms page.
* Do not crawl the full form upfront or automatically navigate ahead.
* Process one page at a time.
* Send one batched generation request per active page.
* Include all prior settled question/answer context in later requests.
* Omit unanswered optional or skipped questions from accumulated context.
* Treat the current user-edited value as authoritative once a page settles.
* A page settles only after Next is accepted and an actual page transition is observed.
* Keep required-field validation under Google Forms control.
* Recognize and re-check previously settled pages when revisited.
* Reprocess changed pages and reuse unchanged state where appropriate.
* Do not automatically regenerate downstream settled pages after upstream changes.
* Use deterministic answer-to-question matching.
* Do not use fuzzy, semantic, or heuristic dependency matching.
* Keep logical form state separate from DOM state.
* Prevent stale generation responses from modifying current processing state.

## Architecture & Technology

* **Extension:** TypeScript, Manifest V3, Vite, Chromium/Edge/Brave
* **Backend:** Node.js, TypeScript, Zod
* **Testing:** Vitest, Playwright
* **Tooling:** ESLint, Prettier, npm workspaces

The repository currently provides the implementation foundation. Feature and processing logic will be added incrementally while following the canonical architecture.