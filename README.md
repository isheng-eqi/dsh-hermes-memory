# dsh-hermes-memory

Persistent dual-bank memory and a web panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), inspired by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

为 DSH 提供两个独立记忆库：`memory`（稳定的环境事实、项目约定）和 `user`（用户偏好与工作习惯）。模型通过 `memory` 工具维护记忆；每个会话读取一次冻结快照；网页面板可以直接查看、添加、修改和删除。插件自身不发起额外 LLM 请求，无外部运行时依赖；工具描述、快照和提醒仍会占用提示 token。

> **1.2.0 升级说明：**第一次实际写入会将旧 v1 数据迁移为 v2 单次原子提交格式。升级前备份 `~/.dsh/storages/hermes_memory.json`。旧表保留为迁移恢复副本，v2 全局快照才是后续写入的权威数据；降级必须恢复备份，旧版插件不能读取 v2 更新。网页接口要求当前 DSH 的 owner 身份认证服务；缺少该服务时面板返回 503，工具仍可独立使用。

## 安装

```sh
dsh plugin --profile web add dsh-hermes-memory
# 或从 GitHub 安装
dsh plugin --profile web add github:isheng-eqi/dsh-hermes-memory
```

安装后在 DSH 原网页刷新一次，侧边栏底部出现「记忆」入口。插件为所有会话提供 `memory`、`memory_search`、`memory_list`、`memory_stats` 和 `memory_debug`。

验证基线为 DSH **0.2.2-alpha.2**（`ce7073d512`）、Node **24.22.2**。宿主 peer 声明为 Cordis 4.x、dsh-tools `>=0.1.0-rc.6 <0.3.0-0`、Schemastery 3.x；peer 范围只表示可组合依赖，不能代替运行验证。

客户端使用 `slots.inject()` 等待 `sidebar.footer.action` 和 `shell.overlay` 的声明，再注册入口与浮层。当前 DSH 仍有此 API；直接抢先 `slots.register()` 会因槽位尚未声明而失败。网页错误、加载中和空库分别展示；失败保留草稿、编辑内容及最后成功快照，并提供重试。

### 没有存储的 profile

Web bundle 自带 `storage`、`storage-json`、`storage-domain`，本插件不重复声明这些行。Headless/TUI 或 base-only profile 需要在自己的配置补充：

```yaml
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

无 JSON 后端时，工具返回存储不可用；不会把读取失败显示成空库或覆盖已有数据。

### 动态插件

也可通过 DSH `cordis_define` / `cordis_run` 使用 [host.js](host.js) 与 [client.js](client.js)。动态插件提供统计 Run 卡，随进程退出而卸载，持久数据保留。动态形态使用硬编码默认预算、提醒间隔和内容检查；需要配置时使用 bundle。

**静态 bundle 与动态实例共用同名存储单元，只能启用一个写入实例。**重复打开时拒绝接管其他实例的句柄。不要用多个 DSH 进程同时写同一个存储目录，也不要在进程运行时手改文件：插件写队列保证单实例内的并发，未提供跨进程 CAS/合并。

## 使用工具

默认 `memory` 库预算 **2200** 字符，`user` 库 **1375** 字符，条目以 `\n§\n` 分隔并计入预算。按 Unicode 码点计数，与 Python `len()` 一致；单个 `😀` 计 1，组合字符按各自码点计数。

| 参数 | 说明 |
| --- | --- |
| `action` | `add`、`patch`、`replace`、`remove` 或 `batch`，必填 |
| `target` | `memory` 或 `user`；为兼容旧版默认 `memory` |
| `content` | add 的完整条目、patch 的新片段、replace 的完整替换条目 |
| `oldText` | patch 的精确片段；replace/remove 用于定位条目的文本 |
| `operations` | batch 的操作数组，每项支持 add/patch/replace/remove |

```json
{"action":"add","target":"memory","content":"项目使用 Node 24。"}
```

```json
{"action":"patch","target":"memory","oldText":"Node 24","content":"Node 26"}
```

`patch` 保留同条目中的其他事实，只修改唯一的一处文本；重复片段、多个条目命中或无变化会报错。`replace` 保留旧版整条替换语义，面板编辑也使用它。定位时先精确匹配整个条目，再回退唯一子串；不确定时先调用 `memory_list`。

```json
{"action":"batch","target":"memory","operations":[{"action":"remove","oldText":"项目使用 Node 26。"},{"action":"add","content":"项目已迁移到 Node 28。"}]}
```

批操作先在副本上验证最终预算，再一次性提交两个库的完整快照。任一操作失败或持久化失败，不发布新内存状态；可在同一批次腾出空间再新增。每个模型回合超过 3 次合并失败会收到停止重试提示；UI 失败不参与该上限。重复 add 去重。

`memory_search` 为本地确定性关键词检索，不访问模型或向量服务。`memory_list` 列出当前数据；`memory_stats` 显示预算；`memory_debug` 只报告存储句柄和加载状态。

## 冻结快照与内容检查

首个可执行模型步骤等待存储初始化与已有写入，再把记忆注入带插件 source 的 durable user 消息。空库也记录已冻结标记：会话中新增记忆不会改变该会话已注入的前缀，新会话读取更新后的内容。每 10 轮未成功保存时可提醒一次；提示只是建议，不会启动后台模型复盘。

默认内容检查参考 Hermes 的确定性 threat patterns，限制扫描长度、规范化 NFKC，检查常见指令注入和秘密外传特征；允许正常 ZWJ emoji 与自然语言。新写入命中时整批拒绝；磁盘已有条目命中时仅在提示快照中显示占位符，原文保留在面板供查看、编辑和删除。标签转义保护提示框架。

这些规则是启发式检查，可能漏报或误报，不构成完整的提示注入防护。静态配置可用 `contentGuard: false` 关闭，动态默认开启。

### 配置

在 profile 对 `hermes-memory` 条目合并配置：

```yaml
- id: hermes-memory
  config:
    memoryCharLimit: 2200
    userCharLimit: 1375
    nudgeInterval: 10
    contentGuard: true
```

`nudgeInterval: 0` 关闭提醒。字符上限不会自动淘汰条目；调低预算后仍允许列出旧数据，再用批操作压缩。

## 持久化与网页接口

存储位置为 `~/.dsh/storages/hermes_memory.json`，由 DSH storage hub 的 JSON KvUnit 管理。插件读取 v1 表结构，首次变化写入 v2 `global: {format:2,tables:{memory,user}}`；旧表作为恢复副本保留。每批仅一次 `setGlobal`，成功后才更新缓存；重复身份或损坏数据拒绝加载。写入返回 `unknown-state` 后拒绝继续操作，重新加载插件才能恢复判断。

卸载会等待初始化及已执行写链完成，然后关闭自己拥有的句柄。另一个实例的句柄不会被强制关闭。

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/hermes-memory/stats` | GET | 统计与 ready 状态 |
| `/hermes-memory/ops` | POST | list/add/patch/replace/remove/batch |

接口复用 DSH `connection.requestRejection()`：要求 owner 登录，校验 Host/Origin，响应禁止缓存。401 表示重新打开 DSH 的认证入口；403 表示来源不可信；503 表示认证服务不可用，或统计接口暂时无法读取存储；操作接口的存储异常返回 500。POST 要求 JSON 对象和合法 bank。浏览器代码检查 HTTP 状态、业务失败和响应结构，失败不显示为成功空库。

## 与最新 Hermes 的对应关系

本次核对上游 `NousResearch/hermes-agent` **`0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41`**（2026-11-08；release 基线 v0.23.0），细节见 [对比与验证记录](docs/2026-11-09_compatibility-and-hermes-report.md)。

| 机制 | 本插件 |
| --- | --- |
| 双库、字符预算、手工策展 | 保留，使用 DSH 原生 JSON 持久化 |
| 冻结快照、唯一片段 patch、Unicode 字符计数 | 已实现，并兼容旧 replace |
| 写入检查与加载后提示占位 | 本地规则适配，非上游扫描器的逐行为等价实现 |
| 文件锁、重读外部修改 | 使用单实例写队列及 storage hub；不提供跨进程合并 |
| 两库独立 enabled 开关、显式必填 target | 保留旧插件两库常开、target 默认 memory |
| 禁止 consolidation 清空原非空库 | 插件允许用户明确 remove/batch 清空 |
| 可选写入审批、session_search、外部 provider | 未集成 |
| 自动后台复盘、LLM extraction | 不默认引入；插件自身不增加 LLM 调用 |

## 开发验证

```sh
npm install
npm test
npm pack --dry-run
```

默认测试覆盖纯函数、两套 Host、客户端错误/竞态和迁移；额外两项真实 DSH 测试需要指定本机 checkout：

```powershell
$env:DSH_CLIENT_TEST_CHECKOUT='C:\Users\HI\deepseek-harness'
npm test
```

测试只使用临时目录和合成数据，不改真实记忆。修改 [lib/core.js](lib/core.js) 或 [lib/index.js](lib/index.js) 时同步 [host.js](host.js)，两套客户端各有覆盖。

## License

MIT。内容检查部分参考 NousResearch/hermes-agent 的 MIT 实现，归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
