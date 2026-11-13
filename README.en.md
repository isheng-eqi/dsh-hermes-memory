# dsh-hermes-memory

[简体中文](README.md)

An adaptation of [Hermes built-in memory](https://github.com/NousResearch/hermes-agent/tree/c0c4357744d1a6994d332b826aea4c77fcccaf38) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with two bounded memory banks, frozen session snapshots, atomic curation, and periodic background review.

**Model usage: the v2 static bundle enables an independent background review by default after a qualifying response at each multiple of 10 genuine user turns. Each review uses the current turn's model unless overridden, with at most 16 model requests and a default time budget of 120 seconds.** These additional background calls consume model quota. A review may save grounded, durable facts or decide that nothing is worth saving; the number of entries need not grow over time. Background changes to existing entries and deletions become pending proposals that the owner can approve or discard in the Memory panel.

The implementation is based on Hermes commit `c0c4357744d1a6994d332b826aea4c77fcccaf38` (2026-11-11). The primary installation is the **static bundle**. The dynamic sandbox has no native request cancellation controller, so the dynamic deployment provides memory tools, snapshots, and statistics while explicitly reporting background review as `unavailable`. Calling a memory tool in either deployment does not itself issue an additional review model request. The plugin uses DSH storage and lifecycle services; platform differences are documented below.

## Install and use

Install or enable the bundle in the DSH plugin manager, refresh the existing DSH page, and click **Memory** at the bottom of the sidebar. A source installation uses the package directory. For the published package:

```sh
dsh plugin --profile web add dsh-hermes-memory
```

The plugin requires `tools`, `timer`, `sessionProjections`, and a JSON storage backend. The Web profile already includes the storage components; do not declare duplicate storage rows. If storage is unavailable, the plugin returns an error instead of replacing existing data with an empty store.

The implementation verification record covers DSH `0.2.2-alpha.2`, Node `24.22.2`, and the current v4 session format. The package's peer dependency ranges do not guarantee runtime compatibility with every matching version.

### Observe automatic memory

1. State a durable fact during a normal conversation, such as “Use Chinese for all future conversations.” A one-off task requirement does not automatically become a lasting preference.
2. The main model can save memory at any time. By default, background review also runs when the genuine user-turn count reaches a multiple of 10 and that turn completes normally. Tool calls and automatic continuation messages do not advance the user-turn count.
3. Refresh the Memory panel to inspect background status, both banks, and pending changes. Background additions can be saved directly; changes to existing entries and deletions require approval.
4. The current session retains the frozen snapshot captured on its first read. New sessions receive updated memory. Use `memory_list` to read the current store during an existing session.

A turn counts at most one genuine user message. A review also requires a genuine user message in the triggering turn, successful turn completion, and a nonempty final text response without tool calls. Cancelled or failed turns, empty responses, and responses with unfinished tool calls do not trigger review; any genuine user message already received in those turns still counts toward the interval. Ordinary subagents do not trigger automatic review. Only one review runs per session at a time; later triggers encountered while it is running are skipped rather than queued for replay.

The review receives only `memory` and `memory_list`. It has no file, network, command execution, or proposal approval tools. A model response without tool calls ends the review, including a decision that nothing is worth saving. The review also stops at the request limit, deadline, model error, or cancellation. Tool calls in a response that hits the output token limit are not executed. Unloading the plugin cancels requests and waits for writes that have already started to settle.

### The two memory banks

| Target | Purpose | Default capacity |
| --- | --- | --- |
| `user` | User identity, lasting preferences, communication style, and explicit standing expectations | 1375 characters |
| `memory` | Environment facts, tool conventions, paths, and stable configuration that apply across tasks | 2200 characters |

Each fact belongs in one bank. Transient progress, completion logs, and TODOs belong in session history. Procedures, techniques, and task-specific preferences belong in skills. This plugin does not automatically modify skill files.

Budgets count Unicode code points, including the `\n§\n` separator between entries; a single `😀` counts as one character. Exceeding the limit does not silently truncate existing entries.

## Call the tools

The model-facing `memory` interface has two required top-level fields: `target` and `operations`. Each call writes one bank. The entire batch and its final character budget are validated before a single durable commit.

```json
{"target":"user","operations":[{"action":"add","content":"The user prefers Chinese for conversations."}]}
```

```json
{"target":"memory","operations":[{"action":"patch","old_text":"Node 24","content":"Node 26"}]}
```

```json
{"target":"memory","operations":[{"action":"remove","old_text":"The complete obsolete entry"},{"action":"add","content":"An updated, stable environment fact."}]}
```

- `add` creates an entry and deduplicates identical text. Leading and trailing whitespace is trimmed.
- `patch` replaces one unique, exact `old_text` span while preserving other facts and whitespace in the same entry. To replace an entire entry, use its complete old text as `old_text`.
- `remove` locates and deletes an entire entry. Exact full-entry matches take precedence, followed by unique substring matches. Entry lookup tolerates common differences in quotes, dashes, and whitespace, but a `patch` replacement still requires an exact, unique stored span.
- A consolidation batch cannot empty a previously nonempty bank. One explicit `remove` may delete the final entry. Removal operations can progressively repair a bank that is already over budget.
- Legacy top-level `action`, `oldText`, and `new_text` inputs remain supported by an internal compatibility layer. The model interface no longer exposes `replace`; the panel retains whole-entry editing.

`memory_list` reads the current banks. `memory_search` performs deterministic keyword matching within the two banks; it **does not search chat history**. `memory_stats` reports capacity, enabled banks, and the pending proposal count. `memory_debug` exposes storage and background diagnostics.

When a write fails, the tool returns an error and, where applicable, the current entries and usage so the model can correct the batch. The first three consolidation failures return the original error; from the fourth failure onward, the result includes `done: true` and an instruction to stop retrying. Main-model failure counts are per session and reset each turn; background review uses a separate count for that review. This instruction does not forcibly reject subsequent tool calls. The background loop remains bounded by its 16-request cap and deadline. A successful commit clears the failure count and explicitly instructs the model not to repeat the saved update. DSH controls any further main-model requests after a tool result.

`memory_pending` only allows the model to list proposals. Approval and discard require the authenticated owner to act in the Memory panel. The model cannot approve its own changes, and the background review has no approval tool. Approval revalidates the complete matched entry and its identity; a stale proposal cannot overwrite an entry that changed after the proposal was created.

## Configure background review

Edit the `hermes-memory` entry through the DSH configuration UI or configuration editing service. Common settings:

```yaml
memoryCharLimit: 2200
userCharLimit: 1375
memoryEnabled: true
userEnabled: true
nudgeInterval: 10
contentGuard: true
writeApproval: false
backgroundReview:
  enabled: true
  maxIterations: 16
  timeoutMs: 120000
```

| Field | Behavior |
| --- | --- |
| `memoryEnabled` / `userEnabled` | Disable model reads, snapshots, and writes for the corresponding bank while retaining its stored data for administration |
| `nudgeInterval` | Legacy name for the background review interval in user turns; default 10. `0` disables periodic triggers unless a separate interval overrides it |
| `backgroundReview.interval` | Overrides `nudgeInterval`; `0` disables periodic triggers |
| `backgroundReview.enabled` | Default `true`; `false` disables automatic review while leaving main-model memory writes available |
| `backgroundReview.provider` / `model` | Set both to select a separate review model; omit both to inherit the actual model and parameters of the triggering turn |
| `backgroundReview.maxIterations` | Default 16, clamped to 1–16; maximum model requests per review, not a tool-call limit |
| `backgroundReview.timeoutMs` | Total background model-loop budget in milliseconds; default 120000 (120 seconds). Cancellation still waits for writes that have already started to settle |
| `writeApproval` | When `true`, main-model writes also become pending proposals. Direct owner edits in the panel can still be saved |
| `contentGuard` | Applies a bounded local scan to new content. Existing entries that match the guard are withheld from the injected prompt |

When a different provider or model is selected, the previous model's reasoning effort and output token limit are not imposed on it; the target adapter's defaults apply. The 16-request limit bounds the plugin's model loop. Internal network retries in the host or model adapter are controlled by their own settings and are not counted by this loop. Each review sends the conversation text captured at the trigger and the currently enabled memory banks. Token usage and cost depend on context length, model, and the actual number of requests.

A background error does not fail normal chat. Failure status remains visible. The same claimed trigger is not automatically replayed after reload; a later interval can try again. A successful earlier write is not rolled back if a later review request fails.

### Resource boundaries for extension authors

“Bounded memory” describes the two curated banks, not a bound on total process memory, disk usage, tokens, or cost. Keep these separate when integrating the plugin:

| Resource | Plugin boundary | Outside that boundary |
| --- | --- | --- |
| Curated bank content | Default `memoryCharLimit: 2200` and `userCharLimit: 1375`, measured in Unicode code points including entry separators; final batches are validated before commit | Prompt framing, tool schemas, conversation evidence, and runtime metadata are not charged to these budgets. Lowering a limit does not automatically truncate existing data; removal-only repairs remain possible |
| Review input | The scheduler captures text from all derived user, assistant, and tool messages available at the trigger; it does not impose an input-size cap or truncate that evidence | `runReview` has an optional reject-only `maxInputChars` argument, but the automatic scheduler does **not** supply it and it is not a deployment configuration field. It measures serialized input with JavaScript string length (UTF-16 code units), not the banks' Unicode code-point count |
| Concurrent reviews | At most one active review per session; overlapping triggers for that session are skipped | No plugin-wide concurrency cap across different sessions. The serialized write queue does not serialize model requests |
| Requests and time | At most 16 model requests per review, configurable downward; a default 120-second model-loop cancellation budget | Not a tool-call, token, cost, or hard end-to-end shutdown limit. Already-started writes are awaited; host/adapter network retries have their own controls |
| Model context and output | Uses the selected model's effective request configuration | Context-window admission, output-token limits, and provider quotas belong to the host/model adapter/provider; they are not guaranteed by bank budgets or the request-count limit |

For integrations needing a strict resource envelope, define input admission, aggregate concurrency, and token/cost policies at the appropriate host boundary rather than assuming the bank budgets provide them. See [`lib/scheduler.js`](lib/scheduler.js), [`lib/review.js`](lib/review.js), and [`lib/core.js`](lib/core.js) for the respective contracts. No additional caps or automatic truncation are enabled by this documentation.

## Storage and recovery

DSH's JSON KvUnit stores memory in `~/.dsh/storages/hermes_memory.json`. The first mutation of v1 records writes an atomic v2 global snapshot:

```text
global: { format: 2, tables: { memory, user } }
```

The original v1 tables remain as a recovery copy; subsequent reads use the v2 snapshot. Back up data before downgrading. Older versions cannot read later updates stored in v2.

A separate `~/.dsh/storages/hermes_memory_runtime.json` stores review claims, outcomes, and pending proposals without adding that metadata to the main session. On reload, unfinished reviews are marked interrupted. An approval with an uncertain commit outcome is not automatically replayed. Any durable publication error stops further writes; reload the plugin and reread storage before deciding how to recover.

Static and dynamic installations share the same storage names and must have only one writer instance. The write queue and storage hub serialize writes within one host. Multiple DSH processes writing to the same directory, or external edits to the files while the plugin is running, are unsupported. This follows DSH's current storage contract and differs from Hermes' native file locking.

The panel API uses DSH owner authentication and Host/Origin checks. Responses disable caching:

| Path | Method | Purpose |
| --- | --- | --- |
| `/hermes-memory/stats` | GET | Readiness, capacity, and background status |
| `/hermes-memory/ops` | POST | Read both banks or perform direct edits; list results include pending proposals and background status |
| `/hermes-memory/pending` | GET / POST | List proposals, or approve or discard a specific proposal ID |

For HTTP 401, reopen the page through the DSH login entry. HTTP 503 indicates that authentication or storage services are unavailable. Failed panel operations preserve drafts, the last successful snapshot, and pending proposals instead of displaying an empty store or a false success state.

## Scope of the adaptation

| Hermes mechanism | DSH implementation |
| --- | --- |
| Two banks, default budgets, independent enable switches, required target, atomic operations | Adapted |
| Frozen snapshots, Unicode code point budgets, unique-span patching, protection against emptying a bank | Adapted with v4 producer-owned message sources |
| Background model review after a qualifying response at each multiple of 10 user turns by default | Adapted as an independent, restricted model loop with at most 16 requests |
| Grounded facts, no inference of user traits from conversation topics, skills take priority for procedural knowledge | Main and background prompts follow the pinned upstream policy |
| Approval for background changes and deletions, with complete original-entry pins | Adapted; only the authenticated owner can approve or discard through the DSH panel |
| External providers, automatic skill maintenance, native `session_search` | Outside this plugin's dual-bank scope; chat retrieval uses host capabilities |
| Native threat scanner | Replaced with a bounded local heuristic adaptation; not claimed to be equivalent, and false positives or negatives are possible |
| File locks and cross-process rereads | Replaced with a single DSH writer instance, serialized writes, and atomic KvUnit publication |
| Full background agent fork | Replaced with an isolated `llm.prepareCall` loop; no new main session and no recursive agents |
| Review counters after a main-session fork | DSH rebuilds the count from inherited history, retaining the parent's accumulated user turns instead of starting from zero for a new agent |
| Background requests in the dynamic VM | Unavailable because the current host exposes no native cancellation controller; use the static bundle |

The [2.0.0 implementation and verification record](docs/2026-11-11_hermes-memory-implementation-report.md) documents validation and platform boundaries in Chinese. The historical [1.2.0 comparison record](docs/2026-11-09_compatibility-and-hermes-report.md) describes that earlier release and is not a statement of current capabilities.

## Develop and verify

The source separates pure rules, prompts, the background model loop, scheduling, and host integration. `host.js` is generated from those modules; do not maintain a second implementation by hand.

```sh
npm run build:host
npm test
npm pack --dry-run
```

Tests against real DSH services require a built checkout. Those tests are skipped when no checkout is specified:

```powershell
$env:DSH_CLIENT_TEST_CHECKOUT=Join-Path $env:USERPROFILE 'deepseek-harness'
node --test tests/*.test.mjs
```

The tests use temporary directories and synthetic data. They cover real v4 encoding, closing and reopening plain JSONL and Zstandard sessions, real JSON KvUnits, native and dynamic VM integration, model adapters, review triggers, concurrency, approvals, and storage failures. Synthetic facts are not written into the actual user memory banks.

The main-chat guidance contains 964 Unicode code points. The memory tool description and parameters add approximately 51 characters compared with the previous version. The background-specific review prompt contains 1477 code points and is sent only in review requests. These are character counts; actual token usage and cost depend on the model tokenizer, conversation length, and request count.

## License

MIT. Attribution for the original Hermes design, prompts, and rules is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The SVG icon is original to this project.
