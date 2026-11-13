# 固定宿主的发布验证

普通 `npm test` 仍允许没有 DSH 源码的开发环境；它会跳过真实宿主测试，不能证明完整发布验证已通过。

发布前运行 `node scripts/testing/host-release-check.mjs`。设置 `DSH_CLIENT_TEST_CHECKOUT` 为已构建的 DSH checkout。基线存放于 `scripts/testing/host-baseline.json`：DSH **0.2.2-alpha.2**，完整提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，对应现有 2.0.0 实现报告中的宿主版本。脚本要求该提交、未修改的跟踪文件、构建产物，以及全部测试通过且零跳过/取消/todo。缺少宿主或构建产物会失败，不会静默退回单元测试。

CI 在 Node 22.19.0/24.21.0 运行普通测试；单独的 Node 24.21.0 作业使用固定宿主和 frozen lockfile 构建并执行严格检查，适用于 PR、main、版本标签和手动运行。完整构建命令见 `.github/workflows/verification.yml`。它不读取用户 DSH profile 或凭据，不调用付费模型。首次外部贡献的工作流可能需要维护者批准运行。将 `pinned-host` 设为必需检查、把它接入实际发布审批，仍由维护者的仓库规则决定；该 PR 不更改权限或发布设置。

更新基线时，请在独立提交中修改完整 SHA 和版本，重新验证全部真实宿主测试，而不是为了通过检查而删除测试或接受跳过。该基线是一项可复现的兼容性检查，并不保证所有 peer dependency 范围内的宿主都兼容。构建产物的来源仍依赖从干净 checkout 按工作流重新构建，脚本不会把磁盘上的任意旧构建视为可证明的来源。

---

# Pinned-host release verification

Ordinary `npm test` remains usable without DSH sources; skipped real-host tests are not complete release evidence.

Before release run `node scripts/testing/host-release-check.mjs`, setting `DSH_CLIENT_TEST_CHECKOUT` to a built checkout. `scripts/testing/host-baseline.json` pins DSH **0.2.2-alpha.2**, full commit `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`, the host version recorded in the existing 2.0.0 implementation report. The gate requires that revision, clean tracked sources, built artifacts, and all tests passing with zero skips/cancellations/todos. Missing prerequisites fail rather than silently falling back to unit-only verification.

CI runs ordinary tests on Node 22.19.0/24.21.0 and a separate Node 24.21.0 pinned-host job using frozen dependency installation, on PRs, main, version tags and manual invocation. See `.github/workflows/verification.yml` for the complete build commands. No user profile, credentials or paid inference are used. First-time contributor workflows may need maintainer approval. Making `pinned-host` a required check and enforcing it before actual publication remains a maintainer repository-policy decision; this change does not alter permissions or publishing settings.

Update the full SHA/version in a dedicated baseline change and rerun all real-host tests, never delete tests or permit skips to make the gate pass. This is a reproducible compatibility baseline, not proof for every supported peer-dependency version. Artifact provenance relies on rebuilding a clean checkout using the workflow; local revision checks alone cannot certify arbitrary preexisting build outputs.
