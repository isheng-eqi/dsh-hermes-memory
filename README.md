# 🧠 dsh-hermes-memory

> Hermes-style persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
> — a faithful port of the hermes-agent `MemoryStore` (`MEMORY.md` / `USER.md`) mechanism.

**DeepSeek Harness 的 Hermes 式记忆管理插件**：MEMORY.md（Agent 个人笔记）+ USER.md（用户画像）双记忆库，由模型用一个 `memory` 工具自主策展，跨会话持久化，每个会话以冻结快照重新注入。忠实复刻 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 `tools/memory_tool.py` 机制，零外部依赖、纯 DSH 原生接缝实现。

## ✨ Features

| Hermes 机制 | 本插件实现 |
|---|---|
| `MEMORY.md` — agent 个人笔记（环境事实/项目约定/工具怪癖），**2200 字符上限** | ✅ `memory` 记忆库 |
| `USER.md` — 用户画像（偏好/沟通风格/工作习惯），**1375 字符上限** | ✅ `user` 记忆库 |
| 条目以 `§` 分隔、可多行，字符上限（非 token） | ✅ 同 |
| 单个 `memory` 工具：`add` / `replace` / `remove` / `batch`（全有或全无） | ✅ 同 |
| `replace`/`remove` 用唯一子串匹配 `old_text`，多条命中报冲突 | ✅ 同 |
| 超限不静默丢弃：返回当前条目列表，模型当轮合并后重试；每轮失败上限 3 | ✅ 同 |
| `add` 自动去重（同文本不重复） | ✅ 同 |
| **冻结快照**：会话开始注入一次（`<system-reminder>` 框架 + `═` 标尺 + `[n% — x/limit chars]` 用量表头），会话中途写入不改已注入快照（保前缀缓存） | ✅ 同 |
| nudge 提醒：连续 10 轮无写入提醒持久化 | ✅ 同 |
| 成功结果：`memory(memory): Entry updated.` + usage + "do not repeat" | ✅ 同 |
| 工具内部无 LLM（agent-curated 策展，零 LLM 成本） | ✅ 同 |
