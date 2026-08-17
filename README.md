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

## 🚀 Quick Start

### 方式 A：dsh bundle 安装（推荐，部署级、重启自动加载）

本仓库是标准 **dsh bundle**（`package.json` 声明 `dsh.bundle` + [`cordis.patch.yml`](cordis.patch.yml)），一行安装：

```sh
dsh plugin --profile web add github:isheng-eqi/dsh-hermes-memory
# 或本地路径
dsh plugin --profile web add /path/to/dsh-hermes-memory
```

安装后插件在**部署级**生效（所有会话可见）：模型获得 `memory` / `memory_search` / `memory_list` / `memory_stats` / `memory_debug` 工具，每个会话开始自动注入记忆冻结快照。

### 方式 B：动态 Cordis 插件（进程级，无需改部署配置）

在任意 DSH 会话中，让模型执行 `cordis_define`（Host 半边代码 = [`host.js`](host.js)，Client 半边 = [`client.js`](client.js)，额外带 Run 卡记忆面板）与 `cordis_run`。注意动态插件随进程退出而消失，重启后需重新运行（数据不丢）。

### 使用

直接对模型说"记住 XXX"即可；每个新会话开始会自动注入记忆快照。

**数据存储**：`~/.dsh/storages/hermes_memory.json`（DSH storage hub 的 json 后端，原子写、人类可读、跨会话跨重启持久）。

## 🛠 Tools

### `memory`
唯一的记忆写入入口，与 hermes-agent 契约一致：
- `action`：`add` / `replace` / `remove` / `batch`（必填）
- `target`：`memory`（默认，= MEMORY.md）/ `user`（= USER.md）
- `content`：新增/替换条目文本
- `oldText`：replace/remove 时的唯一子串匹配
- `operations`：batch 时的操作数组（全有或全无，可在一次调用里腾空间+写入）

### 辅助工具
- `memory_search` — 确定性关键词检索两个记忆库
- `memory_list` — 列出条目（按存储顺序）
- `memory_stats` — 用量统计（`3% — 79/2,200 chars`）
- `memory_debug` — 诊断存储句柄表与 store 状态
