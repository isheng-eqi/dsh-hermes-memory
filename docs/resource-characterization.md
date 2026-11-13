# 合成资源特征测量

运行 `node scripts/characterize-resources.mjs` 可获得 JSON 报告。无需宿主、模型凭据或网络；不会读取用户配置或写入磁盘。可调整 `--sessions=8 --rounds=3 --evidenceChars=4096`，分别限制为 1–32、1–20、1–16384 的整数。

预算限制是**全部阶段累计进入复盘请求的用户证据 UTF-16 代码单元数**，最多 2,000,000。`evidenceChars` 是每轮新增的 `x` 文本长度；同一会话第 r 轮复盘会再次读取前 r 轮证据，所以并发阶段使用三角和，而非只数新增文本。设 S 为会话数、R 为轮数、E 为每轮长度，总量为：

```text
E × [1 + S × R × (R + 1) / 2 + S]
     基线       并发历史重放          卸载
```

默认总量为 233,472；`--sessions=32 --rounds=20 --evidenceChars=296` 为 1,998,888，可运行；长度改为 297 就会拒绝。此预算不包含助手文本、JSON 包装、工具定义和系统提示，也不是字节数或 token 数。报告的 `totalReviewEvidenceUtf16Units` 和逐阶段 `reviewEvidenceUtf16Units` 对应此预算；`messageInputUtf16Units` 另行累计 `JSON.stringify(input.messages).length`，包含传入提供方的消息包装与助手证据，但不含系统提示和工具定义。

三个阶段分别测量单会话基线、多会话并发与复盘运行中卸载。使用真实插件的调度器、复盘循环和存储调用路径，但会话、模型和内存存储后端均为合成替身。它测量运行时元数据保留，不评估真实模型质量或磁盘持久化。

基线与并发阶段逐轮确认复盘状态为 `completed` 且无错误；卸载阶段确认全部请求已中止、记录为 `interrupted`、活动复盘与合成流归零、存储单元全部关闭。`reviewOutcomes` 累计每轮结果，`finishedStreams`、`abortedRequests`、`activeAfterDispose` 显式报告清理结果。提供方错误、异常、缺失终止标记、超时和清理失败会拒绝测量，CLI 以退出码 1 和错误信息结束，不输出成功报告；正常退出码为 0。测试可向此离线工具注入合成流工厂，以验证失败和取消，不向生产运行时添加测试入口。

报告还包含请求数、并发数、存储写入数、序列化快照字节数、保留复盘记录数、卸载耗时和进程 heap/RSS 样本。`diskBytes: null` 表示未测量磁盘；序列化字节数不是磁盘占用。`sampledHighWater` 是采样最大值，不是连续测得的峰值。各阶段共享进程，垃圾回收不受控制；不要把数值直接用作硬性资源上限或生产容量承诺。

先在相同 Node 版本和机器上重复测量，再讨论预算。运行 `node --test tests/resource-characterization.test.mjs` 验证工具本身，包括历史重放预算、失败响应、异常流、缺失终止标记和超时。真实宿主的负载、长期运行、磁盘增长及真实模型延迟仍需独立测量。

---

# Synthetic resource characterization

Run `node scripts/characterize-resources.mjs` for a JSON report. No host, model credentials or network are required; it never reads user profiles or writes to disk. Options are `--sessions=8 --rounds=3 --evidenceChars=4096`, bounded to integers in 1–32, 1–20 and 1–16384 respectively.

The 2,000,000-unit budget covers **cumulative user evidence admitted to review requests across all phases, measured in UTF-16 code units**. Each turn appends E `x` characters, but review r replays all r turns. For S sessions and R rounds, the budget is `E * (1 + S * R * (R + 1) / 2 + S)`: baseline, concurrent history replay, then disposal. Defaults consume 233,472 units. `--sessions=32 --rounds=20 --evidenceChars=296` consumes 1,998,888; changing the length to 297 is rejected.

This is not a byte or token limit and excludes assistant text, JSON framing, tool definitions and system prompts. `totalReviewEvidenceUtf16Units` and each phase's `reviewEvidenceUtf16Units` expose this budget. `messageInputUtf16Units` separately sums `JSON.stringify(input.messages).length`, including message framing and assistant evidence passed to the provider, but excluding system prompts and tool definitions.

The phases cover a single-session baseline, concurrent sessions and disposal during active reviews. They exercise the actual plugin scheduler, review loop and storage call paths using synthetic sessions/provider and an in-memory storage backend. This measures runtime metadata retention, not model quality or real disk persistence.

Each baseline/concurrent round must finish with error-free `completed` records. Disposal must abort every request, leave `interrupted` records, drain active reviews and synthetic streams, and close all storage units. `reviewOutcomes` counts every round's outcome; `finishedStreams`, `abortedRequests` and `activeAfterDispose` expose cleanup. Provider errors, thrown or incomplete streams, timeouts and cleanup failures reject the measurement. The CLI exits 1 with an error and no successful report; successful runs exit 0. Tests inject synthetic stream factories only into this offline harness, without production runtime hooks.

Other metrics include requests, concurrency, storage writes, serialized snapshot bytes, retained review records, disposal latency and process heap/RSS samples. `diskBytes: null` means disk was not measured; serialized size is not disk usage. `sampledHighWater` is the maximum sampled value, not a continuous peak. Phases share a process with uncontrolled GC; these numbers are not hard resource limits or production capacity promises.

Repeat on the same Node version and machine before proposing budgets. Run `node --test tests/resource-characterization.test.mjs` to validate the harness, including replay budgets, provider errors, thrown/incomplete streams and timeouts. Real-host load, long-running soak, disk growth and real-provider latency still need separate measurement.
