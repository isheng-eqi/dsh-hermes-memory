# 合成记忆质量评估 v1

此语料把记忆内容质量与工具协议测试分开。五个完全虚构的场景覆盖明确纠正、第三方归属、引用中的指令注入、临时要求与持久偏好、定向删除。它不读取用户配置、凭据或真实会话，不调用模型，不产生费用，也不修改记忆。

## 使用

1. 向待测系统提供每个场景的 `initialMemory` 和 `evidence`，不要提供期望答案。保留案例和证据 ID。要求返回**新增或替换的事实**及其来源、要删除的原记忆 ID；不要把保留但未改变的记忆列为新事实。
2. 将系统输出保存为以下格式，包含全部场景，每个恰好一次：

```json
{"version":1,"cases":[{"id":"explicit-correction","facts":[{"text":"The user lives in Cedar Point.","evidenceIds":["u1"]}],"removedIds":["city-old"]}]}
```

上例仅演示一个场景，不是完整结果文件。运行：

```sh
node scripts/evaluate-memory-quality.mjs results.json
node --test tests/memory-quality.test.mjs
```

报告包含逐案例的正确事实、无依据事实、禁止事实、归属错误、缺失事实、错误删除和遗漏删除，以及事实精确率和召回率。没有预测时精确率为 `null`，不是 100%。退出码：0 全部符合、1 内容不符合、2 文件或结构无效。缺失、重复、未知场景和额外字段会被拒绝。删除不存在或不应删除的记忆也算错误。

这是**精确规范文本**评估，不是语义裁判：同义改写也可能算不匹配。外部运行器如做归一化，必须记录规则并保留原始输出，不能根据答案修正模型输出。语料公开且小，仅适合回归诊断，不足以证明泛化能力。不要将答案传给模型，也不要用本语料同时调参与宣称独立评估结果。

`memory-quality.test.mjs` 使用人工构造的答案测试评分器；通过这些测试**不代表任何模型通过质量评估**。真实评估应另行记录模型/提供商、参数、提示词版本、插件提交、日期、原始输出及重复运行结果。联网或收费评估是单独、显式选择的流程；本脚本只评分已有结果。当前没有已测模型分数或生产质量承诺。

---

# Synthetic memory quality evaluation v1

This corpus separates content quality from tool-protocol tests. Five entirely fictional cases cover explicit corrections, third-party attribution, instructions inside quotes, temporary requests versus durable preferences, and selective removal. It reads no user configuration, credentials or real sessions, calls no model, incurs no inference charges and changes no memory.

## Usage

Give the system under test each case's `initialMemory` and `evidence`, **not its expected answers**. Preserve case and evidence IDs. Collect newly added/replacement facts with evidence IDs and IDs of initial memories to remove; unchanged retained memories are not new facts. Save all cases exactly once using the JSON shape above, then run the commands above. The illustrated JSON contains only one case and is not a complete result file.

The report exposes per-case correct, unsupported, forbidden, misattributed and missing facts, incorrect/missing removals, and fact precision/recall. Precision is `null`, not 100%, when no facts are emitted. Exit codes: 0 all criteria satisfied, 1 content mismatch, 2 invalid input. Missing, duplicate or unknown cases and extra fields are rejected. Removing an unknown or protected memory is an error.

This is an **exact canonical-text oracle**, not a semantic judge: paraphrases may mismatch. If an external runner normalizes output, record its rules and preserve raw output; never repair predictions using the answers. This small public corpus is regression evidence, not proof of generalization or a held-out benchmark. Do not expose answers to the tested model or tune and claim independent evaluation on the same cases.

The tests use constructed answers to test the scorer; passing them **does not establish any model's quality**. A model evaluation should separately record provider/model, settings, prompt version, plugin commit, date, raw outputs and repeated-run results. Network/paid evaluation remains a separate explicit opt-in workflow; this script only scores existing outputs. No model score or production quality claim is supplied here.
