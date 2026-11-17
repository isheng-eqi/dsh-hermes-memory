# Storage protection and maintenance

This guide addresses [issue #16](https://github.com/isheng-eqi/dsh-hermes-memory/issues/16). All paths below refer to the selected storage directory, which may differ from the Web profile's usual `~/.dsh/storages`.

## Distinguish the two concurrency boundaries

**Default `host-json` can silently lose updates when independent writers share the same files.** For example, two DSH service/profile processes on one machine, or two independent backend instances, can load the same directory into separate caches. If one adds a fact and the other later saves its older cached snapshot, the later write can erase the first update: last writer wins. A manual disk edit can likewise be overwritten by a later cached write. Separate profiles are a concern only when configured to share the same files.

Within **one plugin instance**, panel, model, and background-review writes already share the same `enqueue` queue. The panel calls that instance's HTTP routes rather than writing JSON independently. Panel `replace` / `remove` already require the complete original `oldText`, rejecting an ordinary stale A-to-B edit. The row-version protocol below addresses an additional stale-form case; the native storage lease addresses independent file writers.

The registered DSH JSON backend's open-handle registry prevents duplicate units **in that backend instance**, not across processes or backend instances. Its `loadAll()` reads a cached snapshot. The pinned host's JSON atomic writer has a single rename attempt. Calling `loadAll()` again or retrying an entire failed `setGlobal()` does not add cross-process protection or external-change detection.

## Protect panel edits with row versions

`POST /hermes-memory/ops` with `{"action":"list"}` keeps the existing `memory` and `user` string arrays and adds aligned `entryVersions` arrays. Capture the token at the same index as the entry being edited or deleted. These synthetic JSON examples show the relevant response fields and a subsequent request; use the actual text and opaque token from your authenticated list response:

```json
{
  "memory": ["A synthetic fact."],
  "user": [],
  "entryVersions": {
    "memory": ["opaque-row-version"],
    "user": []
  }
}
```

```json
{
  "action": "replace",
  "bank": "memory",
  "oldText": "A synthetic fact.",
  "content": "An updated synthetic fact.",
  "expectedVersion": "opaque-row-version"
}
```

For deletion, send `action: "remove"` with the same `bank`, complete `oldText`, and captured `expectedVersion`; omit `content`. The updated official panel captures these values when the edit or deletion starts. The queued commit requires exactly one full-text match and its matching row version. A changed, missing, ambiguous, or outdated row returns HTTP **409 Conflict**; the panel retains the draft or delete confirmation rather than silently applying it to a different version. Refresh to inspect the current entry, then deliberately start a new edit or deletion rather than replacing a retained draft's token automatically.

This detects ABA cases: an entry changes from A to B and back to A, or is deleted and recreated with the same text. Reloading the plugin also invalidates old tokens. Editing a different row does not invalidate the token for an unchanged row. Tokens are opaque, scoped to the current plugin instance, and held in memory; this adds no persisted storage format.

Older HTTP callers that omit `expectedVersion` retain the full-text check and do **not** gain ABA protection. The protocol covers the updated official panel's `replace` / `remove` path, not agent tools or pending approvals. Approval separately checks the current full text and sequence identity, which can still match after a same-identity A-to-B-to-A change. `patch` / `batch` are outside the row-version protocol and return HTTP 400 if supplied with `expectedVersion`. A row token does not detect another process overwriting the underlying JSON files; use the storage protection below for that boundary.

## Native guarded mode

For a native static installation, set `storageRoot` on the existing `hermes-memory` plugin entry to an **absolute directory**:

```yaml
storageRoot: 'C:\Users\your-user\.dsh\storages'
```

Replace that example with your actual configured storage directory; `~` and relative paths are not accepted. On Linux, for example, use `/home/your-user/.dsh/storages`. Stop all DSH processes and other writers first, back up both memory files, then enable the setting and restart. Do not move/delete the original files during a live session.

This selects a plugin-owned backend for **only** `hermes_memory.json` and `hermes_memory_runtime.json`, preserving their DSH JSON unit format, v1 tables, and v2 snapshots. The plugin does not keep native KvUnit handles open for those files at the same time. Other plugins continue using the host storage service. A missing directory is created; choose the path carefully because selecting an empty directory creates a separate empty store rather than discovering an existing one.

The dynamic sandbox cannot import the native filesystem backend. Use the static bundle for guarded mode. `memory_debug`, `memory_stats`, and the stats API report `storageSafety.mode` so callers can distinguish `guarded-native` from `host-json`.

### Writer lease

A `.hermes-memory.lock` sidecar is created exclusively and covers both files. It records a token, PID, host name, and creation time; a heartbeat updates its timestamp. A second cooperating backend fails with a visible `writer-active` error, including when it runs in another process. Main-unit ownership is required before any runtime access or interrupted-work recovery, including in the default host mode.

A heartbeat is diagnostic, not permission to take over. Suspended processes, reused PIDs, and network filesystems make time-based theft unsafe. The backend never automatically deletes or steals an existing lock. After a crash, stop and verify **all** writers on the recorded host, back up the two files and sidecar, then remove only that verified stale sidecar and reopen. An old owner whose lease was removed/replaced fails its next publication; normal close only removes a lock with its own token.

### External edits and Windows publication

The guarded backend remembers both files' fingerprints at acquisition and checks them before publication, including just before each rename attempt. Creating an initially absent file, deletion, content changes, and unsupported symlinks fail visibly rather than becoming an empty view. A conflict poisons that backend instance until close/reopen; inspect and reconcile both files first.

It writes a same-directory exclusive temporary file, syncs its content, then atomically renames it over the destination. On Windows only, `EPERM`, `EBUSY`, and `EACCES` during **rename** receive bounded backoff. Other failures are not retried. It never unlinks the destination, never replays a whole memory operation, and does not claim success after an uncertain post-publication failure. POSIX publication also syncs the parent directory.

This is a cooperative single-writer protocol on a local filesystem. Older plugins, the host JSON backend, hand editors, and unrelated programs do not honor the sidecar. Do not mix them with a guarded writer on the same files. Fingerprint checks detect changes observed before replacement; they cannot eliminate the final check-to-rename race with a noncooperating editor or promise reliable locking on every network filesystem. No mode merges simultaneous edits automatically.

## Online maintenance

In the authenticated Memory panel (`记忆`), **导出备份** (Export backup) downloads one JSON export. **压缩历史详情** (Compact history details) asks for an explicit confirmation, then compacts eligible details older than 30 days, keeping the newest 100 detailed resolved records per collection. Neither capability is registered as a model tool.

The owner-authenticated routes are:

- `GET /hermes-memory/export`: current entries, complete bookkeeping snapshots, and a derived `v1Document`; attachment response, `Cache-Control: no-store`.
- `POST /hermes-memory/compact`: JSON `{ "before": "2026-01-01T00:00:00.000Z", "maxDetailed": 100 }`. The cutoff is explicit; `maxDetailed` is an integer from 0 through 10000 and defaults to 100.

Compaction replaces eligible resolved payloads with their status, identity, timestamps, and canonical-payload SHA-256. Proposal pin sequences remain reserved even after full pin text is removed. Review session IDs and highest claimed turns remain. Pending, applying, and interrupted approvals retain complete operations and pins; running reviews and records without a valid finish time retain their details. Approval cannot reapply a compacted terminal proposal. Newer records and the newest detailed history allowance also remain untouched.

Compaction is not a hard byte or record-count cap. Distinct session replay markers, resolved proposal identities, unresolved work, and recent details can continue to grow. A fixed total cap would require expiring replay guarantees; this implementation does not do that. There is no automatic compaction. Export first if full older history matters; hashes do not reconstruct removed text. Export includes disabled banks for the owner and should be treated as private memory data.

## Offline maintenance and downgrade

The maintenance script is included in the installed package. Run it from that package directory or a source checkout. Stop **all** DSH writers first, including older host-JSON instances that cannot see the lease. Output paths must be new: the command uses exclusive creation and never installs output into a live store.

Export both loaded snapshots and the current entries:

```powershell
node scripts/memory-maintenance.mjs export --root 'C:\Users\your-user\.dsh\storages' --out '.\memory-backup.json'
```

Create a new full backup before compacting old resolved details:

```powershell
node scripts/memory-maintenance.mjs compact --root 'C:\Users\your-user\.dsh\storages' --out '.\before-compaction.json' --before '2026-01-01T00:00:00.000Z' --keep 100
```

The CLI takes the same guarded lease and verifies both files. If backup creation or validation fails, compaction does not run. It does not treat a stale lock as permission to write.

The export format separates:

| Field | Contents |
| --- | --- |
| `entries` | Current `memory` and `user` text in stored order, including disabled banks |
| `bookkeeping` | Full `memorySnapshot` and `runtimeSnapshot`, including legacy tables, v2 data, claims, and proposal evidence |
| `v1Document` | A DSH unit named `hermes_memory`, stamped version 1, with `global: null` and **current** records in its two tables |

For a downgrade, retain the full backup, create a separate empty directory, then extract the v1 document there:

```powershell
New-Item -ItemType Directory '.\v1-recovery'
node scripts/memory-maintenance.mjs extract-v1 --root '.\memory-backup.json' --out '.\v1-recovery\hermes_memory.json'
```

Point the older installation at that separate directory only after verifying its supported version and settings. Do not copy `hermes_memory_runtime.json` into the older installation. The old plugin does not understand v2 proposals or review claims; they remain in the full backup and are not converted into v1 actions. The extraction command requires a separate empty output directory, takes its writer lease, and rebuilds the document from the exported authoritative snapshots rather than blindly trusting an edited derived slot. It never changes running configuration, reinstalls v1, or overwrites the live v2 files.

The original top-level v1 tables in a v2 file are an **upgrade-time** recovery copy; they are not kept current by v2 writes. Use export/extraction when current entries are required. An export is a logical snapshot, not a forensic byte-for-byte archive: retain original files together for uncertain-state recovery.

## Verification scope

On November 15, 2026, the same pinned-host release runner passed **234/234 tests with zero failures or skips** on Windows / Node 24.22.2. The added cases cover queued panel/model conflicts, versioned panel ABA and reload rejection, preservation of draft/delete tokens across refreshes, malformed-token rejection, unrelated-row stability, and explicit review-model selection without fallback. This run uses synthetic memory contents and an isolated model adapter; it does not certify a particular paid model's curation quality.

On November 14, 2026, the strict release runner passed **225/225 tests with zero skips** on Windows / Node 24.22.2 against the clean built DSH checkout `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`. This includes 17 guarded-storage tests and real-host static/dynamic session and persistence integration. Windows sharing failures are injected at the rename boundary; this is not an antivirus-vendor compatibility certification.

Regression tests exercise shared main/runtime ownership in static and dynamic modes, durable sequence identities across delete/reopen, compaction replay protection, owner-only routes, and current-state v1 export. Guarded-backend tests use temporary directories, separate processes, injected Windows rename errors, and external changes to either file. They never acquire a lease on actual user storage. The fixed-host suite also verifies interoperability with DSH's real JSON format.
