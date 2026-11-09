# Changelog

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
