# dsh-hermes-memory

> Hermes-style persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
> — a faithful port of the hermes-agent `MemoryStore` (`MEMORY.md` / `USER.md`) mechanism,
> plus a **built-in memory visualization panel** in the DSH web UI.

**DeepSeek Harness 的 Hermes 式记忆管理插件**：MEMORY.md（Agent 个人笔记）+ USER.md（用户画像）双记忆库，由模型用一个 `memory` 工具自主策展，跨会话持久化，每个会话以冻结快照重新注入；同时提供**内置于 Web 界面的记忆面板**，让你直接看见并修改两个记忆库。忠实复刻 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 `tools/memory_tool.py` 机制，零外部依赖、纯 DSH 原生接缝实现。

## Features

| Hermes 机制 | 本插件实现 |
|---|---|
| `MEMORY.md` — agent 个人笔记（环境事实/项目约定/工具怪癖），**2200 字符上限** | ✓ `memory` 记忆库 |
| `USER.md` — 用户画像（偏好/沟通风格/工作习惯），**1375 字符上限** | ✓ `user` 记忆库 |
| 条目以 `§` 分隔、可多行，字符上限（非 token） | ✓ 同 |
| 单个 `memory` 工具：`add` / `replace` / `remove` / `batch`（全有或全无） | ✓ 同 |
| `replace`/`remove` 用唯一子串匹配 `old_text`，多条命中报冲突 | ✓ 同（精确匹配优先，UI 传完整文本永远唯一命中） |
| 超限不静默丢弃：返回当前条目列表，模型当轮合并后重试；每轮失败上限 3 | ✓ 同 |
| `add` 自动去重（同文本不重复） | ✓ 同 |
| **冻结快照**：会话开始注入一次（`<system-reminder>` 框架 + `═` 标尺 + `[n% — x/limit chars]` 用量表头），会话中途写入不改已注入快照（保前缀缓存） | ✓ 同 |
| nudge 提醒：连续 10 轮无写入提醒持久化 | ✓ 同 |
| 成功结果：`memory(memory): Entry updated.` + usage + "do not repeat" | ✓ 同 |
| 工具内部无 LLM（agent-curated 策展，零 LLM 成本） | ✓ 同 |
| **记忆可视化面板**（Web UI 内查看/增/删/改两个记忆库） | ✓ 本插件独有（见下） |

## 记忆面板（Memory Panel）

安装后，DSH Web 界面**侧边栏底部**会出现「记忆」入口，点击打开记忆面板：

![记忆面板](https://cdn.jsdelivr.net/gh/isheng-eqi/dsh-hermes-memory@5cf56dd3c583ba1de2de5a69135255865e95d4d8/docs/panel-1.png)

![记忆面板编辑](https://cdn.jsdelivr.net/gh/isheng-eqi/dsh-hermes-memory@5cf56dd3c583ba1de2de5a69135255865e95d4d8/docs/panel-2.png)

### 功能

- **查看**：MEMORY 与 USER 两个记忆库的全部条目、各自占用率（`84% — 1,859/2,200 chars`）与条数
- **编辑**：每行「编辑」按钮 → 行内文本域直接修改 → 保存；替换保留条目身份（seq 不变）
- **删除**：每行「删除」按钮，按条目精确匹配移除
- **添加**：分区底部输入新条目，回车或「添加」按钮提交（自动去重）
- **实时同步**：每次操作立即写入 `~/.dsh/storages/hermes_memory.json`（原子写、跨重启持久），状态行给出反馈

### 设计

黑白灰、大量留白、细线分割、克制动效 —— 吸收水墨美学的克制气质，不堆砌装饰：面板即工具，所见即所得。编辑/删除按钮常显（浅灰弱化），悬停加深，不会干扰阅读。

### 架构

```
浏览器（client 半边，__ModuleLoader__ 模块）
 ├─ sidebar.footer.action「记忆」入口 + shell.overlay 浮层面板（React）
 └─ 同源 fetch → /hermes-memory/stats（GET 统计）
                    /hermes-memory/ops （POST add/replace/remove/list）
宿主（host 半边）
 └─ webServer 服务注册上述路由 → applyBatch → KvUnit `hermes_memory` → 落盘
```

面板与模型 `memory` 工具读写**同一份存储**，两边看到的内容永远一致 —— 模型策展的记忆，你可以随时亲眼查看和修正。

## Quick Start

### 方式 A：dsh bundle 安装（推荐，部署级、重启自动加载）

本仓库是标准 **dsh bundle**（`package.json` 声明 `dsh.bundle` + [`cordis.patch.yml`](cordis.patch.yml)），一行安装：

```sh
dsh plugin --profile web add github:isheng-eqi/dsh-hermes-memory
# 或本地路径
dsh plugin --profile web add /path/to/dsh-hermes-memory
```

安装后插件在**部署级**生效（所有会话可见）：模型获得 `memory` / `memory_search` / `memory_list` / `memory_stats` / `memory_debug` 工具，每个会话开始自动注入记忆冻结快照，Web 界面侧边栏出现「记忆」面板入口。

### 方式 B：动态 Cordis 插件（进程级，无需改部署配置）

在任意 DSH 会话中，让模型执行 `cordis_define`（Host 半边代码 = [`host.js`](host.js)，Client 半边 = [`client.js`](client.js)，额外带 Run 卡记忆面板）与 `cordis_run`。注意动态插件随进程退出而消失，重启后需重新运行（数据不丢）。

> 动态形态无配置通道：字符上限与 nudge 间隔为硬编码（2200/1375/10），与 bundle 形态默认值一致；如需调整请使用方式 A。

### 使用

- **让模型记**：直接对模型说"记住 XXX"即可；每个新会话开始会自动注入记忆快照
- **自己看/改**：点击侧边栏「记忆」→ 面板直接查看、编辑、删除、添加条目
- **数据存储**：`~/.dsh/storages/hermes_memory.json`（DSH storage hub 的 json 后端，原子写、人类可读、跨会话跨重启持久）

## Tools

### `memory`
唯一的记忆写入入口，与 hermes-agent 契约一致：
- `action`：`add` / `replace` / `remove` / `batch`（必填）
- `target`：`memory`（默认，= MEMORY.md）/ `user`（= USER.md）
- `content`：新增/替换条目文本
- `oldText`：replace/remove 时的匹配文本（**精确匹配优先**，无精确命中回退唯一子串匹配）
- `operations`：batch 时的操作数组（全有或全无，可在一次调用里腾空间+写入）

### 辅助工具
- `memory_search` — 确定性关键词检索两个记忆库
- `memory_list` — 列出条目（按存储顺序）
- `memory_stats` — 用量统计（`3% — 79/2,200 chars`）
- `memory_debug` — 诊断存储句柄表与 store 状态

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Web UI 记忆面板（client 半边）                              │
│  └─ sidebar.footer.action 入口 + shell.overlay 浮层         │
│     └─ /hermes-memory/* 路由 ↔ 同源 fetch                   │
├────────────────────────────────────────────────────────────┤
│  systemPrompt / agent/pre-step                             │
│  └─ 冻结快照注入（会话首步一次）+ nudge 提醒（每 10 轮）      │
├────────────────────────────────────────────────────────────┤
│  `memory` 工具（harness.defineTool/registerTool）            │
│  └─ MemoryStore 语义：add/replace/remove/batch，§ 分隔条目    │
│     字符预算（2200/1375），超限合并协议，失败上限 3/轮         │
│     精确匹配优先（UI 场景），子串匹配回退（模型场景）          │
├────────────────────────────────────────────────────────────┤
│  DSH storage hub → json 后端 → KvUnit `hermes_memory`       │
│  └─ ~/.dsh/storages/hermes_memory.json（原子写、版本化）      │
└────────────────────────────────────────────────────────────┘
```

- **写链串行**：单进程内所有写入经 promise 链排队，先落盘后更内存。
- **自愈**：更新/重启插件时若旧纤维的单元句柄未释放（`unit already open`），自动强制关闭僵尸句柄并重开；disposer 返回 Promise 等待 close 完成。
- **webServer 迟到处理**：路由注册等待 `webServer` 服务（500ms 轮询，最多 30s）；无 webServer 的环境（TUI/headless）自动跳过面板层，工具与注入不受影响。
- **面板与模型共用同一存储**：面板操作走与 `memory` 工具相同的 `applyBatch` 写链，天然一致。
- **注入格式**（逐字符对齐 hermes-agent `MemoryStore._render_block`）：
  ```
  <system-reminder>
  <hermes-memory-snapshot>
  Persistent memory, maintained with the `memory` tool. ...
  ══════════════════════════════════════════════
  MEMORY (your personal notes) [3% — 79/2,200 chars]
  ══════════════════════════════════════════════
  entry one § entry two
  ...
  </system-reminder>
  ```
  条目内 `</system-reminder>` 被转义，文件内容无法破坏框架。

## Design Decisions（与 Hermes 原版的差异）

- **存储介质**：Hermes 用 `~/.hermes/memories/*.md` 文件 + 文件锁/原子 rename；本插件改用 DSH 原生 json 存储单元（本身原子写、版本化、人类可读），单进程内无需文件锁。
- **注入载体**：Hermes 注入系统提示词；本插件经 `agent/pre-step` 注入 durable user 消息（source `{kind:'plugin', plugin:'hermes-memory'}`），会话日志可重建（model-visible ⟺ logged）。
- **匹配策略**：Hermes 的 `replace`/`remove` 是纯子串匹配；本插件改为**精确匹配优先**——UI 传完整文本时永远唯一命中（修复短文本条目"11"是其他条目子串时的冲突），模型子串语义保留为回退，两边行为都更稳。
- **失败上限只约束模型**：Hermes 的"每轮最多失败 3 次"协议仅作用于模型 `memory` 工具调用；面板操作（sessionId `'ui'`）每次失败都返回原始错误，不会被协议文案卡死。
- **可视化面板**：Hermes 无 UI；本插件用 DSH 原生 slot（`sidebar.footer.action` / `shell.overlay`）+ webServer 路由实现浏览器面板，零前端依赖、零构建步骤。
- **未实现**（与社区移植版一致）：`write_approval` 审批门、提示注入安全扫描（信任度与 AGENTS.md 相同）、`session_search`（Hermes 用 SQLite FTS5 检索会话历史；DSH 原生 `sessionQuery` 可作后续接入点）。

## 社区收录

本插件为 DSH 社区生态的一部分。已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

## License

MIT
