# 贡献指南

感谢你帮助改进 dsh-hermes-memory。本文提供可复现、易审查的贡献路径；不是对合并、发布时间或响应时间的承诺。项目主文档使用简体中文，并提供 [English README](README.en.md)。欢迎提供中文说明及英文翻译；现有英文问题和 PR 也已获得维护者回应。

## 从已有实践出发

以下依据是公开记录，不是从少量样本推导出的强制流程：

- [问题 #1](https://github.com/isheng-eqi/dsh-hermes-memory/issues/1)：具体环境、根因、最小补丁及验证结果帮助修复宿主依赖实例冲突。
- [问题 #2](https://github.com/isheng-eqi/dsh-hermes-memory/issues/2)：维护者分别说明当前集成的修复、静态/动态路径验证，以及未覆盖的历史版本和诊断建议。
- [PR #3](https://github.com/isheng-eqi/dsh-hermes-memory/pull/3) 和 [PR #4](https://github.com/isheng-eqi/dsh-hermes-memory/pull/4)：精确的过期行示例、回归测试和聚焦修复先行合并；面板与文档后续改进独立提交。维护者明确保留原贡献者的提交、署名和变更日志致谢。

因此，请优先提供可验证的行为、聚焦差异、回归测试和明确的验证范围。大的行为或存储格式变更，建议先在 issue 中讨论方案，避免无谓投入；这不是所有 PR 必须先开 issue 的要求。

## 本地开发与验证

需要符合 `package.json` 的 Node.js（`^22.19 || >=24`）及 npm。在独立工作副本中执行：

```sh
npm ci
npm test
git diff --check
```

`npm test` 先检查生成的 `host.js` 是否与源文件一致，再运行 `node --test tests/*.test.mjs`。修改共享运行时代码后，先执行 `npm run build:host` 并提交生成文件；不要直接编辑 `host.js`。生成器见 [scripts/build-host.mjs](scripts/build-host.mjs)。根目录 `client.js` 是单独的动态客户端，不是该生成器的输出；客户端变更应检查它与 `lib/client.js` 是否都受影响，而不是机械复制。

部分真实宿主集成测试默认跳过。已有构建完成的 DSH 源码副本时，可运行：

```sh
DSH_CLIENT_TEST_CHECKOUT=/absolute/path/to/built/dsh npm test
```

报告通过、失败和跳过的数量，以及 Node/DSH 版本或提交。没有该宿主时，明确说明缺口，不把跳过当作兼容性已验证。发布包内容变更可用 `npm pack --dry-run --ignore-scripts` 检查；该命令不替代构建或测试。常规验证不需要运行 `scripts/live-review-smoke.mjs`：它可读取配置并调用真实模型；只有明确授权后才使用隔离配置进行这类验证。

## 代码与文档

- 延续附近代码的 ESM、两空格缩进、单引号和无分号风格；仓库目前没有单独的 lint/format 脚本，不要顺便全仓格式化。
- 核心操作在 `lib/core.js`，宿主集成在 `lib/index.js`，后台复盘在 `lib/review.js`、`lib/prompts.js` 和 `lib/scheduler.js`。`tests/host-fixture.mjs` 提供合成宿主夹具。按改动选取相关测试，并运行完整 `npm test`。
- 宿主核心包当前是可选 peer dependencies，并在开发依赖中固定测试版本。不要无意改回普通运行时依赖；重复实例曾导致调度器故障（#1）。
- 变更用户可见行为时，同步 `README.md`、`README.en.md` 和适用的 `locale/` 文案。需要时补充 `CHANGELOG.md`，不要自行发布版本。
- `design.md` 和带日期的报告包含历史设计；当前契约应与实现、测试及当前 README 交叉核对，不能把历史方案当作现行 API。
- 使用合成会话和临时存储。不要提交真实记忆、会话、密钥、个人配置或未脱敏日志；不要用真实用户数据验证迁移、删除或清理。

## 提交 issue / PR

问题报告请包含：插件和宿主版本、操作系统、最小复现、预期/实际结果、脱敏错误信息，以及已验证与尚未验证的范围。能提供失败回归测试更好。

PR 请说明问题及理由、关联 issue（如有）、变更范围、测试命令和结果，以及兼容性/迁移/模型调用方面的影响。尽量一项独立问题一个 PR，避免混入重构。现有提交常用 `fix:` / `fix(memory):` 等简洁前缀，可沿用，但这不是强制提交检查。修复的 source 已合并不等于 npm 已发布。

保留他人的署名和贡献来源。若使用 AI 协助，请说明协助方式与负责审查的人，认真复核补丁和测试，不让生成内容替代证据。例如：

> 本贡献在 Magnus Hedemark 的指导下，由 Codex 协助完成。

这是一项透明度建议，不代表项目此前已有强制 AI 政策。不要声称维护者已批准尚未审阅的规则或变更。代理另请阅读 [AGENTS.md](AGENTS.md)。

---

# Contributing

Thank you for helping improve dsh-hermes-memory. This guide offers a reproducible, reviewable contribution path, not a promise of merging, releases or response times. The primary documentation uses Simplified Chinese and provides an [English README](README.en.md). Chinese explanations with English translations are welcome; existing English issues and PRs have also received maintainer responses.

## Grounded in existing practice

These are public observations, not mandatory process inferred from a small sample:

- [Issue #1](https://github.com/isheng-eqi/dsh-hermes-memory/issues/1): a concrete environment, root cause, minimal patch and verification helped resolve conflicting host dependency instances.
- [Issue #2](https://github.com/isheng-eqi/dsh-hermes-memory/issues/2): the maintainer distinguished the current integration fix, static/dynamic verification, and historical versions and diagnostic suggestions not covered.
- [PR #3](https://github.com/isheng-eqi/dsh-hermes-memory/pull/3) and [PR #4](https://github.com/isheng-eqi/dsh-hermes-memory/pull/4): a precise stale-row example, regression tests and focused fix were merged first; panel and documentation follow-ups were separate. The maintainer explicitly preserved the contributor's commit, authorship and changelog credit.

Prioritize verifiable behavior, focused diffs, regression tests and explicit verification scope. For large behavior or storage-format changes, discussing the proposal in an issue first can avoid wasted effort; this is not a requirement to open an issue before every PR.

## Local development and verification

Use Node.js matching `package.json` (`^22.19 || >=24`) and npm. In an isolated working copy:

```sh
npm ci
npm test
git diff --check
```

`npm test` checks that generated `host.js` matches its sources, then runs `node --test tests/*.test.mjs`. After shared runtime changes, run `npm run build:host` and commit the generated file; do not edit `host.js` directly. See [scripts/build-host.mjs](scripts/build-host.mjs). Root `client.js` is a separate dynamic client, not output of that generator; check whether client changes affect both it and `lib/client.js` rather than copying mechanically.

Some real-host integration tests skip by default. With an existing built DSH source checkout:

```sh
DSH_CLIENT_TEST_CHECKOUT=/absolute/path/to/built/dsh npm test
```

Report passed, failed and skipped counts and Node/DSH versions or commits. If the host is unavailable, state that gap; skipped tests do not prove compatibility. Package-content changes can be inspected with `npm pack --dry-run --ignore-scripts`; this does not replace builds or tests. Routine verification does not require `scripts/live-review-smoke.mjs`: it can read configuration and call a real model. Use isolated configuration for such verification only with explicit authorization.

## Code and documentation

- Follow surrounding ESM, two-space indentation, single-quote and no-semicolon style. There is currently no separate lint/format script; avoid unrelated repository-wide formatting.
- Core operations live in `lib/core.js`, host integration in `lib/index.js`, and background review in `lib/review.js`, `lib/prompts.js` and `lib/scheduler.js`. `tests/host-fixture.mjs` supplies synthetic host fixtures. Select relevant tests and also run the full `npm test` suite.
- Host core packages are currently optional peer dependencies, with pinned development versions for testing. Do not accidentally convert them to regular runtime dependencies: duplicate instances previously broke dispatch (#1).
- For user-visible behavior changes, keep `README.md`, `README.en.md` and relevant `locale/` text aligned. Update `CHANGELOG.md` when appropriate; do not independently publish a release.
- `design.md` and dated reports contain historical designs. Cross-check current contracts against implementation, tests and current READMEs rather than treating historical proposals as current APIs.
- Use synthetic sessions and temporary stores. Do not commit real memories, sessions, secrets, personal configuration or unsanitized logs; do not validate migrations, deletions or pruning on real user data.

## Issues and pull requests

Include plugin and host versions, OS, minimal reproduction, expected/actual behavior, sanitized errors, and what is and is not verified. A failing regression test is useful.

Explain the problem and rationale, linked issue if any, scope, test commands/results, and compatibility, migration or model-call implications. Prefer one independent problem per PR without unrelated refactoring. Existing commits often use concise prefixes such as `fix:` / `fix(memory):`; these are useful examples, not an enforced commit check. Merged source does not mean an npm release has shipped.

Preserve others' authorship and contribution provenance. If AI assisted, explain its role and the human responsible for review, and verify the patch and tests rather than substituting generated text for evidence. For example:

> This contribution was made with Codex assistance under Magnus Hedemark’s direction.

This is a transparency recommendation, not a claim that the project previously had a mandatory AI policy. Do not claim maintainer approval of unreviewed rules or changes. Agents should also read [AGENTS.md](AGENTS.md).
