# DSH 兼容修复与最新 Hermes 记忆机制对比

记录日期：2026-11-09（Asia/Shanghai）。目标版本：dsh-hermes-memory 1.2.0。

插件在 DSH 0.2.2-alpha.2 上存在已复现的槽位注册时序、面板错误状态和存储并发问题。匿名 HTTP 请求也能读取记忆接口，已接入宿主身份认证。本次改动保留用户已有的 `slots.inject` 修正，补齐整批提交、生命周期、空库冻结和 UI 回归。基于最新 Hermes 加入局部 patch、Unicode 预算和本地内容检查，保留旧 replace 和默认 target 的兼容性。所有测试仅使用合成数据和临时目录，实际记忆仅做只读计数与备份核对。

## 范围和基线

用户授权检查、修改并发布此插件，以及通过 Git 更新本机 Hermes 并比较其记忆机制。范围为插件仓库、对应 DSH 运行兼容性和本机 Hermes 更新；没有修改 DSH 实现源码，也没有变更其既有无关工作区文件。

| 项目 | 基线 |
| --- | --- |
| DSH | 0.2.2-alpha.2，`ce7073d512` |
| Node / npm | 24.22.2 / 11.19.1 |
| 插件原始提交 | `4c013d0c44adc9e4220117faf8813fb4f4e2551b`，工作树已有 slots.inject 修正 |
| npm 原发布 | 1.1.10；本地原包版本 1.1.11 |
| Hermes 更新前 | detached `3c27eb6234`，v0.20.0 |
| Hermes 核对的 upstream/main | `0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41`，2026-11-08 |
| Hermes 最新正式 release 基线 | v0.23.0，2026-11-05 |
| Hermes 更新后运行 | v0.23.0+1404.g0f0e96f，托管 Python 3.14.9，OpenAI SDK 2.54.0 |

Hermes 旧 HEAD 保留在本地 `backup/pre-update-20261109`，当前为跟踪 upstream/main 的 `local/upstream-20261109`。依赖通过官方 `pm.sync_venv(explicit=True)` 同步，Windows 命令通过 `expose_cli()` 修复，未使用裸 pip 改写托管环境。`pm doctor` 仍列出可选/托管工具未安装；本记录不将其视为所有功能已安装或全部 doctor 项通过。版本输出中的 carried-commits 元数据不作为版本新旧证据，以 Git SHA 和实际运行解释器为准。

## Evidence → Finding → Path

### 证据

下列记录均于 2026-11-09 观察。源码、测试和命令是可复现引用；日志为脱敏摘要，不含真实记忆或认证材料。历史故障在修复后不能通过当前主分支直接重现，对应测试保留合成故障条件。

| ID | source_type / source_ref | 观察摘要与复现命令 | content_hash / artifact_path |
| --- | --- | --- | --- |
| E-001 | file / [client regression](../tests/client.test.mjs) | 真实 SlotRegistry 未声明槽位时直接 register 抛错；inject 等待声明、owner 重载和卸载清理正常。`DSH_CLIENT_TEST_CHECKOUT` 指向 DSH 后运行 `node --test tests/client.test.mjs`。 | n/a；测试文件随 Git 保存 |
| E-002 | command / [host regression](../tests/host.test.mjs) | 两种 Host 的 12 路并发写、失败提交、v1/v2、重复序号、序号耗尽、初始化/写入中卸载、unknown-state、空库冻结与失败计数全部通过。`node --test tests/host.test.mjs`。 | n/a；合成内存后端 |
| E-003 | command / [real storage integration](../tests/storage.test.mjs) | 实际 DSH JSON backend 读取 v1，单次写入 v2，保留两库及旧表副本，关闭重开可读。设置 `DSH_CLIENT_TEST_CHECKOUT` 后运行 `node --test tests/storage.test.mjs`。 | n/a；临时目录测试结束清理 |
| E-004 | network / 原 DSH 实例的 memory HTTP route | 修改前匿名 stats/list 为 200；重载后匿名 stats 为 401，认证浏览器 stats 为 200 ready:true。第三方可在运行 DSH 后用不带 cookie 的 `curl -i http://127.0.0.1:3080/hermes-memory/stats` 验证 401。owner/origin/method 细节由 E-002 的合成请求覆盖。 | n/a；未保存响应中的记忆内容 |
| E-005 | manual / authenticated browser verification | 原 3080 页面刷新后入口与浮层正常。真实记忆只核对条数：16/6。随后拦截 ops 的所有请求，合成 list/write/read failure，lastGoodDataRetained、draftRetained、errorVisible 均 true；相关 pageErrors 为空。需本机 owner 正常认证才能独立重现；不要让失败测试写真实存储。 | n/a；浏览器核验的本地截图只含合成面板 |
| E-006 | command / [Hermes parity regression](../tests/hermes-parity.test.mjs) | patch 唯一片段、重叠/无变化拒绝、码点计数、内容检查、正常 ZWJ/ZWNJ、65K 空白资源预算通过。`node --test tests/hermes-parity.test.mjs`。默认 2190 空白输入从约 1 秒降到约 2 毫秒，65K 约 6 毫秒；时间为本机采样，不保证其他机器相同。 | n/a；合成内容 |
| E-007 | command / Hermes Git 与 runtime | `git rev-parse HEAD`、`hermes --version`、`python -c "import tools.memory_tool; import pm; print(pm.venv_is_current())"` 验证上述 SHA、Python 3.14.9、导入成功和 current:true；运行时命令须在 Hermes checkout。 | n/a；不涉及配置或凭据 |
| E-008 | file / 本机原 memory JSON 和升级前备份 | 重载前后 SHA-256 相等，真实记忆文件未被核验过程改写。复现：升级前备份并用 `Get-FileHash` 比较；备份包含私人记忆，只保留在本机，不进入 Git/npm。 | n/a；私人数据不随报告公开 |
| E-009 | command / npm auth and publish | 原 token 的 `npm whoami` 返回 E401；隔离配置的官方 web login 未完成；`npm publish --access public --registry=https://registry.npmjs.org` 在打包及测试通过后由 registry 返回 E404（无发布权限）。发布前 registry version 为 1.1.10。后续发布成功与否以 npm registry 实际结果为准，Git tag 不表示 npm 已发布。 | n/a；不记录认证材料 |

### 结论与修复

| ID | severity / category / status | evidence_ids | 位置、影响与 remediation | confidence |
| --- | --- | --- | --- | --- |
| F-001 | medium / design / validated | E-001, E-005 | [lib/client.js](../lib/client.js) 的 slot 必须等声明。保留用户 inject 修正，显式依赖 slots，样式归 ctx.effect 生命周期。 | high |
| F-002 | high / design / validated | E-002, E-003 | [lib/index.js](../lib/index.js)、[host.js](../host.js)：逐记录串行不足以保护读改写；整批排队和一次 setGlobal 后再发布缓存，禁止身份冲突/溢出和句柄抢占。 | high |
| F-003 | high / misconfig / validated | E-004 | 记忆路由缺宿主身份校验可暴露和修改敏感记忆。接入 connection.requestRejection、方法约束和 no-store；没有认证服务时拒绝访问。 | high |
| F-004 | medium / design / validated | E-001, E-005 | HTTP500/业务错误曾被当作列表，草稿提前清除，旧响应覆盖新请求。修复响应验证、错误/加载/重试、最后成功数据、写锁和请求 epoch。 | high |
| F-005 | medium / design / validated | E-002, E-006 | 空库未冻结、失败次数跨 step 重置、失败调用压制 nudge、emoji 双倍预算。补 marker、按回合计失败、成功提交记录和码点计数。 | high |
| F-006 | medium / design / validated | E-006 | 新扫描规则初稿对空白超线性回溯并误拦 ZWJ。限定遍历长度、折叠横向空白、允许语言 joiner，并加入性能与合法文本测试。 | high |

### P-001：运行兼容与持久化调用路径

- path_type: callflow
- start: 模型 memory 工具或认证网页操作
- goal: 一批验证通过后持久保存，并在失败时保留旧数据和草稿
- steps:
  1. 网页等待 slot 声明；读取或操作经 owner 身份与来源校验。evidence: E-001/E-004；finding: F-001/F-003。
  2. 校验参数，整批加入唯一写链，复制当前条目并应用 patch/replace/remove/add。evidence: E-002；finding: F-002。
  3. 检查预算、内容和身份，通过一次 v2 global 写入后更新缓存。evidence: E-002/E-003/E-006；finding: F-002/F-006。
  4. UI 仅成功时清草稿；失败保留最后成功列表。新会话在 ready 后捕获一次包括空库的快照。evidence: E-002/E-005；finding: F-004/F-005。
- residual_risks: 扫描为启发式且允许关闭；不支持多进程共写与在线手改合并；v2 降级需恢复备份。

## 与上游的机制对比

对应上游固定 SHA 的关键实现：

- [memory_tool_store.py](https://github.com/NousResearch/hermes-agent/blob/0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41/tools/memory_tool_store.py)：冻结 load snapshot；写入锁内重读、原子替换；Python len 字符预算；patch 唯一片段；写入与加载扫描。
- [memory_tool.py](https://github.com/NousResearch/hermes-agent/blob/0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41/tools/memory_tool.py)：add/patch/remove/batch，显式 target、分库 enabled、可选写审批。
- [threat_patterns.py](https://github.com/NousResearch/hermes-agent/blob/0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41/tools/threat_patterns.py)：分 scope 的有界确定性规则；插件为适配版本，调整语言 joiner、误报与资源边界，并附 MIT 归属。
- [memory_manager.py](https://github.com/NousResearch/hermes-agent/blob/0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41/agent/memory_manager.py)：外部 provider 的异步生命周期；不同于核心双库，不加入此次默认功能。

本插件保留两库与预算、去重、冻结快照和手工策展，新增与上游接近的 patch、码点计数、写入检查和提示占位。为兼容既有工具和面板，replace 仍表示整条替换，target 仍默认 memory，允许明确批量清空，两库始终启用。未集成可选审批、session_search、外部 provider、后台 LLM 复盘；这些差异不是逐行为兼容声明。

DSH 通过 durable user 消息注入，Hermes 则构建系统提示词。DSH JSON backend 保证单次文件写的原子性，插件进一步将多操作合成一次写；这不能替代跨进程文件锁或外部修改检测。

## 验证和升级

```powershell
$env:DSH_CLIENT_TEST_CHECKOUT='C:\Users\HI\deepseek-harness'
npm test
npm pack --dry-run
```

当前全量结果为 **85 tests / 85 pass / 0 fail / 0 skip**。没有变量时两项实际 DSH 依赖的测试会跳过，不能把这种运行称为完整兼容验证。动态 Host 在独立 VM realm 中运行测试，未提供 Buffer/process/import；UTF-8 流解码只使用 sandbox 允许的 TextEncoder/TextDecoder。

第一次变更写入 v2，纯读取不会迁移。两库同时存在一个 global singleton 中，旧 v1 tables 不再接收更新；降级应停用插件，恢复升级前备份，再启用旧版本。不要直接删除 global 试图回退，否则会读到旧表恢复副本。`unknown-state` 表示底层无法判定结果，需要重载后读盘确认，不要在同一实例重试并声称成功。

本机验证期间由 [DSH plugin manager](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d512/packages/boot/plugin-manager) 定向停用/启用 hermes-memory，未重启承载当前会话的 DSH。浏览器核验曾用宿主生成的临时认证入口，临时文件与核验代码已移除，不包含在发行包。
