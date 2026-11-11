# dsh-hermes-memory

将 [Hermes 内置记忆](https://github.com/NousResearch/hermes-agent/tree/c0c4357744d1a6994d332b826aea4c77fcccaf38) 的双库、冻结快照、原子策展与周期后台复盘适配到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

默认每 **10 个用户对话回合**，在正常答复完成后用本轮模型进行一次独立后台复盘。复盘可以保存有依据的长期事实，也可以决定没有内容值得保存。它会产生额外模型调用；条目数不保证持续增长。后台对旧条目的修改或删除先进入待审队列，可在「记忆」面板批准或丢弃。

当前实现基线是 Hermes `c0c4357744d1a6994d332b826aea4c77fcccaf38`（2026-11-11）。主入口是**静态 bundle**；动态沙箱没有原生请求取消接口，动态形态只提供记忆工具、快照和统计，后台状态明确显示 `unavailable`。本项目保留 DSH 的存储与生命周期接口，平台差异见下文。

## 安装与使用

在 DSH 插件管理器安装或启用此 bundle，刷新原网页，点击侧栏底部「记忆」。源码安装使用包目录；发布包可使用：

```sh
dsh plugin --profile web add dsh-hermes-memory
```

插件需要 `tools`、`timer`、`sessionProjections` 及 JSON storage backend。Web profile 已带存储组件，不应重复声明它们。缺少存储时返回错误，不会把旧数据当空库覆盖。

已在 DSH `0.2.2-alpha.2`、Node `24.22.2` 的当前 v4 会话格式验证。包的 peer 范围不是运行兼容性保证。

### 观察自动记忆

1. 在正常对话中明确表达长期事实，例如「以后都用中文与我交流」。一次性的任务要求不会自动变成长期偏好。
2. 主模型可随时主动保存；默认每 10 个真实用户回合还会触发后台复盘。工具调用和自动继续消息不推进用户回合计数。
3. 打开「记忆」面板刷新数据，查看后台状态、双库内容和待审修改。后台新增可直接保存，旧条目的修改与删除需要审核。
4. 当前会话保持首次读取的冻结快照。新会话会读取更新后的记忆；需要读取即时状态可调用 `memory_list`。

后台只提供 `memory` 和 `memory_list` 两个工具，最多 16 次模型请求，不具有文件、网络、执行命令或批准提案的权限。取消、异常、空答复、含未完成工具调用的答复不触发自动复盘；普通子代理不触发自动复盘。插件卸载会中止请求，并等待已经开始的写入落定。

### 两个记忆库

| 目标 | 用途 | 默认容量 |
| --- | --- | --- |
| `user` | 用户身份、长期偏好、交流方式与明确的常设期望 | 1375 字符 |
| `memory` | 跨任务适用的环境事实、工具约定、路径与稳定配置 | 2200 字符 |

一条事实只进入一个库。临时进度、完成日志、TODO 留在会话历史；流程、技巧和特定任务的习惯属于 skills。此插件不会自动修改技能文件。

预算按 Unicode 码点计算，条目间分隔符 `\n§\n` 也计入；单个 `😀` 计 1。超限不会自动截断已有条目。

## 调用工具

模型可见的 `memory` 接口只有必填的 `target` 与 `operations`。每次只写一个库；批次先验证所有操作与最终预算，再一次性落盘。

```json
{"target":"user","operations":[{"action":"add","content":"用户偏好用中文交流。"}]}
```

```json
{"target":"memory","operations":[{"action":"patch","old_text":"Node 24","content":"Node 26"}]}
```

```json
{"target":"memory","operations":[{"action":"remove","old_text":"旧的完整条目"},{"action":"add","content":"更新后的稳定环境事实。"}]}
```

- `add` 添加并去重；前后空白会被清理。
- `patch` 只替换唯一、精确的 `old_text` 片段，保留同条目的其他事实与空白。整条更新使用完整旧条目作为 `old_text`。
- `remove` 定位并删除整条。先匹配完整原文，再匹配唯一片段；定位兼容常见引号、横线和空白差异，但 `patch` 修改的片段仍须精确且唯一。
- 多操作 consolidation 不得清空原本非空的库；单个明确的 `remove` 可以删除最后一条。删除操作允许逐步修复原本超限的库。
- 旧的顶层 `action`、`oldText`、`new_text` 仍由内部兼容层处理。模型接口不再暴露 `replace`；网页编辑保留整条更新能力。

`memory_list` 读取当前库；`memory_search` 是双库内的确定性关键词检索，**不搜索聊天历史**；`memory_stats` 查看容量与后台状态；`memory_debug` 查看存储与后台诊断。连续失败会返回停止重试提示，成功后不会重复保存同一更新。

`memory_pending` 只允许模型列出提案。批准、丢弃必须由已登录用户在记忆面板执行，模型不能自行审批，后台复盘也不能访问审批工具。审批会重新验证完整原条目及身份；原条目变化后拒绝使用旧提案覆盖新内容。

## 配置后台复盘

通过 DSH 的配置界面或配置编辑服务修改 `hermes-memory` 条目。常用配置：

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

| 字段 | 说明 |
| --- | --- |
| `memoryEnabled` / `userEnabled` | 分别关闭库的模型读取、快照与写入，保留磁盘数据供管理 |
| `nudgeInterval` | 兼容旧配置名，现在表示后台复盘的用户回合周期；`0` 关闭周期触发 |
| `backgroundReview.interval` | 可覆盖 `nudgeInterval` |
| `backgroundReview.enabled` | `false` 关闭自动复盘，主模型仍可保存记忆 |
| `backgroundReview.provider` / `model` | 一起设置以使用独立复盘模型；省略时继承本轮实际模型及参数 |
| `backgroundReview.maxIterations` | 1–16，最多模型请求数 |
| `backgroundReview.timeoutMs` | 后台请求总时间预算，默认 120 秒 |
| `writeApproval` | `true` 时主模型写入也先进入待审队列；用户在面板上的直接编辑仍可保存 |
| `contentGuard` | 对新内容应用本地有界扫描，加载命中的旧条目只在提示中隐藏原文 |

指定其他复盘模型时，旧模型的 reasoning effort 和输出 token 上限不会强加给新模型，而采用目标适配器默认值。后台出错不会让正常聊天失败。失败状态可见；同一触发轮次不会在重载后重复扣费重跑，后续周期可再次尝试。

## 保存与恢复

记忆仍由 DSH JSON KvUnit 保存在 `~/.dsh/storages/hermes_memory.json`。v1 记录首次变化时写入 v2 原子全局快照：

```text
global: { format: 2, tables: { memory, user } }
```

原 v1 表保留为恢复副本，后续读取以 v2 快照为准。降级旧版前应备份数据；旧版无法读取 v2 的后续更新。

新增 `~/.dsh/storages/hermes_memory_runtime.json` 保存复盘触发记录、结果和待审提案，不把元数据塞进主会话。重载发现未完成复盘时标为中断；审批写入处于不确定阶段时不自动重放。存储发布出现任何异常后停止继续写入，重新加载插件、重新读取磁盘后才能恢复判断。

静态与动态插件共用同名存储，只能保留一个写入实例。写队列与 storage hub 保证单个宿主内的顺序；不支持多个 DSH 进程同时写同一目录，也不支持运行中从外部直接改文件。此限制对应 DSH 当前存储契约，与 Hermes 原生文件锁不同。

网页 API 使用 DSH owner 身份认证及 Host/Origin 检查，响应禁止缓存：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/hermes-memory/stats` | GET | ready、容量、后台状态 |
| `/hermes-memory/ops` | POST | 读取双库、直接编辑；list 包含待审提案与后台状态 |
| `/hermes-memory/pending` | GET / POST | 列出提案；批准或丢弃指定 id |

401 要重新通过 DSH 登录入口打开网页；503 表示认证或存储服务不可用。操作失败会保留草稿、最后成功快照及待审提案，不显示虚假的空库或保存成功。

## 对照范围

| Hermes 机制 | DSH 实现 |
| --- | --- |
| 双库、默认预算、独立开关、必填目标、原子 operations | 已适配 |
| 冻结快照、Unicode 码点、唯一片段 patch、清空保护 | 已适配，使用 v4 producer-owned 消息来源 |
| 默认每 10 用户回合、正常答复后的后台模型复盘 | 已适配，独立受限模型循环，最多 16 次请求 |
| grounded facts、禁止凭话题推断用户特征、skills 优先 | 主提示与后台提示采用固定基线策略 |
| 后台修改/删除待审及完整原条目固定 | 已适配；只允许已登录用户在 DSH 面板批准或丢弃 |
| 外部 provider、skills 自动维护、原生 session_search | 不属于本插件的双库实现；聊天检索使用宿主能力 |
| 原生 threat scanner | 保留本地有界启发式适配，未宣称逐条等价，可能漏报或误报 |
| 文件锁、跨进程重读 | 改为 DSH 单写入实例、串行写队列及原子 KvUnit |
| 完整后台 agent fork | 改为隔离的 `llm.prepareCall` 循环，无新主会话、无递归 |
| 主会话 fork 的复盘计数 | DSH 从继承历史重建计数；保留父会话已累计用户回合，不按新 agent 从零计数 |
| 动态 VM 后台请求 | 当前宿主未提供原生取消控制器；明确不可用，使用静态 bundle |

当前验证结果与适配边界见 [2.0.0 实现与验证记录](docs/2026-11-11_hermes-memory-implementation-report.md)。历史的 [1.2.0 对比记录](docs/2026-11-09_compatibility-and-hermes-report.md) 保留当时的范围，不作为当前版本能力说明。

## 开发与验证

源码分为纯规则、提示词、后台模型循环、调度与宿主集成。`host.js` 由这些模块生成，禁止手工维护另一份实现。

```sh
npm run build:host
npm test
npm pack --dry-run
```

真实 DSH 测试需指定已构建 checkout；不指定时对应测试会跳过：

```powershell
$env:DSH_CLIENT_TEST_CHECKOUT=Join-Path $env:USERPROFILE 'deepseek-harness'
node --test tests/*.test.mjs
```

测试使用临时目录与合成数据，覆盖真实 v4 编码、普通 JSONL / Zstandard 关闭再打开、真实 JSON KvUnit、原生与动态 VM、模型适配器、后台触发、并发、审批和存储失败。不会将合成事实写入用户的实际记忆库。

主对话新增 guidance 964 个 Unicode 字符；memory 工具说明与参数相较旧版约增加 51 字符。后台专用 review 提示 1477 字符，仅在复盘请求中发送。这是字符计数，实际 token 与费用取决于模型 tokenizer、对话长度及请求次数。

## License

MIT。Hermes 原始设计、提示与规则的归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。图标为本项目原创 SVG。
