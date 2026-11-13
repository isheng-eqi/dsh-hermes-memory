# Describing model usage in project introductions

Use the wording below for v2.0.0 introductions. It matches the [English README](../README.en.md), [Chinese README](../README.md), [default configuration](../lib/index.js), [scheduler](../lib/scheduler.js), and [review loop](../lib/review.js).

## Reusable English wording

In v2.0.0, the static bundle enables independent background memory review by default after a qualifying response at each multiple of 10 genuine user turns. These reviews make additional LLM requests and consume model quota: at most 16 model requests per review, with a default model-loop time budget of 120 seconds. Automatic review can be disabled with backgroundReview.enabled=false. Main-agent curation and injected memory also consume model tokens.

## 可复用中文表述

v2.0.0 静态 bundle 默认开启独立后台记忆复盘，在真实用户回合计数达到 10 的整数倍、且本轮答复符合触发条件时运行。这些复盘会产生额外 LLM 请求并消耗模型额度；每次最多 16 次模型请求，默认模型循环时间预算为 120 秒。可通过 `backgroundReview.enabled=false` 关闭自动复盘。主代理策展和记忆注入也会消耗模型 token。

## Explain costs and deployment boundaries

- Reviews inherit the triggering turn's model unless both the review provider and model are overridden. Using the same provider or model still creates additional requests. Paid models may incur additional charges.
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

Earlier outreach said the plugin made no separate LLM requests. That statement does not match v2.0.0's default static deployment. The README introduction and this reusable wording now disclose default review, additional quota usage, and the opt-out setting before installation. This documentation correction does not change runtime defaults or rewrite previously sent emails.
