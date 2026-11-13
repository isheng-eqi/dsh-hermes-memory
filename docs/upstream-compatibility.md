# 运行固定 Hermes 子集的离线契约测试

这组测试检查 DSH 适配器与已审阅 Hermes 基线的少量共同语义，不代表完整 Hermes 兼容性。基线固定为 [`c0c4357744d1a6994d332b826aea4c77fcccaf38`](https://github.com/NousResearch/hermes-agent/tree/c0c4357744d1a6994d332b826aea4c77fcccaf38)，没有跟随 `main` 或 `latest`。

**存储边界：DSH 使用自己的 v2 JSON KV 格式。** 测试中的 `format: 2`、`tables`、条目序号和时间戳属于 DSH；Hermes 在该基线使用 `MEMORY.md` / `USER.md`。共同使用 `\n§\n` 计算条目预算，不等于两种磁盘格式互通。本测试不导入、导出或解析 Hermes 磁盘文件。

## 运行测试

在本仓库根目录使用 Node 24；依赖已安装时，下面的测试命令完全离线，不需要 Python、Hermes checkout、模型凭据或 DSH 服务：

```powershell
node --test tests/upstream-compatibility.test.mjs
```

首次安装锁定的开发依赖需要网络或本地 npm 缓存：

```powershell
npm ci --ignore-scripts
node --test tests/upstream-compatibility.test.mjs tests/hermes-parity.test.mjs tests/memory-contract.test.mjs tests/host.test.mjs tests/storage.test.mjs
```

`tests/storage.test.mjs` 中的真实 DSH 后端集成测试仍要求设置 `DSH_CLIENT_TEST_CHECKOUT`；未设置时会跳过，不能计入真实后端验证。新增离线文件本身不依赖该环境变量，也没有跳过分支。现有 `npm test` 会自动包含新增的 `.test.mjs` 文件，无需增加脚本或依赖。

## 输入、预期与来源

[JSON fixture](../tests/fixtures/hermes-memory-c0c43577.json) 保存完整 SHA、获取日期、五个源文件的原始 HTTP 响应字节 SHA-256、来源函数、适配说明、输入和预期条目。上游文件于 2026-11-13 从固定 SHA 的 GitHub raw URL 获取并读取；测试案例的 MIT 归属见 [第三方声明](../THIRD_PARTY_NOTICES.md)。未把整个上游测试文件复制进仓库。

每个场景都标记 `upstream-test` 的实际文件/函数；新增或变形的边界输入另外标记 `implementation-derived` 和对应实现符号，避免把自行推导的输入说成上游原有测试数据。特别是 Unicode 预算、调整操作顺序后的最终预算、以及 typography 定位后 patch 的精确片段检查，均包含这种显式适配。

| 场景 | 固定基线中的测试函数 | 检查内容 |
| --- | --- | --- |
| `default-bank-limits` | `TestMemoryStoreAdd.test_add_entry`，加 `MemoryStore.__init__` | 原有双库 add 示例；不覆盖配置，核对默认 2200 / 1375 预算与实际 usage。 |
| `unicode-delimiter-budget` | `TestMemoryStoreAdd.test_overflow_returns_consolidation_context`，加 `_char_count` / `_batch` | 新输入 `😀` 和 `e` + U+0301：码点数 1 + 2，加三字符分隔符后恰为 6；再加 `中` 拒绝且不写入。 |
| `patch-unique-span-preserves-sibling-facts` | `TestPatchStoreLevel.test_patch_rejects_a_span_repeated_within_the_entry` | 重复 `tea` 拒绝；扩大上下文只改丈夫的茶，保留妻子的事实。 |
| `patch-span-whitespace` | `test_patch_spans_keep_their_whitespace` | 合并上游两个参数行，保留 `tea ` / `coffee ` 及 `New ` 的尾部空白。 |
| `patch-overlapping-repeat` | `test_patch_rejects_an_overlapping_repeat` | `1000` 中的 `00` 有两个重叠匹配，拒绝写入。 |
| `patch-requires-exact-stored-span` | `TestMemoryStoreReplace.test_layout_and_retyped_typography_match_but_punctuation_never_does`，加 `_locate` / `_patch_entry` | 把上游 typography 定位样例用于 patch；宽松定位不授权替换不存在的字面片段。 |
| `batch-budget-checked-only-at-end` | `TestMemoryBatch.test_batch_add_and_remove_atomic`，加 `_batch` | 将新增调到删除之前：中间状态 42 码点超限，最终 18 / 25 可提交；另一库不变。 |
| `batch-final-failure-preserves-medium` | `TestBatchRefusesToEmptyNonEmptyStore.test_batch_removing_last_entry_is_refused_and_preserves_disk` | 两个 remove 均能定位，但最终清空被拒绝；序列化 medium 与提交次数均不变。 |
| `missing-target-rejected-then-corrected` | `test_missing_target_can_be_corrected_without_writing_to_the_other_store` | 缺失 target 拒绝，补全 user target 后只写 USER 库。 |
| `session-snapshot-remains-frozen` | `TestMemoryStoreSnapshot.test_snapshot_frozen_at_load` | 原会话快照不随写入更新，新会话读取提交后的条目。 |

上游原文：[`tools/memory_tool_store.py`](https://github.com/NousResearch/hermes-agent/blob/c0c4357744d1a6994d332b826aea4c77fcccaf38/tools/memory_tool_store.py)、[`test_memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/c0c4357744d1a6994d332b826aea4c77fcccaf38/tests/tools/test_memory_tool.py)、[`test_memory_patch_action.py`](https://github.com/NousResearch/hermes-agent/blob/c0c4357744d1a6994d332b826aea4c77fcccaf38/tests/tools/test_memory_patch_action.py)、[`test_memory_target_contract.py`](https://github.com/NousResearch/hermes-agent/blob/c0c4357744d1a6994d332b826aea4c77fcccaf38/tests/tools/test_memory_target_contract.py)、[`LICENSE`](https://github.com/NousResearch/hermes-agent/blob/c0c4357744d1a6994d332b826aea4c77fcccaf38/LICENSE)。

## 测试能证明什么

[Node 测试](../tests/upstream-compatibility.test.mjs) 调用真实 `lib/index.js` 注册的公开工具，不在测试中重写 patch、预算验证或批次提交算法。测试自己的 KV backend 只把状态序列化为 JSON 字符串，用来观察提交边界；Session/projection 使用已有宿主 fixture。

每次调用核对真实工具结果、两库条目、累计 KV 提交次数与参数未被修改。失败调用额外比较序列化 medium 的前后字节；成功调用检查终止结果。每个场景关闭再重开插件读取同一 medium，避免仅凭进程中的 live state 宣称已保存。Unicode 案例还有字面分隔符和明确字符数断言；默认预算通过公开 usage 输出核对。

因此，来源文件和函数 → fixture 输入及预期 → 真实 DSH 工具调用 → medium / 重开读取构成可复现的证据链。测试通过表示这些固定子集未发生回归；SHA 检查只是防止悄悄换基线，不能代替行为断言。

以下范围未由本 fixture 实现或证明：Hermes Markdown 解析、BOM / 文件权限、跨进程锁、外部手改文件漂移与备份、完整威胁扫描器、所有审批和后台审查路径、全部匹配折叠规则、所有报错字段和措辞、动态 `host.js` 镜像及真实 JSON 后端的物理落盘。这些内容应查看现有专项测试和实现说明，不能从本 fixture 外推。

已知适配差异也保留：缺失必填 target 在 DSH 公开 schema 层抛出 `INVALID_ARGS`；Hermes 对应测试收到错误结果。DSH 失败批次可以带 `currentEntries`，而该上游基线的一些批次失败不回显 `current_entries`。fixture 比较声明的成功/失败和状态效果，不宣称响应对象逐字段相同。Hermes 在 `load_from_disk` 冻结 snapshot；DSH 在首次会话注入并接纳消息时冻结，测试核对各自生命周期中的共同效果。

## 显式复核或升级基线

**离线 fixture 不会发现最新上游，也不会运行 Python 上游测试。** 上游新增 bugfix 或测试不会自动进入本仓库。`lib/prompts.js` 的 SHA 与 fixture 不一致会使测试失败，但两者同时被随意修改仍不能证明新基线兼容。

复核当前固定来源时，维护者可显式执行下面的联网命令。它只下载到内存并验证来源哈希；运行时测试不会执行它：

```powershell
$fixture = Get-Content -Raw -Encoding utf8 'tests/fixtures/hermes-memory-c0c43577.json' | ConvertFrom-Json
$root = 'https://raw.githubusercontent.com/NousResearch/hermes-agent'
$reviewSources = @{}
foreach ($source in $fixture.upstream.sources) {
    $url = "$root/$($fixture.upstream.commit)/$($source.path)"
    $response = Invoke-WebRequest -Uri $url
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $response.RawContentStream.Position = 0
        $hash = [BitConverter]::ToString($hasher.ComputeHash($response.RawContentStream)).Replace('-', '').ToLowerInvariant()
        if ($hash -ne $source.sha256) { throw "Source hash differs: $($source.path)" }
        $reviewSources[$source.path] = $response.Content
    } finally {
        $hasher.Dispose()
    }
}
$reviewSources['tests/tools/test_memory_patch_action.py']
```

升级必须是一次明确的人工审查变更：

1. 选择候选完整 commit SHA，通过固定 URL 读取上述实现、三份测试和许可证；与当前基线逐个比较选定函数及其参数行，复查默认限额、字符计数、patch 和失败写入边界。不要自动追踪分支头。
2. 在有上游 Python 环境时显式运行对应 pytest 用例；若未运行，记录“只读源码对照”，不要称为跨运行时差分验证。当前 fixture 的预期来自已读取的上游断言与实现语义，并非自动执行 Hermes 得到的输出。
3. 按新 SHA 更新 fixture 的出处、获取日期、原始字节哈希、输入和预期；实际测试函数变化时更新映射和文档。源码推导探针继续单独标记。由独立的实现审查决定是否调整运行时基线及行为，不能为使测试通过而只改 SHA。
4. 执行离线测试和现有相关回归，检查第三方归属；将有意的适配差异写清楚。后续若增加在线检查，应作为独立、显式命令，不放进离线测试，也不自动覆盖预期。
