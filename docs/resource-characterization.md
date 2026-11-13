# 合成资源特征测量

运行 `node scripts/characterize-resources.mjs` 可获得 JSON 报告。无需宿主、模型凭据或网络；不会读取用户配置或写入磁盘。可调整 `--sessions=8 --rounds=3 --evidenceChars=4096`，参数有上限，输入字符总数不得超过 2,000,000。

三个阶段分别测量单会话基线、多会话并发与复盘运行中卸载。使用真实插件的调度器、复盘循环和存储调用路径，但会话、模型和内存存储后端均为合成替身。它测量运行时元数据保留，不评估真实模型质量或磁盘持久化。

报告包含请求数、并发数、存储写入数、序列化快照字节数、保留复盘记录数、卸载耗时和进程 heap/RSS 样本。`diskBytes: null` 表示未测量磁盘；序列化字节数不是磁盘占用。`sampledHighWater` 是采样最大值，不是连续测得的峰值。各阶段共享进程，垃圾回收不受控制；不要把数值直接用作硬性资源上限或生产容量承诺。

先在相同 Node 版本和机器上重复测量，再讨论预算。运行 `node --test tests/resource-characterization.test.mjs` 验证工具本身。真实宿主的负载、长期运行、磁盘增长及真实模型延迟仍需独立测量。

---

# Synthetic resource characterization

Run `node scripts/characterize-resources.mjs` for a JSON report. No host, model credentials or network are required; it never reads user profiles or writes to disk. Options are `--sessions=8 --rounds=3 --evidenceChars=4096`, with bounded parameters and at most 2,000,000 input characters.

The phases cover a single-session baseline, concurrent sessions and disposal during active reviews. They exercise the actual plugin scheduler, review loop and storage call paths using synthetic sessions/provider and an in-memory storage backend. This measures runtime metadata retention, not model quality or real disk persistence.

Metrics include requests, concurrency, storage writes, serialized snapshot bytes, retained review records, disposal latency and process heap/RSS samples. `diskBytes: null` means disk was not measured; serialized size is not disk usage. `sampledHighWater` is the maximum sampled value, not a continuous peak. Phases share a process with uncontrolled GC; these numbers are not hard resource limits or production capacity promises.

Repeat on the same Node version and machine before proposing budgets. Run `node --test tests/resource-characterization.test.mjs` to validate the harness. Real-host load, long-running soak, disk growth and real-provider latency still need separate measurement.
