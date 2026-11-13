# Changelog

## Unreleased

- Archive the obsolete lifecycle design, distinguish static and dynamic message sources, and document resource and runtime-metadata retention limits. Thanks to [Magnus Hedemark (@magnus919)](https://github.com/magnus919) for PRs #8–#10 and #12–#14.
- Add offline quality scoring, synthetic resource characterization, and pinned-host release CI. Harden the release runner against inherited Node test filters/shards; normalize mirror generation across LF/CRLF checkouts. Require successful review outcomes and complete disposal in resource reports, and count replayed user evidence across all phases.
- Add ten offline Hermes compatibility scenarios with fixed upstream sources and explicit DSH storage/response differences, following Eric's suggestion. These tests cover a selected reviewed subset and do not detect newer upstream changes.

- Require an exact full-entry match for panel edits and deletes, so stale rows cannot modify another entry through substring matching. Thanks to [Teo (@teo-nex)](https://github.com/teo-nex) for [PR #3](https://github.com/isheng-eqi/dsh-hermes-memory/pull/3) and four static/dynamic regression cases.
- Keep the active edit draft until save or cancel, including after list reordering or removal of its original entry. Show save errors next to the editor and require an inline full-text confirmation before deletion.
- Add five panel regression tests covering draft protection, save retry errors, refreshed or missing entries, and delete confirmation/failure behavior.
- Add a complete English README and reciprocal language links, include it in the published package, and clarify the additional background model requests and default limits in both introductions.

## 2.0.0 — 2026-11-11

Built-in memory behavior is pinned to Hermes `c0c4357744d1a6994d332b826aea4c77fcccaf38` and adapted to current DSH v4 session persistence.

- Add periodic background model review after successful responses, every 10 genuine user turns by default. Inherit the actual parent request route, isolate review tools, cap requests at 16, cancel and drain on unload, and persist trigger outcomes to avoid duplicate runs after reload.
- Require an explicit enabled target and expose `operations` with add, unique-span patch and remove. Preserve internal panel editing compatibility, typography-aware entry location, Unicode budgets, final-budget atomic batches and nonempty consolidation protection.
- Add independent bank switches and durable proposals. Background changes to existing entries require review; approval pins full entries and identities, rejects stale proposals, and never replays an uncertain application automatically. Model-visible pending lists exclude disabled banks after reload; authenticated owner management retains them.
- Replace removed `session.events` reads with async registered projections. Preserve request-series decisions and producer-owned message sources accepted by the real v4 encoder.
- Quarantine any rejected durable publication until reopen. Preserve current v2 memory data and retain v1 recovery records. Runtime metadata uses a separate storage unit.
- Generate the dynamic Host mirror from the same source modules. Dynamic sandboxes explicitly report background review unavailable because this DSH version provides no native request cancellation controller.
- Show background status and pending proposals in the existing authenticated memory panel. Add exported English/Chinese metadata and an original icon.
- Add real JSONL and Zstandard write/close/reopen tests, real JSON storage, real current Session/projections and a real LLM service with an isolated test adapter. Cover the complete tenth-user-turn review, durable write, reopen and fresh-session injection path.

Background review adds model requests. Existing memory is preserved; the model-facing memory schema and default automatic behavior change in this major version. See the README for DSH platform boundaries and recovery procedures.

## 1.2.0 — 2026-11-09

Validated against DSH 0.2.2-alpha.2 (`ce7073d512`) and compared with Hermes upstream `0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41`.

### Changed

- Serialize whole read/validate/commit transactions and persist each batch through a single v2 global snapshot. Both banks survive close/reopen. Existing v1 table records remain an upgrade recovery copy.
- Add unique-span `patch`; retain whole-entry `replace` for compatibility. Count Unicode code points consistently in budgets and usage, including emoji.
- Freeze initially empty banks and await cold storage initialization before injecting a session snapshot. Count consolidation failures across model steps, including empty batches; failed calls no longer suppress persistence nudges.
- Apply bounded, local memory-content checks inspired by Hermes. Block new matching content and withhold matching legacy entries from prompt snapshots without deleting their original text. Preserve normal joined emoji and natural-language joiners.
- Require the DSH owner authentication and Host/Origin trust fence on memory HTTP routes. Reject unsupported methods, malformed operations and bodies exceeding 64 KiB of UTF-8 data.

### Fixed

- Preserve the existing `slots.inject()` declaration gate; explicitly inject the slots service. Reclaim styles and registrations on unload.
- Show initial loading and retryable HTTP/business/schema errors instead of reporting empty banks. Keep drafts, editing state and last successful data on failures, ignore obsolete requests, and prevent Enter/click duplicate writes.
- Wait for pending writes before storage disposal and refuse to close another plugin's handle. Reject malformed or duplicate sequence identities; refuse unsafe sequence allocation. Quarantine unknown durable outcomes until reload.
- Avoid superlinear whitespace backtracking in content checks.

### Verification and migration

- `npm test` now runs all 85 tests. Two real-DSH checks additionally require `DSH_CLIENT_TEST_CHECKOUT`; all 85 passed with that variable set during this release.
- Authenticated original-URL browser verification covered the sidebar/panel, existing-bank reads, synthetic write/read failures, retained draft and retained last successful list.
- **Back up the memory JSON before upgrading.** First actual change writes v2. Downgrading requires restoring the old backup; earlier plugin versions do not read subsequent v2 updates.
- Added upstream MIT attribution and detailed comparison/validation notes.
