# AnswerSense: Forms

An AI-assisted Chromium browser extension for supported Google Forms.

## Development Status

**Current phase:** Direct-BYOK runtime verification and follow-up remediation

The direct-BYOK runtime is implemented and the canonical architecture reference is available at [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

The production processing flow is implemented incrementally under the canonical architecture.

## Current Architecture Baseline

- Process only the currently active Google Forms page.
- Do not crawl the full form upfront or automatically navigate ahead.
- Process one page at a time.
- Send one batched generation request per active page.
- Include all prior settled question/answer context in later requests.
- Omit unanswered optional or skipped questions from accumulated context.
- Treat the current user-edited value as authoritative once a page settles.
- A page settles only after Next is accepted and an actual page transition is observed.
- Keep required-field validation under Google Forms control.
- Recognize and re-check previously settled pages when revisited.
- Reprocess changed pages and reuse unchanged state where appropriate.
- Do not automatically regenerate downstream settled pages after upstream changes.
- Use deterministic answer-to-question matching.
- Do not use fuzzy, semantic, or heuristic dependency matching.
- Keep logical form state separate from DOM state.
- Prevent stale generation responses from modifying current processing state.

## Architecture & Technology

- **Extension:** TypeScript, Manifest V3, Vite, Chromium/Edge/Brave
- **Backend:** Node.js, TypeScript, Zod
- **Testing:** Vitest
- **Tooling:** ESLint, Prettier, npm workspaces

## Developer/Local Backend Configuration

The Backend package is developer/local infrastructure for mock generation, local API/provider testing, provider validation, and deliberate smoke tests. It is not part of the end-user BYOK generation path. Copy `Backend/.env.example` to a backend-only environment file or export these variables in the shell running the backend:

- `GEMINI_API_KEY` - Gemini API key; never commit or expose it.
- `GEMINI_MODEL` - backend-selected Gemini model identifier.
- `GEMINI_TIMEOUT_MS` - positive request timeout in milliseconds.

The repository ignores local `.env` files. These backend credentials remain local development credentials and are never used as an end-user fallback.

The deliberate real-API smoke test is separate from normal tests. After configuring the backend environment, run `npm run smoke --workspace Backend`; this is not part of `npm test`, CI, or the normal integration path.

The repository currently provides the implementation foundation. Feature and processing logic will be added incrementally while following the canonical architecture.

## TnS Runtime Modes

End-user generation uses this direct BYOK path:

```text
Content Script -> Service Worker -> Gemini Provider -> Gemini API
```

The user configures a Gemini API key in the extension. The key is stored in local extension storage, and only the service worker reads it for provider requests. The key is never sent to the AnswerSense backend, page content, or content scripts. Local `.env` values are development-only and are not a fallback for a missing end-user credential.

The Backend package remains available for local development, mock generation, API testing, provider validation, and deliberate smoke tests. It is not required for the end-user BYOK workflow.

## Product Identity

The official product identity is **AnswerSense: Forms**. Licensing controls software permissions; it does not grant permission to represent a modified build as an official AnswerSense release. Official releases are published through the project owner's designated repository and release channels. Unofficial forks and modified builds should clearly identify themselves as unofficial, for example, “unofficial fork of AnswerSense”. This notice does not technically prevent copying, forking, or rebranding.

## Untrusted Form Content

Google Forms question text, option labels, existing answers, settled context, and page identifiers are untrusted data. The extension sends normalized generation data rather than raw HTML or DOM references. Prompt-injection detection is not complete and is not the credential-security boundary; generated answers remain subject to validation, user review, and manual submission.

## License

This repository is offered under the PolyForm Shield License 1.0.0. See [LICENSE](LICENSE) for the license text. The root workspace, Backend, and Extension packages use the same license declaration. The license and the AnswerSense product identity are separate concerns.
