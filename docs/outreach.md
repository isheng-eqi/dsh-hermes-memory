# Describing model usage in project introductions

Use the wording below for v2.0.0 introductions. It matches the [English README](../README.en.md), [Chinese README](../README.md), [default configuration](../lib/index.js), [scheduler](../lib/scheduler.js), and [review loop](../lib/review.js).

## Reusable English introduction

I maintain dsh-hermes-memory, an adaptation of Hermes built-in memory for DeepSeek Harness. It provides two bounded banks for durable facts and user preferences, frozen session snapshots, and memory tools plus an authenticated editor for curation. The bounds apply to the curated banks, not total process memory, tokens, or cost.

The v2.0.0 static bundle enables independent background review by default after a qualifying response at each multiple of 10 genuine user turns. Reviews make additional LLM requests and consume model quota: at most 16 requests per review, with a default model-loop time budget of 120 seconds. Set `backgroundReview.enabled: false` to opt out. Main-agent curation and injected memory still consume model tokens. Review inherits the triggering turn's model unless both `backgroundReview.provider` and `backgroundReview.model` select a separately configured model; a tested low-cost tool model may be appropriate, but total cost depends on model, context, and request count. An explicit review-route failure does not fall back to the foreground model or change the foreground session.

Within one plugin instance, panel, model, and background writes share a serialized queue. Panel edits and deletes check the full original text; the updated official panel also captures a row-version token to reject stale forms after a change-back or identical-text recreation. The panel is not an independent JSON writer. Default host-JSON storage still has an explicit shared-root hazard: separate DSH service/profile processes or independent backend instances using the same files can overwrite one another's cached updates, and live disk edits can also be overwritten. Native static deployments can opt into `storageRoot` for a shared two-file lease and pre-publish fingerprint checks; those safeguards require cooperating writers and do not merge edits automatically.

## 可复用中文介绍

我维护的 dsh-hermes-memory 将 Hermes 内置记忆适配到 DeepSeek Harness，提供保存长期事实与用户偏好的两个有界记忆库、冻结的会话快照，以及用于策展的记忆工具和已登录用户编辑器。这些边界针对整理后的记忆库，不代表总进程内存、token 或费用上限。

v2.0.0 静态 bundle 默认在真实用户回合计数达到 10 的整数倍、且答复符合条件时执行独立后台复盘。复盘会产生额外 LLM 请求并消耗模型额度；每次最多 16 次请求，模型循环时间预算默认 120 秒。可设置 `backgroundReview.enabled: false` 关闭复盘；主模型策展和记忆注入仍消耗 token。后台默认继承触发回合的模型，也可以同时设置 `backgroundReview.provider` 与 `backgroundReview.model` 使用单独配置的模型。可考虑经过验证的低成本工具模型，但总费用仍取决于模型、上下文和请求次数。显式后台模型出错时不会回退到前台模型，也不会改变前台会话。

同一插件实例的面板、模型和后台写入共用串行队列。面板编辑与删除核对完整原文；新版官方面板还捕获行版本令牌，拒绝改后改回或删后同文重建时的旧表单。面板不是独立 JSON 文件写入者。默认宿主 JSON 的明确风险是共享目录：不同 DSH 服务／profile 进程或独立 backend 实例使用同一文件时，各自缓存的后续写入可能覆盖对方更新；运行期间的磁盘编辑也可能被覆盖。原生静态部署可选择 `storageRoot`，获得双文件共用租约与发布前指纹检查；这些保护要求写入者遵守协议，不会自动合并修改。

## Explain costs and deployment boundaries

- Reviews inherit the triggering turn's model unless both the review provider and model are overridden. Using the same provider or model still creates additional requests. Paid models may incur additional charges. For a separate model, use the [separate review-model configuration example](../README.en.md#configure-background-review), replace both IDs with DSH-configured values, and verify nested tool arguments, curation quality, and context capacity with synthetic facts. Do not promise savings or silently choose a provider for the user.
- The 16-request limit is a maximum per review, not the expected request count, a token allowance, or a fixed price. Adapter network retries are outside this plugin-loop count. The 120-second budget applies to the model loop; cancellation waits for writes already in progress.
- Review input includes conversation text and enabled memory banks. Character budgets for the curated banks do not cap review input, total token use, or cost.
- The dynamic sandbox currently reports background review as unavailable because it lacks native request cancellation. State that deployment explicitly when describing it; the default static bundle has background review enabled.
- The configuration below disables independent background review while retaining memory tools and snapshots. Merge it into the existing `hermes-memory` plugin entry; do not replace unrelated settings.

```yaml
backgroundReview:
  enabled: false
```

The memory tool itself performs storage operations, but describing only that path does not describe the plugin's default background model use. Avoid whole-plugin claims such as “makes no separate LLM requests,” “no autonomous background review,” or “zero token cost.” Disabling review still leaves main-agent curation and injected-context usage.

## Correct an earlier description

Earlier outreach said the plugin made no separate LLM requests. That statement was inaccurate for v2.0.0's default static deployment. The README introduction and this reusable wording disclose default review, additional quota usage, the opt-out setting, and the separate-model option. The storage wording distinguishes same-instance serialization from the shared-root lost-update hazard instead of describing the web panel as an independent file writer. Thanks to Devio (@D0xedDevi0) for testing and feedback on these boundaries. This correction does not change runtime defaults, rewrite previously sent emails, or send a new email.
