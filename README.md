# dsh-hermes-memory

[English](README.en.md)

将 [Hermes 内置记忆](https://github.com/NousResearch/hermes-agent/tree/c0c4357744d1a6994d332b826aea4c77fcccaf38) 的双库、冻结快照、原子策展与周期后台复盘适配到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

> **安装前了解模型用量：v2.0.0 静态 bundle 默认开启独立后台复盘，会产生额外 LLM 请求并消耗模型额度；使用付费模型时可能增加费用。**
>
> - 默认在真实用户回合计数达到 10 的整数倍、且本轮答复符合触发条件时复盘；默认继承触发回合的模型，每次复盘最多 16 次额外模型请求，模型循环时间预算默认 120 秒。这些是上限与预算，不是固定调用次数或固定费用。
> - 要关闭独立后台复盘，在插件配置中设置 `backgroundReview.enabled: false`，嵌套 YAML 示例见[配置后台复盘](#配置后台复盘)。主模型工具策展和注入的记忆仍消耗 token；关闭复盘不代表零模型用量。
> - 费用取决于模型、对话长度和实际请求次数。记忆库字符预算不限制总 token 或费用；详见[资源边界](#面向扩展开发者的资源边界)。

复盘可以保存有依据的长期事实，也可以决定没有内容值得保存；条目数不保证持续增长。后台对旧条目的修改或删除先进入待审队列，可在「记忆」面板批准或丢弃。

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
2. 主模型可随时主动保存；默认在真实用户回合计数达到 10 的整数倍、且本轮正常完成时触发后台复盘。工具调用和自动继续消息不推进用户回合计数。
3. 打开「记忆」面板刷新数据，查看后台状态、双库内容和待审修改。后台新增可直接保存，旧条目的修改与删除需要审核。
4. 当前会话保持首次读取的冻结快照。新会话会读取更新后的记忆；需要读取即时状态可调用 `memory_list`。

真实用户消息每轮最多计数一次。触发还要求本轮有真实用户消息、成功结束，以及非空且不含工具调用的最终答复。取消、异常、空答复、含未完成工具调用的答复不触发自动复盘；这些回合已经收到的真实用户消息仍计入周期。普通子代理不触发自动复盘。同一会话只运行一个后台复盘；运行期间遇到的后续触发会跳过，不排队补跑。

后台只提供 `memory` 和 `memory_list` 两个工具，不具有文件、网络、执行命令或批准提案的权限。后台模型返回不含工具调用的答复即结束复盘，包括「没有内容值得保存」；达到请求上限、超时、模型错误或取消也会停止。达到输出 token 上限的答复不会执行其中的工具调用。插件卸载会中止请求，并等待已经开始的写入落定。

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

`memory_list` 读取当前库；`memory_search` 是双库内的确定性关键词检索，**不搜索聊天历史**；`memory_stats` 查看容量、启用状态和待审数量；`memory_debug` 查看存储与后台诊断。

记忆写入失败时会返回错误，必要时附当前条目与用量，供模型修正同一批操作。前三次合并失败返回原始错误，第 4 次起返回 `done: true` 和停止重试提示。主模型的计数按会话、每轮重置；后台使用独立的本次复盘计数。该提示不是强制拒绝后续工具调用，后台模型循环仍受 16 次请求及超时限制。成功提交会清除失败计数，并明确提示不要重复保存；主模型工具调用后是否继续请求模型由 DSH 控制。

`memory_pending` 只允许模型列出提案。批准、丢弃必须由已登录用户在记忆面板执行，模型不能自行审批，后台复盘也不能访问审批工具。审批会重新验证完整原条目及身份；原条目变化后拒绝使用旧提案覆盖新内容。

## 配置后台复盘

通过 DSH 的配置界面或配置编辑服务修改 `hermes-memory` 条目。只关闭独立后台复盘、保留记忆工具和快照时，在该条目中合并以下配置：

```yaml
backgroundReview:
  enabled: false
```

完整默认配置示例（其中 `enabled: true` 会启用后台复盘）：

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
| `nudgeInterval` | 兼容旧配置名，现在表示后台复盘的用户回合周期，默认 10；未设置独立 interval 时，`0` 关闭周期触发 |
| `backgroundReview.interval` | 可覆盖 `nudgeInterval`；`0` 关闭周期触发 |
| `backgroundReview.enabled` | 默认 `true`；`false` 关闭自动复盘，主模型仍可保存记忆 |
| `backgroundReview.provider` / `model` | 一起设置以使用独立复盘模型；省略时继承本轮实际模型及参数 |
| `backgroundReview.maxIterations` | 默认 16；实际限定为 1–16，表示每次复盘最多模型请求数，不是工具调用数 |
| `backgroundReview.timeoutMs` | 后台模型循环总时间预算，默认 120000 毫秒（120 秒）；取消仍会等待已开始的写入落定 |
| `writeApproval` | `true` 时主模型写入也先进入待审队列；用户在面板上的直接编辑仍可保存 |
| `contentGuard` | 对新内容应用本地有界扫描，加载命中的旧条目只在提示中隐藏原文 |

指定其他复盘模型时，旧模型的 reasoning effort 和输出 token 上限不会强加给新模型，而采用目标适配器默认值。16 次上限约束插件的模型请求循环；宿主或模型适配器的内部网络重试由各自配置决定，不包含在这个计数中。每次复盘会发送触发时的对话文本和当前启用的记忆库；token 与费用取决于上下文长度、模型和实际请求次数。

后台出错不会让正常聊天失败。失败状态可见；同一触发轮次不会在重载后自动重跑，后续周期可再次尝试。已成功写入的内容不会因为后续请求失败而回滚。

### 面向扩展开发者的资源边界

“有界记忆”指两个经过整理的记忆库，不代表整个进程的内存、磁盘占用、token 或费用都有上限。集成时应区分以下边界：

| 资源 | 插件提供的边界 | 不在该边界内的部分 |
| --- | --- | --- |
| 记忆库正文 | 默认 `memoryCharLimit: 2200`、`userCharLimit: 1375`；按 Unicode 码点计数，包含条目分隔符；提交前验证最终批次 | 提示框架、工具 schema、对话证据和运行时元数据不计入这些预算。调低上限不会自动截断已有数据；仍可通过仅删除操作修复超限状态 |
| 复盘输入 | 调度器捕获触发时可用的全部派生 user、assistant、tool 消息中的文本；不设置输入大小上限，也不截断证据 | `runReview` 有可选的、仅拒绝不截断的 `maxInputChars` 参数，但自动调度器**没有**传入它，它也不是部署配置字段。该参数按序列化输入的 JavaScript 字符串长度（UTF-16 码元）计数，与记忆库的 Unicode 码点计数不同 |
| 并发复盘 | 每个会话最多一个活动复盘；该会话重叠的触发被跳过 | 不同会话之间没有插件级的总并发上限。串行写入队列不会串行化模型请求 |
| 请求数与时间 | 每次复盘最多 16 次模型请求，可调低；默认模型循环取消预算为 120 秒 | 这不是工具调用数、token、费用或端到端关闭耗时的硬上限。已开始的写入仍需等待落定；宿主和适配器的网络重试有各自的控制 |
| 模型上下文与输出 | 使用所选模型的有效请求配置 | 上下文窗口准入、输出 token 上限和供应商配额由宿主、模型适配器或供应商负责；记忆库预算与请求数上限并不保证这些限制 |

如果集成需要严格的资源上限，应在相应宿主边界定义输入准入、总并发及 token／费用策略，而不是假定记忆库预算已经提供这些约束。各自的实现契约见 [`lib/scheduler.js`](lib/scheduler.js)、[`lib/review.js`](lib/review.js) 和 [`lib/core.js`](lib/core.js)。本说明没有启用额外上限或自动截断。

## 保存与恢复

默认使用 DSH JSON KvUnit，文件位于 `~/.dsh/storages/hermes_memory.json`。v1 记录首次变化时写入 v2 原子全局快照：

```text
global: { format: 2, tables: { memory, user }, seqHighWater: { memory, user } }
```

原 v1 表保留为升级恢复副本，后续读取以 v2 快照为准。序号水位在删除与重载后仍然保留，防止旧提案误认新条目的身份；兼容没有水位的已有 v2 快照，并用保留的提案固定记录预留其身份。

`hermes_memory_runtime.json` 保存复盘认领、结果及待审提案。访问和恢复它之前必须先持有主存储，第二个插件实例不能只抢占元数据。重载发现未完成工作时标为中断；结果不确定的审批不自动重放。任何发布错误都会停止后续写入，需重载并检查。

### 选择存储保护

默认宿主 JSON 模式串行处理本插件写入，并拒绝同一 backend 实例的重复句柄。它**没有**跨进程锁和外部编辑检测。固定验证版本的 DSH JSON 后端只尝试一次 rename，没有 Windows 临时占用重试；插件不会重试整个 KvUnit 写入，因为报错时可能已发布。

原生静态安装可设置 **`storageRoot` 为存储目录的绝对路径**，选择插件自有、兼容 DSH 文件格式的保护后端。它为两个文件共用一个旁路租约，拒绝第二个遵守协议的写入者，在发布前检查两个文件的指纹，只对 Windows 的 `EPERM` / `EBUSY` / `EACCES` rename 错误进行有限退避重试；不会删除目标来强行替换。配置、能力边界和残留锁恢复见[存储保护与维护](docs/storage-safety.md)。

切换前停止所有旧写入者，并备份两个文件。`storageRoot` 直接选择插件自有目录，不猜测宿主私有配置。不要在相同文件上混用该后端与宿主 JSON 或旧版写入者，它们不遵守租约。动态沙箱保留宿主 JSON 行为，不能开启原生保护；诊断会明确当前模式。

### 压缩历史并导出降级副本

记忆面板提供「导出备份」和「压缩历史详情」。导出将当前记忆条目、完整存储元数据与由当前条目生成的 v1 JSON 文档分开，面向已登录 owner 包含关闭的记忆库，不会自动安装降级。也可用[离线维护命令](docs/storage-safety.md#offline-maintenance-and-downgrade)导出、先备份再压缩，或提取 v1 文档。

压缩移除较旧的已结束提案与复盘的完整载荷，保留身份、SHA-256 审计哈希、状态和逐会话认领轮次水位。待审、应用中和中断审批保留全部证据。面板默认只压缩 30 天前记录，并分别保留最近 100 条完整已结束历史；更新的记录及未决记录也会保留。API/CLI 可指定截止时间与完整历史数量。

这限制的是**符合压缩条件的旧详情**，不是不同会话标记的总数或总字节数。不会过期删除认领，也没有自动清理。运行时文件仍整份读取和重写，需要独立于记忆库预算监测。不要手工裁剪标记或结果不明的审批。恢复或降级前停止所有写入者，成对保留两个原文件；v1 无法直接读取 v2 的后续更新，应把导出的 v1 文档放进独立目录，不复制 v2 运行元数据，并保留原备份。

网页 API 使用 DSH owner 身份认证及 Host/Origin 检查，响应禁止缓存：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/hermes-memory/stats` | GET | ready、容量、后台状态 |
| `/hermes-memory/ops` | POST | 读取双库、直接编辑；list 包含待审提案与后台状态 |
| `/hermes-memory/pending` | GET / POST | 列出提案；批准或丢弃指定 id |
| `/hermes-memory/export` | GET | 下载当前条目、完整账簿和独立 v1 文档 |
| `/hermes-memory/compact` | POST | 按 `before` 与 `maxDetailed` 压缩已结束历史详情，保留防重放标记 |

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
| 文件锁、跨进程重读 | 默认仍为 DSH 单写入实例；原生 `storageRoot` 模式提供共用租约、发布前指纹检测及有限 Windows rename 重试 |
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

发布前使用[固定宿主严格检查](https://github.com/isheng-eqi/dsh-hermes-memory/blob/main/docs/host-release-verification.md)，要求指定 SHA、干净源码、完整构建以及全部测试通过、零跳过。普通 `npm test` 的通过不能代替这项证据。生成器支持 LF 与 Windows CRLF 检出，仍拒绝真正过期的动态镜像。

以下开发工具从本仓库的源码检出运行，不包含在插件安装包中：

- [固定 Hermes 离线样例](https://github.com/isheng-eqi/dsh-hermes-memory/blob/main/docs/upstream-compatibility.md)：10 个可追溯场景，比较选定行为；DSH JSON 与 Hermes Markdown 仍是不同磁盘格式，离线测试不监测最新上游。
- [合成记忆质量评分器](https://github.com/isheng-eqi/dsh-hermes-memory/blob/main/eval/memory-quality/README.md)：对已有输出评分，评分器回归通过不代表模型质量达标。
- [合成资源特征测量](https://github.com/isheng-eqi/dsh-hermes-memory/blob/main/docs/resource-characterization.md)：观察调度、复盘、存储调用及卸载；200 万 UTF-16 单元上限只覆盖全部阶段累计用户证据，不是完整请求或生产资源上限。

主对话新增 guidance 964 个 Unicode 字符；memory 工具说明与参数相较旧版约增加 51 字符。后台专用 review 提示 1477 字符，仅在复盘请求中发送。这是字符计数，实际 token 与费用取决于模型 tokenizer、对话长度及请求次数。

## License

MIT。Hermes 原始设计、提示与规则的归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。图标为本项目原创 SVG。
