> **历史文档，已归档：本页描述早期动态插件设计，不是当前 v2 的实现契约。请勿直接复制其中的消息来源、工具协议或触发规则。**
>
> 当前行为以 [中文 README](README.md)、[English README](README.en.md) 和 [`lib/index.js`](lib/index.js) 为准。下面保留原文，供理解设计演变。
>
> **Archived historical document:** this page describes an earlier dynamic-plugin design, not the current v2 contract. Do not copy its message sources, tool protocol, or trigger rules. Use the current READMEs and host integration linked above. The original text is preserved below for historical context.

## 当前实现与本文的主要差异 / Current implementation differences

| 范围 / Area | 当前 v2 契约 / Current v2 contract |
|---|---|
| 消息来源 / Message source | 静态 bundle 使用 producer-owned `plugin:dsh-hermes-memory`，动态入口使用 `plugin:hermes-memory`；旧 `{kind: 'plugin'}` 只在历史读取时兼容，不能用于新的 v4 消息。 / New v4 messages use producer-owned `plugin:dsh-hermes-memory` in the static bundle and `plugin:hermes-memory` in the dynamic entry; the old kind is recognized only when reading legacy history. |
| 工具协议 / Tool protocol | `memory` 要求 `target` 和 `operations`，公开操作为 `add`、`patch`、`remove`；不是本文的旧接口。 / The public schema requires `target` and `operations`, with `add`, `patch`, and `remove`. |
| 触发 / Trigger | 默认每 10 个真实用户回合的合格完成答复后独立复盘；不是“连续 N 轮没有写入”的提醒。 / Independent review follows a qualifying response at each multiple of 10 genuine user turns, not N turns without a write. |
| 失败 / Failures | 第四次合并失败起返回停止重试提示，不硬性拒绝后续调用。 / Starting at the fourth consolidation failure, guidance asks the model to stop; it is not a hard tool-call limit. |
| 部署 / Deployment | 静态 bundle 为主；动态沙箱后台复盘不可用，但仍提供记忆工具、快照和统计。 / Static bundle is primary; dynamic deployment retains memory tools, snapshots and statistics but cannot run background review. |
| 内容检查 / Content guard | 当前已有可配置的本地启发式检查；不等同于完整安全隔离。 / A configurable local heuristic guard exists; it is not a complete security boundary. |

---

# Hermes 式记忆管理插件（DSH 动态 Cordis Plugin）— 设计文档 v4

> v4 = 忠实复刻 hermes-agent `MemoryStore`（MEMORY.md / USER.md 机制）。
> 直接依据：NousResearch/hermes-agent `tools/memory_tool.py` + 官方 `website/docs/user-guide/features/memory.md`
> + 本地源码 `dsh-memory-research/_repos/hyls9527__dsh-plugins/packages/memory/src/*.ts`（该机制最忠实的 TS 移植）。

## 复刻目标（hermes-agent 机制）

| Hermes 机制 | 本插件实现 |
|---|---|
| `~/.hermes/memories/MEMORY.md`（agent 个人笔记，2200 字符 ≈800 token） | KV 单元 `hermes_memory` 表 `memory`（每条记录 = 一个条目，seq 保序） |
| `~/.hermes/memories/USER.md`（用户画像，1375 字符 ≈500 token） | 同一单元表 `user` |
| 条目以 `§`（`\n§\n`）分隔，可多行 | 渲染时以同一分隔符连接；字符上限与 Hermes 一致（2200/1375） |
| 会话开始注入**冻结快照**（`MEMORY (your personal notes) [67% — 1474/2200 chars]` 用量表头 + `═`×46 标尺 + `<system-reminder>` 框架） | `agent/pre-step` 注入 durable user 消息（source `{kind:'plugin', plugin:'hermes-memory', form:'instructions'}`，文本内带 `<hermes-memory-snapshot>` 标记）；会话中途写入不改已注入快照（保前缀缓存） |
| `memory` 工具：add / replace / remove / batch（全有或全无），target memory/user，replace/remove 用唯一子串匹配 old_text | 同名同语义 `memory` 工具 |
| 超限不静默丢弃：返回错误 + 当前条目列表，模型当轮合并后重试；每轮失败上限 3 | 同（按 session 计数，pre-step 重置） |
| add 自动去重（同文本不重复加） | 同 |
| nudge：连续 N 轮（默认 10）无 memory 写入提醒持久化 | 同（`agent/pre-step` 折叠日志计算） |
| 成功结果：`memory(memory): Entry updated.` + usage + "do not repeat" | 同 |
| 安全扫描（提示注入/凭据/不可见 Unicode） | 说明：动态插件内暂不实现（社区移植版也砍掉了；对记忆文件信任度与 AGENTS.md 相同） |
| 会话历史检索（hermes 的 `session_search`，SQLite FTS5） | 暂以 `memory_search`（确定性关键词）代替；后续可接 DSH `sessionQuery` |

## 与 DSH 原生的差异（有意为之）

- 存储介质：不用文件锁/原子 rename（DSH storage json 后端本身原子写、版本化、人类可读 `~/.dsh/storages/hermes_memory.json`），单进程内写链串行。
- 冻结快照消息的 source 用 harness 词汇 `{kind:'plugin', ...}`（动态插件无法扩展 MessageSourceMap），用文本内标记区分 snapshot/nudge。
- 动态插件 Host 半边运行在 root 组纤维：注入与工具对**所有会话**生效（与 Hermes 全局记忆一致）。

## 工具集（v4）

- `memory` —— 核心（add/replace/remove/batch）
- `memory_search` —— 关键词检索两个记忆库
- `memory_list` —— 列出条目
- `memory_stats` —— 用量统计
- （删除 v3 的 memory_write/episode/delete/consolidate——由 `memory` 工具取代，合并是模型的职责，与 Hermes 一致）

## 客户端

- Run 卡面板：两个记忆库计数 + 字符用量 + 最近条目 + 刷新（`host.call('mem-stats')`）。
