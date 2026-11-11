# Hermes 内置记忆适配与验证记录

记录日期：2026-11-11，Asia/Shanghai。插件版本：2.0.0。Hermes 固定基线：[`c0c4357744d1a6994d332b826aea4c77fcccaf38`](https://github.com/NousResearch/hermes-agent/tree/c0c4357744d1a6994d332b826aea4c77fcccaf38)。

双库、冻结快照、原子批量操作和周期后台复盘已实现，并在当前 DSH Web profile 验证。最终回归 **149 项通过，0 失败，0 跳过**；真实模型验证完成两次请求并向隔离临时库保存一条合成事实。真实用户记忆未用于写入测试。

当前安装使用源码目录链接，模块 watcher 已热更新，原网页刷新后功能可用。插件管理器另有 `package-moved` 导致的 profile 整体 `restart-required`；本记录不将其称为管理器已成功整体应用，也不为消除此提示强制重启正在使用的宿主。

## 实现行为

- MEMORY 与 USER 独立开关，默认分别为 2200、1375 个 Unicode 码点，分隔符计入预算。
- `memory` 对模型要求明确的 `target` 和 `operations`；支持 add、唯一片段 patch、remove。整批验证最终预算后一次发布，不留下部分批次。
- 首次进入会话时注入冻结快照，包括空库标记；新会话读取最新磁盘状态，`memory_list` 可读取即时状态。
- 默认每 10 个真实用户回合，在成功的最终答复后执行后台复盘。自动继续、工具循环、普通子代理不推进这一触发逻辑；失败、取消、空答复或未完成工具调用不触发。
- 复盘通过独立 `llm.prepareCall` 循环运行，只提供 `memory`、`memory_list`，最多 16 次请求。默认继承本轮实际模型配置；明确换路由时不继承旧模型的 reasoning effort 和输出上限。
- 后台新增可保存，修改或删除旧条目先创建持久提案。模型只能列出提案；已登录用户通过记忆面板批准或丢弃。批准前重新核对完整旧条目和身份，旧提案不能覆盖期间发生的变化。
- 调度在计费前等待公开的会话 flush 屏障；单轮触发与结果持久保存，重载不自动重跑同一轮。运行状态区分 running、完成、失败、中断和不可用。
- 主记忆继续使用原 KvUnit；运行记录与提案使用独立 KvUnit，不污染主会话。插件卸载先取消并排空后台任务，再关闭存储。
- 任何存储发布异常都按“落盘结果不确定”处理，停止后续写入，重新打开后读取磁盘事实。v1 原表保留，v2 全局快照为当前读取依据。

条目数并非健康指标：复盘可以判定没有值得长期保存的内容，也可能提出合并。自动复盘会产生额外模型请求。

## 证据与结论

| 证据 | 可复现来源 | 结果与支持的结论 |
| --- | --- | --- |
| E1 | [完整后台链路测试](../tests/background-e2e.test.mjs) | 使用真实 DSH Session、projection、timer、LlmRuntime、JSON storage 与 Zstandard 会话后端；第 10 用户回合触发隔离适配器，两次请求写一条事实。关闭、重开后新会话可读取，原会话快照和聊天记录不变。 |
| E2 | [v4 持久化测试](../tests/v4-persistence.test.mjs) | 静态/动态 × 普通 JSONL/Zstandard 四种组合均实际写入、关闭并重新打开；消息来源通过真实 v4 编码。 |
| E3 | [宿主测试](../tests/host.test.mjs)、[模型循环测试](../tests/review.test.mjs)、[真实 JSON 存储测试](../tests/storage.test.mjs) | 覆盖并发顺序、批次回滚、发布后 EIO、恢复、提案过期、认证、取消排空、路由继承、流结束前禁止写入和 16 次请求限制。 |
| E4 | [协议测试](../tests/memory-contract.test.mjs)、[Session projection 测试](../tests/session-projection.test.mjs)、[客户端测试](../tests/client.test.mjs) | 真实工具 schema 编译通过；恢复/seed/fork、冻结快照、错误显示、草稿保留、重复操作与卸载生命周期通过。 |
| E5 | [真实模型验证脚本](../scripts/live-review-smoke.mjs) | 本次显式启用后使用当前模型路由，结果 completed、iterations=2、writes=1、pending=0、toolCalls=1；只挂载临时合成库，无真实会话或用户记忆写入接口。 |
| E6 | 当前原网页刷新后的浏览器核验 | 记忆入口唯一；stats/pending 均 HTTP 200；ready=true、后台 idle/enabled/interval=10、无浏览器 pageerror。插件页显示中文标题与描述，SVG 图标完成加载。 |
| E7 | 运行时 `memory_debug` 与工具 schema | 固定上游 SHA 正确；双库启用、存储已就绪、无存储或 runtime 错误；`memory_pending` 仅暴露 list。 |
| E8 | `npm run build:host`、`npm test`、`git diff --check` | 动态镜像与共享模块一致；最终 149/149 通过；无补丁空白错误。测试中的存储报错日志来自预期故障注入。 |
| E9 | [关闭库后的待审隔离测试](../tests/host.test.mjs) | 发布复核发现并修复：关闭某库后，模型不能从旧待审提案的操作、原文 pin 或数量中读取该库的提案；已登录用户仍能管理全部提案。覆盖 MEMORY/USER 双向关闭、双库关闭、重载和磁盘数据不变。 |

E1–E4、E8 共同验证触发、受限模型调用、写入、落盘与恢复链路；E5 验证当前真实模型服务接受同一复盘协议；E6–E7 验证当前安装实际提供功能。没有把真实用户对话强行推进到触发周期以制造一条实际记忆。

最终源码状态再次核对时，全新浏览器使用先前日志中的启动链接访问首页得到 HTTP 401，未进入应用，因此未再重复完整点击验收；没有将这次超时算作成功。此前 E6 的成功证据保留。随后通过现有已认证页面的公开 Client Inspect，确认 `sidebar.footer.action` 的 `hermes-memory` 与 `shell.overlay` 的 `hermes-memory-panel` 均为 active；宿主诊断仍显示存储就绪、后台 idle 且无错误。该登录限制与插件后台测试结果分开记录。

## 调用路径

正常用户回合完成 → projection 确认有效答复和第 10 回合 → 捕获当时已接纳的上下文 → 等待会话持久化 → 持久认领该触发 → 受限模型复盘 → 原子新增或持久待审提案 → 记录结果。新会话从最新记忆创建快照。

修改/删除路径：复盘生成提案 → 已登录用户打开面板 → 批准时核对完整原条目与序号 → 原子提交。中断或不确定的审批不自动重放。

## 本机复现

在插件源码目录运行。需要已构建的 DSH checkout 及 Node 24，以覆盖当前 Zstandard 后端：

```powershell
$env:DSH_CLIENT_TEST_CHECKOUT=Join-Path $env:USERPROFILE 'deepseek-harness'
node --version
npm run build:host
npm test
git diff --check
```

未设置 `DSH_CLIENT_TEST_CHECKOUT` 时，真实 DSH 集成用例会跳过，不能把那种运行视为本记录的完整验证。

真实模型验证默认不发请求。以下命令明确启用两次请求上限，使用当前 profile 中已有路由和凭据引用，只写临时合成库；会消耗模型额度。该脚本为源码诊断工具，不包含在 npm 发行文件中。

```powershell
$env:HERMES_LIVE_REVIEW_SMOKE='1'
$env:HERMES_SMOKE_ITERATIONS='2'
node scripts/live-review-smoke.mjs
```

本次运行的适配器使用统计为 inputTokens=5366、outputTokens=100、cacheReadTokens=5120、totalTokens=10586。保留适配器原始口径，不将缓存统计简单相加当作实际收费。主 guidance 为 964 个码点，后台 review 提示为 1497 个码点；字符数不是 token 数。

## 当前环境与数据边界

验证环境为 DSH 0.2.2-alpha.2、Node 24.22.2，现有 Web 服务使用本机端口。未启动替代服务器，未强杀宿主，未修改 DSH 核心源码。本记录为 2.0.0 发布前验证；公开发布状态以 npm 版本页和 GitHub Release 为准。

浏览器脱敏证据保存在本机工作区 `hermes-memory-verification-20261111`，包括 `live-gui.json`、仅后台状态截图与插件元数据截图；不含记忆原文或认证 URL。真实模型结果保存在单独临时目录。

实际记忆只做只读状态核对，测试内容全部写入隔离临时库。任务期间其他会话可以正常改变记忆，因此不声称整个任务期间的文件字节完全不变，也未恢复旧快照。私人记忆原文、内容指纹和认证材料不进入公开发行物。

## 与 Hermes 原生仍有的差异

| 范围 | 当前边界 |
| --- | --- |
| 后台 agent | 使用隔离模型循环，不创建完整新 Agent/Session；工具权限更窄。 |
| 内容扫描 | 本地有界启发式扫描，未实现官方完整严格扫描器，可能漏报或误报。 |
| 多进程 | DSH 宿主内单写入实例和串行队列；没有 Hermes 原生跨进程文件锁，禁止多进程同时写同目录。 |
| 动态 VM | 当前宿主无原生 AbortController；后台明确 unavailable。完整后台能力使用已安装静态 bundle。 |
| 主会话 fork | DSH 从继承历史重建用户回合计数，保留父会话计数；与新建 Hermes agent 从零开始有差异。 |
| 外部能力 | 未新增外部记忆 provider、自动技能维护或原生 session_search；聊天检索使用宿主现有能力。 |
| 安装管理器 | 当前 Hermes 模块已热更新并实际可用；profile 整体另有无关包路径变更要求重启重组，尚不宣称该状态已清除。 |

使用方式、参数和恢复规则见 [README](../README.md)。上述范围内的内置记忆机制已完成实现与验证；本记录不宣称所有 Hermes 周边功能逐项完全等价。
